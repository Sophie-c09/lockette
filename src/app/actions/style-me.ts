"use server";

// Style Me — a user submits several inspiration photos + optional text +
// a budget; the whole pipeline (aggregate-classify -> generate bundle ->
// insert) runs synchronously in one Server Action, same as Recreate This
// Outfit. What's different: the generated bundle is deliberately hidden
// from the user until their request's status reaches 'delivered' — a
// scripted reveal-pacing device (src/lib/style-me-status.ts), not any real
// fulfillment (this app has no real shipping/delivery concept anywhere).
//
// The photos themselves are uploaded client-side, directly to Supabase
// Storage, BEFORE this action is ever called (see StyleMeForm.tsx's own
// comment) — this action only ever receives the resulting Storage paths
// (short strings), never raw file bytes. A native <form action=...>
// submission carrying up to MAX_LISTING_PHOTOS real image files made
// Next.js's default 1MB Server Action body limit trivial to exceed
// ("Body exceeded 1 MB limit"); this keeps the action's payload down to a
// handful of short strings regardless of how large the actual photos are.
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { addListingToCart } from "@/app/actions/cart";
import { MAX_LISTING_PHOTOS } from "@/lib/listing-photo";
import {
  STYLE_ME_IMAGES_BUCKET,
  styleMeImagesFolder,
  getSignedStyleMeImageUrls,
} from "@/lib/style-me-photo";
import { classifyStyleAggregate } from "@/lib/style-me-classification";
import { verifyUploadedImage } from "@/lib/image-content-verification";
import { fetchGarmentCandidates } from "@/lib/garment-matching";
import { nearestBudgetOption } from "@/lib/budget-options";
import { advanceStatusIfDue, type StyleMeStatus } from "@/lib/style-me-status";
import type { Listing } from "@/lib/supabase/listings.types";

const MAX_BUNDLE_ITEMS = 5;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SubmitStyleMeSchema = z.object({
  inspoText: z.string().trim().max(2000).optional(),
  budget: z.coerce.number().positive({ error: "Budget must be greater than $0." }),
});

export type SubmitStyleMeState =
  | {
      error?: string;
    }
  | undefined;

/**
 * P0 launch-readiness fix — this used to have no top-level try/catch at
 * all, unlike its Recreate This Outfit sibling (outfit-recreations.ts's
 * submitOutfitRecreation); an unexpected exception anywhere in the ~160
 * lines of work below (a classification call, a Supabase write, the
 * matching loop) would propagate uncaught straight to the framework,
 * hitting a raw error page instead of this app's own graceful message.
 * `redirect()` is called AFTER (outside) the try/catch, on purpose — same
 * reasoning as submitOutfitRecreation's own comment: Next.js implements
 * redirect() by throwing a special internal signal, and a try/catch that
 * wrapped it would catch that throw too and misreport a successful
 * redirect as a failure.
 */
export async function submitStyleMeRequest(
  _prevState: SubmitStyleMeState,
  formData: FormData,
): Promise<SubmitStyleMeState> {
  let redirectRequestId: string;

  try {
    redirectRequestId = await submitStyleMeRequestInner(formData);
  } catch (error) {
    console.error("[style-me] submitStyleMeRequest failed unexpectedly:", error);
    return {
      error: error instanceof Error ? error.message : "Something went wrong submitting your request. Please try again.",
    };
  }

  redirect(`/style-me/${redirectRequestId}`);
}

