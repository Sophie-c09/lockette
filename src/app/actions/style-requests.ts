"use server";

// User-facing side of the Personal Style Request feature: submitting
// inspiration, viewing your own requests/completed bundles, and adding a
// completed bundle to your cart. Admin curation lives in
// src/lib/styleRequestAdmin.ts.
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { addListingToCart } from "@/app/actions/cart";
import {
  isAllowedListingPhotoType,
  LISTING_PHOTO_MIME_EXTENSIONS,
  MAX_LISTING_PHOTOS,
  MAX_STYLE_REQUEST_PHOTO_BYTES,
} from "@/lib/listing-photo";
import {
  STYLE_REQUEST_IMAGES_BUCKET,
  styleRequestImagesFolder,
  getSignedStyleRequestImageUrls,
} from "@/lib/style-request-photo";
import { SELECTED_CATEGORY_OPTIONS, type SelectedCategory } from "@/lib/selected-categories";
import { searchMarketplaceItems } from "@/lib/marketplace-search";
import { rankBySimilarity } from "@/lib/garment-similarity-ranking";
import { categorizeListing } from "@/lib/bulk-import";
import { calculateBundlePricing } from "@/lib/bundle-pricing";
import { createGeneratingBundle, runBundleGenerationAsync } from "@/lib/bundle-generation";
import type { DetectedGarment, GarmentCategory } from "@/lib/garment-detection";
import type { ExtractedListing } from "@/lib/extraction/normalize-listing";
import type { Listing } from "@/lib/supabase/listings.types";

const VALID_CATEGORIES = SELECTED_CATEGORY_OPTIONS.map((option) => option.value);

const SubmitStyleRequestSchema = z.object({
  inspoText: z.string().trim().max(2000).optional(),
  budget: z.coerce.number().positive().optional(),
  categories: z.array(z.enum(VALID_CATEGORIES as [SelectedCategory, ...SelectedCategory[]])).default([]),
});

export type SubmitStyleRequestState =
  | {
      error?: string;
      requestId?: string;
    }
  | undefined;

/**
 * Submits a style request AND immediately attempts to build its bundle —
 * admin review is no longer required to get a bundle (src/lib/styleRequestAdmin.ts's
 * previewAIBundle/confirmAIBundle still exist for manual curation/
 * override, they're just optional now, not the only path). Two-phase
 * insert/upload/patch, mirroring createListing (src/app/actions/listings.ts):
 * insert the row first (status: 'pending') to get a real id, upload each
 * inspo photo to `style-request-images/${user.id}/${requestId}/${i}.${ext}`,
 * patch `inspo_images` with the resulting storage PATHS (not public URLs
 * — the bucket is private), compensating-delete on failure. Unlike a listing's
 * photos, inspo photos are optional — a request can be text/budget/
 * categories only.
 */