async function submitStyleMeRequestInner(formData: FormData): Promise<string> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    throw new Error("You must be signed in to use Style Me.");
  }

  const validatedFields = SubmitStyleMeSchema.safeParse({
    inspoText: formData.get("inspoText") ?? undefined,
    budget: formData.get("budget"),
  });

  if (!validatedFields.success) {
    throw new Error(validatedFields.error.issues[0]?.message ?? "Please check your request details.");
  }

  const { inspoText, budget } = validatedFields.data;

  const requestId = formData.get("requestId");
  if (typeof requestId !== "string" || !UUID_PATTERN.test(requestId)) {
    throw new Error("Invalid request. Please try again.");
  }

  let imagePaths: unknown;
  try {
    imagePaths = JSON.parse(String(formData.get("imagePaths") ?? "[]"));
  } catch {
    throw new Error("Invalid request. Please try again.");
  }

  if (
    !Array.isArray(imagePaths) ||
    imagePaths.length === 0 ||
    imagePaths.length > MAX_LISTING_PHOTOS ||
    !imagePaths.every((path): path is string => typeof path === "string")
  ) {
    throw new Error("Add at least one photo.");
  }

  // Every path must live inside this user's own upload folder for this
  // exact request. The "style-me-images" bucket's own RLS insert policy
  // (supabase/schema.sql) already guarantees the browser could only have
  // uploaded here in the first place, so this isn't the only thing
  // standing between a user and someone else's photos — it just rejects an
  // obviously malformed/tampered payload up front instead of trusting
  // client input blindly.
  const expectedFolder = `${styleMeImagesFolder(user.id, requestId)}/`;
  if (!imagePaths.every((path) => path.startsWith(expectedFolder))) {
    throw new Error("Invalid request. Please try again.");
  }

  // Real content verification (P0 launch-readiness fix) — the client-side
  // check (isAllowedListingPhotoType, listing-photo.ts) only ever trusts
  // File.type, a browser-reported and fully spoofable value; a non-image
  // file renamed to .jpg sails through it. This reads real magic-number
  // bytes off the already-uploaded object instead. HEIC gets its own
  // specific, actionable message — this stack has no HEIC decoder, so a
  // genuine iPhone HEIC export is a real, expected case, not a malformed
  // file.
  for (const path of imagePaths) {
    const verification = await verifyUploadedImage(supabase, STYLE_ME_IMAGES_BUCKET, path);
    if (!verification.isUsable) {
      await supabase.storage.from(STYLE_ME_IMAGES_BUCKET).remove(imagePaths);
      throw new Error(
        verification.kind === "heic"
          ? "HEIC photos aren't supported yet — please export as JPEG or PNG first."
          : "One of those files doesn't look like a real photo. Please try a different image.",
      );
    }
  }

  const { data: request, error: insertError } = await supabase
    .from("style_me_requests")
    .insert({
      id: requestId,
      user_id: user.id,
      inspo_text: inspoText || null,
      inspo_images: imagePaths,
      budget,
      status: "pending",
    })
    .select("id")
    .single();

  if (insertError || !request) {
    // Best-effort — the photos are already sitting in Storage from the
    // client's own upload; if the row itself couldn't be created there's
    // nothing for them to be attached to, so this cleans them up rather
    // than leaving them orphaned.
    await supabase.storage.from(STYLE_ME_IMAGES_BUCKET).remove(imagePaths);
    throw new Error(insertError?.message ?? "Couldn't submit your request. Please try again.");
  }

  const signedUrls = await getSignedStyleMeImageUrls(supabase, imagePaths);
  const classification = await classifyStyleAggregate(signedUrls, inspoText);
  const categories = classification.categories.slice(0, MAX_BUNDLE_ITEMS);
  const maxPricePerItem = categories.length > 0 ? budget / categories.length : null;

  // "bags" is a real, distinct category now (src/lib/garment-detection.ts
  // — split out from "accessories" so a detected purse/backpack matches
  // against real bag listings specifically), but the `categories` column
  // on this table still has its original CHECK constraint
  // (style_me_requests_categories_check, supabase/schema.sql) limiting it
  // to the pre-"bags" six values — this table isn't in scope for that
  // migration. Collapsing "bags" to "accessories" ONLY for what gets
  // persisted here keeps this insert working without a schema change;
  // the matching loop below still uses `categories` (not this collapsed
  // list) to look up each item's TRUE detected category, so a bag is
  // still matched as a bag, not as generic accessories.
  const persistedCategories = [
    ...new Set(categories.map((category) => (category === "bags" ? "accessories" : category))),
  ];

  const { error: patchError } = await supabase
    .from("style_me_requests")
    .update({
      dominant_styles: classification.dominantStyles,
      categories: persistedCategories,
    })
    .eq("id", request.id)
    .eq("user_id", user.id);

  if (patchError) {
    await cleanupFailedStyleMeRequest(supabase, user.id, request.id);
    throw new Error("Could not save your request. Please try again.");
  }

  // REVERSE-IMAGE-SEARCH UPGRADE: classification now returns `items:
  // DetectedGarment[]` (src/lib/garment-detection.ts) — one rich, specific
  // entry per recurring garment/accessory — instead of a bare category +
  // loose "dominant styles" tag. Matching goes through the same shared
  // engine "Recreate This Outfit" uses (src/lib/garment-matching.ts),
  // which ranks by concrete garment attributes (garment type weighted far
  // above aesthetic-tag overlap) instead of aesthetic tags alone, searches
  // every platform already in `listings`, and excludes anything not
  // status='active'. Style Me still keeps only the single top-ranked
  // match per category (same as before this upgrade) — its bundle is a
  // one-shot, hidden-until-delivered reveal with no shuffle/alternatives
  // UI to show more than one, unlike Recreate This Outfit's own
  // interactive results page.
  const budgetOption = nearestBudgetOption(maxPricePerItem);
  const matchedListings: Listing[] = [];
  for (const category of categories) {
    const representativeItem = classification.items.find((item) => item.category === category);
    if (!representativeItem) continue;

    const candidates = await fetchGarmentCandidates(representativeItem, classification.dominantStyles, budgetOption);
    if (candidates.length > 0) matchedListings.push(candidates[0]);
  }

  if (matchedListings.length > 0) {
    const { data: bundle, error: bundleError } = await supabase
      .from("style_me_bundles")
      .insert({
        request_id: request.id,
        title: "Your Style Me bundle",
        description:
          classification.dominantStyles.length > 0
            ? `Curated around ${classification.dominantStyles.join(", ")}`
            : null,
      })
      .select("id")
      .single();

    if (bundleError || !bundle) {
      console.error("[style-me] Failed to create bundle:", bundleError);
    } else {
      const { error: itemsError } = await supabase.from("style_me_bundle_items").insert(
        matchedListings.map((listing) => ({ bundle_id: bundle.id, listing_id: listing.id })),
      );
      if (itemsError) {
        // Not rolled back — same "one bad step doesn't sink the whole
        // request" posture as outfit-recreations.ts. The reveal page
        // handles a missing/empty bundle gracefully.
        console.error("[style-me] Failed to insert bundle items:", itemsError);
      }
    }
  }

  return request.id;
}