export async function submitStyleRequest(
  _prevState: SubmitStyleRequestState,
  formData: FormData,
): Promise<SubmitStyleRequestState> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { error: "You must be signed in to submit a style request." };
  }

  const validatedFields = SubmitStyleRequestSchema.safeParse({
    inspoText: formData.get("inspoText") ?? undefined,
    budget: formData.get("budget") || undefined,
    categories: formData.getAll("categories"),
  });

  if (!validatedFields.success) {
    return { error: validatedFields.error.issues[0]?.message ?? "Please check your request details." };
  }

  const { inspoText, budget, categories } = validatedFields.data;

  const photos = formData.getAll("images").filter((entry): entry is File => entry instanceof File && entry.size > 0);

  if (photos.length > MAX_LISTING_PHOTOS) {
    return { error: `You can upload up to ${MAX_LISTING_PHOTOS} photos.` };
  }
  for (const photo of photos) {
    if (!isAllowedListingPhotoType(photo.type)) {
      return { error: "Photos must be JPEG, PNG, WebP, or GIF." };
    }
    if (photo.size > MAX_STYLE_REQUEST_PHOTO_BYTES) {
      return { error: "Each image must be under 10MB" };
    }
  }

  const { data: request, error: insertError } = await supabase
    .from("style_requests")
    .insert({
      user_id: user.id,
      inspo_text: inspoText || null,
      inspo_images: [],
      budget: budget ?? null,
      categories,
      status: "pending",
    })
    .select("id")
    .single();

  if (insertError || !request) {
    return { error: insertError?.message ?? "Couldn't submit your request. Please try again." };
  }

  const inspoImagePaths: string[] = [];

  for (let i = 0; i < photos.length; i++) {
    const photo = photos[i];
    const extension = LISTING_PHOTO_MIME_EXTENSIONS[photo.type];
    const path = `${styleRequestImagesFolder(user.id, request.id)}/${i}.${extension}`;

    const { error: uploadError } = await supabase.storage
      .from(STYLE_REQUEST_IMAGES_BUCKET)
      .upload(path, photo, { contentType: photo.type });

    if (uploadError) {
      await cleanupFailedStyleRequest(supabase, user.id, request.id);
      return { error: `Could not upload photo ${i + 1}: ${uploadError.message}` };
    }

    inspoImagePaths.push(path);
  }

  // createAdminClient(), not the request-scoped `supabase` — style_requests
  // has SELECT and INSERT RLS policies but no UPDATE policy (supabase/schema.sql),
  // so this patch was previously being silently filtered to 0 rows affected
  // under RLS (no error returned), leaving inspo_images stuck at the initial
  // insert's `[]` even though inspoImagePaths itself was correct.
  const { error: patchError } = await createAdminClient()
    .from("style_requests")
    .update({ inspo_images: inspoImagePaths })
    .eq("id", request.id)
    .eq("user_id", user.id);

  if (patchError) {
    await cleanupFailedStyleRequest(supabase, user.id, request.id);
    return { error: "Could not save your photos. Please try again." };
  }

  revalidatePath("/my-style-requests");

  // Bundle generation needs a real inspiration photo to run vision
  // analysis on — StyleRequestForm.tsx already blocks submission without
  // one, but this is the server-side backstop for that same rule (a
  // request bypassing client validation, JS disabled, etc.) so an empty
  // upload can never silently fall through to the "still being
  // reviewed" state below instead of a clear error.
  if (inspoImagePaths.length === 0) {
    throw new Error("At least one inspiration image is required");
  }

  // Async generation — this is what makes admin review OPTIONAL rather
  // than required, and what lets the user land on their bundle page
  // immediately instead of waiting through the full pipeline first (see
  // src/lib/bundle-generation.ts's own header comment on the async
  // section for exactly how/why). createGeneratingBundle is awaited (it's
  // just one fast insert); runBundleGenerationAsync is deliberately NOT
  // awaited — it keeps running after this function redirects, writing
  // items into the bundle progressively as they're found.
  const generating = await createGeneratingBundle(request.id);

  if (generating.bundleId) {
    const bundleId = generating.bundleId;

    runBundleGenerationAsync(request.id, bundleId, user.id).catch((error) => {
      console.error(
        "[style-requests] Async bundle generation threw unexpectedly:",
        error
      );
    });

    // Outside any try/catch on purpose — redirect() throws a special
    // internal Next.js signal, same reasoning as
    // src/app/actions/outfit-recreations.ts's submitOutfitRecreation.
    redirect(`/bundle/${bundleId}`);
  }

  // Only reachable now if createGeneratingBundle itself failed for a
  // reason OTHER than a missing photo (e.g. a transient DB error) — a
  // real inspiration image is guaranteed present at this point.
  return { requestId: request.id };
}

// Compensating cleanup for submitStyleRequest's two-phase insert/upload/
// patch — same reasoning as listings.ts's cleanupFailedListing.
async function cleanupFailedStyleRequest(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- matches createClient's own generic default (see src/lib/supabase/server.ts)
  supabase: Awaited<ReturnType<typeof createClient<any>>>,
  userId: string,
  requestId: string,
): Promise<void> {
  const folder = styleRequestImagesFolder(userId, requestId);
  const { data: files } = await supabase.storage.from(STYLE_REQUEST_IMAGES_BUCKET).list(folder);
  if (files && files.length > 0) {
    await supabase.storage.from(STYLE_REQUEST_IMAGES_BUCKET).remove(files.map((file) => `${folder}/${file.name}`));
  }
  await supabase.from("style_requests").delete().eq("id", requestId).eq("user_id", userId);
}

export interface MyStyleRequestBundleItem {
  bundleItemId: string;
  listing: Listing;
  position: number;
  category: string | null;
  replacementGroup: string | null;
}

export type BundleStatus = "draft" | "generating" | "error" | "ready" | "purchased";

export interface MyStyleRequestBundle {
  id: string;
  title: string;
  description: string | null;
  items: MyStyleRequestBundleItem[];
  // AI-Powered Outfit Creation fields (supabase/schema.sql) — all
  // nullable, since a bundle created by the original manual admin-curation
  // flow (src/lib/styleRequestAdmin.ts) never populates them. The UI
  // (BundleCard, src/components/style-request/MyStyleRequestsView.tsx)
  // falls back to its original, simpler rendering whenever these are
  // null, so an old bundle keeps looking exactly as it already did.
  previewImage: string | null;
  itemSubtotal: number | null;
  mavelleFee: number | null;
  totalPrice: number | null;
  estimatedDeliveryStart: string | null;
  estimatedDeliveryEnd: string | null;
  // Manual bundles (createBundleForRequest) always insert with the
  // column's own default ('ready') — only the async generation path
  // (src/lib/bundle-generation.ts's createGeneratingBundle/
  // runBundleGenerationAsync) ever writes 'generating' or 'error', which
  // is what src/components/style-request/BundleOutfitView.tsx actually
  // keys its skeleton/polling/error UI off of.
  status: BundleStatus;
  generationError: string | null;
  // Finer-grained progress within status = 'generating' — see
  // src/lib/bundle-generation.ts's runBundleGenerationAsync for the exact
  // step values it writes (starting/analyzing_inspiration/searching_items/
  // ranking_matches/building_preview/complete) and
  // BundleOutfitView.tsx's GENERATION_STEP_LABELS for how each is shown.
  generationStep: string | null;
  generationProgress: number;
}

export interface MyStyleRequest {
  id: string;
  inspoText: string | null;
  inspoImageUrls: string[];
  budget: number | null;
  categories: string[];
  status: "pending" | "in_progress" | "completed";
  createdAt: string;
  bundle: MyStyleRequestBundle | null;
}

const BUNDLE_COLUMNS =
  "id, title, description, preview_image, item_subtotal, mavelle_fee, total_price, estimated_delivery_start, estimated_delivery_end, status, generation_error, generation_step, generation_progress";

interface BundleRow {
  id: string;
  title: string;
  description: string | null;
  preview_image: string | null;
  item_subtotal: number | null;
  mavelle_fee: number | null;
  total_price: number | null;
  estimated_delivery_start: string | null;
  estimated_delivery_end: string | null;
  status: BundleStatus;
  generation_error: string | null;
  generation_step: string | null;
  generation_progress: number | null;
}

// Shared by getMyStyleRequests (below) and getBundleById (the /bundle/[id]
// page this feature added) — one implementation of "given a
// styled_bundles row, fetch and shape its items" rather than two drifting
// copies.
async function loadBundleItems(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- matches createClient's own generic default (see src/lib/supabase/server.ts)
  supabase: Awaited<ReturnType<typeof createClient<any>>>,
  bundleRow: BundleRow,
): Promise<MyStyleRequestBundle> {
  const { data: itemRows } = await supabase
    .from("styled_bundle_items")
    .select("id, position, category, replacement_group, listing_id, listings(*)")
    .eq("bundle_id", bundleRow.id)
    .order("position", { ascending: true });

  const items: MyStyleRequestBundleItem[] = (itemRows ?? [])
    .filter((item) => item.listings)
    .map((item) => ({
      bundleItemId: item.id,
      listing: item.listings as unknown as Listing,
      position: item.position ?? 0,
      category: item.category,
      replacementGroup: item.replacement_group,
    }));

  return {
    id: bundleRow.id,
    title: bundleRow.title,
    description: bundleRow.description,
    items,
    previewImage: bundleRow.preview_image,
    itemSubtotal: bundleRow.item_subtotal,
    mavelleFee: bundleRow.mavelle_fee,
    totalPrice: bundleRow.total_price,
    estimatedDeliveryStart: bundleRow.estimated_delivery_start,
    estimatedDeliveryEnd: bundleRow.estimated_delivery_end,
    status: bundleRow.status,
    generationError: bundleRow.generation_error,
    generationStep: bundleRow.generation_step,
    generationProgress: bundleRow.generation_progress ?? 0,
  };
}

/** For /my-style-requests — the caller's own requests, newest first. */
export async function getMyStyleRequests(): Promise<{ requests: MyStyleRequest[]; error?: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { requests: [] };
  }

  const { data: requestRows, error } = await supabase
    .from("style_requests")
    .select("id, inspo_text, inspo_images, budget, categories, status, created_at")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false });

  if (error) {
    return { requests: [], error: error.message };
  }

  const requests: MyStyleRequest[] = [];

  for (const row of requestRows ?? []) {
    const inspoImageUrls = await getSignedStyleRequestImageUrls(supabase, row.inspo_images ?? []);

    let bundle: MyStyleRequestBundle | null = null;

    if (row.status === "completed") {
      const { data: bundleRow } = await supabase
        .from("styled_bundles")
        .select(BUNDLE_COLUMNS)
        .eq("request_id", row.id)
        .maybeSingle();

      if (bundleRow) {
        bundle = await loadBundleItems(supabase, bundleRow);
      }
    }

    requests.push({
      id: row.id,
      inspoText: row.inspo_text,
      inspoImageUrls,
      budget: row.budget,
      categories: row.categories ?? [],
      status: row.status,
      createdAt: row.created_at,
      bundle,
    });
  }

  return { requests };
}