async function cleanupFailedStyleMeRequest(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- matches createClient's own generic default (see src/lib/supabase/server.ts)
  supabase: Awaited<ReturnType<typeof createClient<any>>>,
  userId: string,
  requestId: string,
): Promise<void> {
  const folder = styleMeImagesFolder(userId, requestId);
  const { data: files } = await supabase.storage.from(STYLE_ME_IMAGES_BUCKET).list(folder);
  if (files && files.length > 0) {
    await supabase.storage.from(STYLE_ME_IMAGES_BUCKET).remove(files.map((file) => `${folder}/${file.name}`));
  }
  await supabase.from("style_me_requests").delete().eq("id", requestId).eq("user_id", userId);
}

export interface StyleMeBundleDetail {
  id: string;
  title: string;
  description: string | null;
  items: Listing[];
}

export interface StyleMeRequestDetail {
  id: string;
  imageUrls: string[];
  inspoText: string | null;
  budget: number;
  status: StyleMeStatus;
  createdAt: string;
  // Present ONLY once status is 'delivered' — the RLS select policy on
  // style_me_bundles/style_me_bundle_items would return nothing before
  // then anyway, but this return shape never even attempts to include it
  // earlier, so there's nothing to leak either way.
  bundle: StyleMeBundleDetail | null;
}

/** For /style-me/[id] — the redirect target after submit AND the revisit page. */
export async function getStyleMeRequest(id: string): Promise<{ request: StyleMeRequestDetail | null; error?: string }> {
  const supabase = await createClient();

  const { data: row, error } = await supabase
    .from("style_me_requests")
    .select("id, inspo_images, inspo_text, budget, status, created_at")
    .eq("id", id)
    .maybeSingle();

  if (error || !row) {
    return { request: null, error: "Style Me request not found." };
  }

  const status = await advanceStatusIfDue(row.id, row.status as StyleMeStatus, row.created_at);
  const imageUrls = await getSignedStyleMeImageUrls(supabase, row.inspo_images ?? []);

  let bundle: StyleMeBundleDetail | null = null;

  if (status === "delivered") {
    const { data: bundleRow } = await supabase
      .from("style_me_bundles")
      .select("id, title, description")
      .eq("request_id", row.id)
      .maybeSingle();

    if (bundleRow) {
      const { data: itemRows } = await supabase
        .from("style_me_bundle_items")
        .select("listing_id, listings(*)")
        .eq("bundle_id", bundleRow.id);

      const items = (itemRows ?? []).map((item) => item.listings as unknown as Listing).filter(Boolean);
      bundle = { id: bundleRow.id, title: bundleRow.title, description: bundleRow.description, items };
    }
  }

  return {
    request: {
      id: row.id,
      imageUrls,
      inspoText: row.inspo_text,
      budget: row.budget,
      status,
      createdAt: row.created_at,
      bundle,
    },
  };
}

export interface MyStyleMeRequest {
  id: string;
  imageUrl: string | null;
  status: StyleMeStatus;
  createdAt: string;
}

/** For /my-style-me — the caller's own requests, newest first. */
export async function getMyStyleMeRequests(): Promise<{ requests: MyStyleMeRequest[]; error?: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { requests: [] };
  }

  const { data, error } = await supabase
    .from("style_me_requests")
    .select("id, inspo_images, status, created_at")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false });

  if (error) {
    return { requests: [], error: error.message };
  }

  const requests: MyStyleMeRequest[] = [];
  for (const row of data ?? []) {
    const status = await advanceStatusIfDue(row.id, row.status as StyleMeStatus, row.created_at);
    const imageUrls = await getSignedStyleMeImageUrls(supabase, (row.inspo_images ?? []).slice(0, 1));
    requests.push({ id: row.id, imageUrl: imageUrls[0] ?? null, status, createdAt: row.created_at });
  }

  return { requests };
}

/**
 * "Add All to Cart" for a delivered bundle — near-identical sibling of
 * addBundleToCart (style-requests.ts), same loop over the existing
 * single-item addListingToCart, just pointed at style_me_bundle_items.
 */
export async function addStyleMeBundleToCart(bundleId: string): Promise<{ added: number; error?: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { added: 0, error: "You must be signed in to add items to your cart." };
  }

  const { data: itemRows, error } = await supabase
    .from("style_me_bundle_items")
    .select("listing_id")
    .eq("bundle_id", bundleId);

  if (error) {
    return { added: 0, error: error.message };
  }

  const listingIds = (itemRows ?? []).map((row) => row.listing_id).filter((id): id is string => Boolean(id));

  let added = 0;
  for (const listingId of listingIds) {
    const result = await addListingToCart(listingId);
    if (!result.error) added += 1;
  }

  revalidatePath("/cart");

  return { added };
}