/**
 * For /bundle/[id] — the page a user now lands on immediately after
 * submitting a style request (see submitStyleRequest's own redirect
 * above). Ownership is checked through the bundle's own request row
 * (styled_bundles.request_id -> style_requests.user_id), same chain
 * RLS's own SELECT policy already walks (supabase/schema.sql).
 */
export async function getBundleById(bundleId: string): Promise<{ bundle?: MyStyleRequestBundle; error?: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { error: "You must be signed in." };
  }

  const { data: bundleRow, error } = await supabase
    .from("styled_bundles")
    .select(`${BUNDLE_COLUMNS}, style_requests(user_id)`)
    .eq("id", bundleId)
    .maybeSingle();

  if (error || !bundleRow) {
    return { error: "Bundle not found." };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- nested PostgREST join shape, not worth a bespoke generated type for one ownership check
  const ownerUserId = (bundleRow as any).style_requests?.user_id;
  if (ownerUserId !== user.id) {
    return { error: "You don't have access to this bundle." };
  }

  const bundle = await loadBundleItems(supabase, bundleRow);
  return { bundle };
}

/**
 * "Add All to Cart" for a completed bundle — there's no separate
 * bundle-aware cart mechanism in this app (confirmed: `cart_items` has no
 * grouping column), so this just calls the existing single-item
 * `addListingToCart` once per item in the bundle, same as any other add.
 */
export async function addBundleToCart(bundleId: string): Promise<{ added: number; error?: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { added: 0, error: "You must be signed in to add items to your cart." };
  }

  const { data: itemRows, error } = await supabase
    .from("styled_bundle_items")
    .select("listing_id")
    .eq("bundle_id", bundleId);

  if (error) {
    return { added: 0, error: error.message };
  }

  const listingIds = (itemRows ?? [])
    .map((row) => row.listing_id)
    .filter((id): id is string => Boolean(id));

  let added = 0;
  for (const listingId of listingIds) {
    const result = await addListingToCart(listingId);
    if (!result.error) added += 1;
  }

  revalidatePath("/cart");

  return { added };
}

const FULL_LISTING_COLUMNS =
  "id, title, description, price, image_url, product_url, platform, brand, category, size, color, aesthetic_tags, image_embedding, created_at";

// listings.category is a raw, inconsistent source string (see
// bulk-import.ts's own header comment on why categorizeListing exists at
// all) — reused here as a fallback for a bundle item created before
// styled_bundle_items.category existed (that column is null on any
// bundle from the original manual admin-curation flow), so swapping
// still works on an old bundle, not just ones the new AI generation path
// created.
function inferCategory(listing: Pick<Listing, "title" | "category">): GarmentCategory | null {
  const bucket = categorizeListing({ title: listing.title, category: listing.category ?? null } as ExtractedListing);
  return bucket === "other" ? null : bucket;
}

// Builds the minimal, honest DetectedGarment rankBySimilarity needs from
// whatever this CURRENT listing's own row actually has — no fabricated
// pattern/material/era/silhouette detail the listings table doesn't
// store; the point of a swap is "stay compatible with what's already
// there," not re-running AI analysis on it.
function currentItemAsDetectedGarment(listing: Listing, category: GarmentCategory): DetectedGarment {
  return {
    category,
    garmentType: listing.category ?? listing.title,
    description: listing.title,
    color: listing.color ?? "unknown",
    pattern: null,
    material: null,
    silhouette: "regular fit",
    era: null,
    visualDetails: null,
    searchQueries: [],
  };
}

export interface ReplacementOption {
  listing: Listing;
}

/**
 * "Replace jeans" (Part 5) — finds similar alternatives for one bundle
 * item, reusing marketplace-search.ts (the search) and
 * garment-similarity-ranking.ts's rankBySimilarity (the ranking) exactly
 * as Recreate This Look already does; no separate matching logic. Ranks
 * against the CURRENT item's own category/color/title, so a replacement
 * preserves category/style/color compatibility rather than drifting to
 * something unrelated.
 */
export async function getReplacementOptions(
  bundleItemId: string,
): Promise<{ current?: Listing; options: ReplacementOption[]; error?: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { options: [], error: "You must be signed in." };
  }

  const { data: itemRow, error: itemError } = await supabase
    .from("styled_bundle_items")
    .select("id, category, bundle_id, listings(*), styled_bundles(request_id, style_requests(user_id))")
    .eq("id", bundleItemId)
    .maybeSingle();

  if (itemError || !itemRow) {
    return { options: [], error: "Bundle item not found." };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- nested PostgREST join shape, not worth a bespoke generated type for one ownership check
  const ownerUserId = (itemRow as any).styled_bundles?.style_requests?.user_id;
  if (ownerUserId !== user.id) {
    return { options: [], error: "You don't have access to this bundle." };
  }

  const currentListing = itemRow.listings as unknown as Listing;
  if (!currentListing) {
    return { options: [], error: "This item's listing could not be found." };
  }

  const category = (itemRow.category as GarmentCategory | null) ?? inferCategory(currentListing);
  if (!category) {
    return { options: [], error: "Couldn't determine this item's category." };
  }

  const results = await searchMarketplaceItems({
    category,
    description: [currentListing.title, currentListing.description, currentListing.brand].filter(Boolean).join(" "),
    color: currentListing.color ?? "",
    style: (currentListing.aesthetic_tags ?? []).join(" "),
    priceLimit: null,
  });

  const rewornIds = results
    .filter((result) => result.platform === "reworn" && result.id !== currentListing.id)
    .map((result) => result.id);

  if (rewornIds.length === 0) {
    return { current: currentListing, options: [] };
  }

  const { data: fullListings } = await supabase.from("listings").select(FULL_LISTING_COLUMNS).in("id", rewornIds);
  const candidates = (fullListings ?? []) as Listing[];

  const ranked = rankBySimilarity(
    currentItemAsDetectedGarment(currentListing, category),
    (currentListing.aesthetic_tags ?? []).join(" "),
    candidates.map((listing) => ({
      listing,
      category,
      searchableText: [listing.title, listing.description, listing.color, listing.brand].filter(Boolean).join(" "),
    })),
  );

  return {
    current: currentListing,
    options: ranked.slice(0, 6).map(({ listing }) => ({ listing })),
  };
}

/**
 * Swaps one bundle item's listing and recomputes the bundle's pricing
 * (src/lib/bundle-pricing.ts — same calculation used at generation time,
 * not a separate formula) to reflect the new item's price. Preview
 * layout/delivery estimate are intentionally left as-is — a single-item
 * swap changing the whole collage/shipping estimate would be a bigger
 * behavior change than "replace this item" implies; regenerating those
 * is a reasonable future addition, not done here.
 */
export async function replaceBundleItem(
  bundleItemId: string,
  newListingId: string,
): Promise<{ error?: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { error: "You must be signed in." };
  }

  const { data: itemRow, error: itemError } = await supabase
    .from("styled_bundle_items")
    .select("id, bundle_id, styled_bundles(id, style_requests(user_id))")
    .eq("id", bundleItemId)
    .maybeSingle();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- nested PostgREST join shape, not worth a bespoke generated type for one ownership check
  const ownerUserId = (itemRow as any)?.styled_bundles?.style_requests?.user_id;
  if (itemError || !itemRow || ownerUserId !== user.id) {
    return { error: "Bundle item not found." };
  }

  const adminSupabase = createAdminClient();

  const { error: updateError } = await adminSupabase
    .from("styled_bundle_items")
    .update({ listing_id: newListingId })
    .eq("id", bundleItemId);

  if (updateError) {
    return { error: updateError.message };
  }

  const { data: allItems } = await adminSupabase
    .from("styled_bundle_items")
    .select("listings(price)")
    .eq("bundle_id", itemRow.bundle_id);

  const prices = (allItems ?? [])
    .map((row) => (row.listings as unknown as { price: number | null } | null)?.price ?? 0);
  const pricing = calculateBundlePricing(prices);

  await adminSupabase
    .from("styled_bundles")
    .update({
      item_subtotal: pricing.itemSubtotal,
      mavelle_fee: pricing.mavelleFee,
      total_price: pricing.totalPrice,
    })
    .eq("id", itemRow.bundle_id);

  revalidatePath("/my-style-requests");

  return {};
}
