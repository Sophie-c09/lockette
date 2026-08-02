"use server";

// "Recreate This Outfit" — two Server Actions:
//
// 1. classifyOutfitPhotoForRecreation: upload the photo + run AI
//    classification (src/lib/outfit-classification.ts), and hand the
//    detected items back to the client WITHOUT creating any database row
//    yet.
// 2. submitOutfitRecreation: once the client has shown one item-level
//    budget selector PER detected category (src/lib/budget-options.ts)
//    and the user has picked each one, this inserts the recreation row.
//
// Split for exactly one reason: a per-category budget selector can only
// be shown once the categories are known, and categories aren't known
// until classification has already run.
//
// REVERSE-IMAGE-SEARCH UPGRADE: classification now returns `items:
// DetectedGarment[]` (src/lib/garment-detection.ts) — one rich, specific
// entry per visible garment/accessory (garment type, color, pattern,
// material, silhouette, era, resale search queries) — instead of the old
// bare `categories` + free-text `styleKeywords`.
//
// MULTI-MARKETPLACE SEARCH: getOutfitRecreation now searches through
// src/lib/marketplace-search.ts's searchMarketplaceItems — a real
// abstraction over Depop, Vinted, Poshmark, Mercari, eBay, and Lockette's
// own already-imported inventory as one ADDITIONAL source, never the
// only one, all filtered to the requested category, combined, and ranked
// as a single set, instead of only ever querying this app's own
// `listings` table. See that file's own header comment for exactly which
// of those sources are real vs. stubbed today (short version: only
// "reworn" — this app's own table — actually returns anything right now;
// the other five have no live search integration built yet, so they
// contribute zero results rather than failing or faking data).
// searchMarketplaceItems returns a flat, source-agnostic shape (no full
// Listing) — the UI (OutfitRecreationView.tsx) is untouched and still
// needs a real Listing per item, so getOutfitRecreation does one extra
// batched lookup, by id, for whichever results came back tagged
// `platform: "reworn"`. Excludes anything not status='active' and drops
// invalid URLs before ranking; applies the selected budget AFTER ranking
// rather than as a pre-filter.
//
// SECOND-STAGE SIMILARITY RANKING: searchMarketplaceItems' own ranking is
// left completely unchanged (that abstraction is not modified by this
// pass), but its output is no longer treated as final. Once the full
// Listing rows are fetched above, getOutfitRecreation runs them through
// src/lib/garment-similarity-ranking.ts's rankBySimilarity — an explicit,
// multi-factor visual-attribute scorer (garment type, color, silhouette,
// pattern, material, distinctive details, era, aesthetic — see that
// file's own header comment for the exact formula and why wrong-garment-
// type/wrong-silhouette candidates are actively PENALIZED, not just
// unrewarded) — using each matched listing's own title+description+
// color+brand, which is richer than the flat shape searchMarketplaceItems
// itself returns. The pool size/contents are unchanged; only the ORDER
// within that pool changes, so "top 3 shown, Shuffle reveals the next 3"
// keeps working exactly as before, just correctly ranked.
//
// Simplification kept from before: if a photo has two distinct items in
// the same category (e.g. a purse AND a necklace, both "accessories"),
// only the FIRST one found drives matching for that category slot — the
// UI still renders one section per category (OutfitRecreationView.tsx),
// and disambiguating multiple same-category items would need a UI change,
// out of scope for this pass.
//
// SCHEMA (outfit_recreations): { user_id, image_url, detected_items jsonb,
// style_tags, created_at } — detected_items now holds
// { items, categories, budgetByCategory }. No outfit_recreation_items
// table — matches are fetched/scored live on every view
// (getOutfitRecreation), not computed once and persisted as rows.
import { randomUUID } from "crypto";
import { redirect } from "next/navigation";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import {
  isAllowedListingPhotoType,
  LISTING_PHOTO_MIME_EXTENSIONS,
  MAX_LISTING_PHOTO_BYTES,
} from "@/lib/listing-photo";
import { OUTFIT_PHOTOS_BUCKET, outfitPhotoPath, getSignedOutfitPhotoUrl } from "@/lib/outfit-photo";
import { detectImageKind } from "@/lib/image-content-verification";
import { classifyOutfitPhoto, type OutfitCategory } from "@/lib/outfit-classification";
import { searchMarketplaceItems } from "@/lib/marketplace-search";
import { rankBySimilarity } from "@/lib/garment-similarity-ranking";
import { generateImageEmbedding } from "@/lib/image-similarity";
import { calculateVisualMatch } from "@/lib/ai/style-match-score";
import type { DetectedGarment } from "@/lib/garment-detection";
import { budgetMaxPrice, type BudgetOption } from "@/lib/budget-options";
import type { Listing } from "@/lib/supabase/listings.types";

// Same column set src/lib/garment-matching.ts's own fetch used — enough
// for every existing card/detail-page render (ListingCard, MatchResultCard) —
// plus image_embedding (Visual Similarity Search Foundation,
// src/lib/image-similarity.ts): always null today (nothing populates it
// yet), threaded through below purely so garment-similarity-ranking.ts's
// new, additive visualSimilarityScore term has something to eventually
// read once a real embedding pipeline exists — selecting it now costs
// nothing and changes no current behavior.
const FULL_LISTING_COLUMNS =
  "id, title, description, price, image_url, product_url, platform, brand, category, size, color, aesthetic_tags, image_embedding, created_at";

// Inventory Intelligence integration — same lazy-probed, process-cached
// "does this database have the new columns yet" pattern as
// discover-feed.ts/bundle-generation.ts, for the same reason: appending
// these to FULL_LISTING_COLUMNS unconditionally would fail this file's
// query (and therefore Recreate This Look itself) on a database where
// supabase/schema.sql's Part 8 migration hasn't run yet.
const INTELLIGENCE_LISTING_COLUMNS = "visual_analysis, visual_embedding, inventory_quality_score";
let recreationIntelligenceColumnsAvailable: boolean | null = null;

async function checkRecreationIntelligenceColumnsAvailable(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- matching createClient()'s own untyped default
  supabase: SupabaseClient<any>,
): Promise<boolean> {
  if (recreationIntelligenceColumnsAvailable != null) return recreationIntelligenceColumnsAvailable;
  const { error } = await supabase.from("listings").select(INTELLIGENCE_LISTING_COLUMNS).limit(1);
  recreationIntelligenceColumnsAvailable = !error;
  return recreationIntelligenceColumnsAvailable;
}

const ClassifyOutfitPhotoSchema = z.object({
  inspoText: z.string().trim().max(2000).optional(),
});

export interface ClassifyOutfitPhotoResult {
  error?: string;
  photoPath?: string;
  photoUrl?: string;
  items?: DetectedGarment[];
  categories?: OutfitCategory[];
  aestheticTags?: string[];
}

/** Step 1: upload the photo, classify it, return the detected items — no DB row yet. */
export async function classifyOutfitPhotoForRecreation(formData: FormData): Promise<ClassifyOutfitPhotoResult> {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return { error: "You must be signed in to recreate an outfit." };
    }

    const validatedFields = ClassifyOutfitPhotoSchema.safeParse({
      inspoText: formData.get("inspoText") ?? undefined,
    });

    if (!validatedFields.success) {
      return { error: validatedFields.error.issues[0]?.message ?? "Please check your request details." };
    }

    const { inspoText } = validatedFields.data;

    const image = formData.get("image");
    if (!(image instanceof File) || image.size === 0) {
      return { error: "Add a photo of the outfit." };
    }
    if (!isAllowedListingPhotoType(image.type)) {
      return { error: "Photo must be JPEG, PNG, WebP, or GIF." };
    }
    if (image.size > MAX_LISTING_PHOTO_BYTES) {
      return { error: "Photo must be 5MB or smaller." };
    }

    // Real content verification (P0 launch-readiness fix) — the check
    // above only ever trusts File.type, a browser-reported and fully
    // spoofable value; a non-image file renamed to .jpg sails through it.
    // This route receives the raw file bytes directly (unlike Style Me's
    // client-direct-to-Storage upload), so the real magic-number bytes can
    // be checked BEFORE ever uploading it at all. HEIC gets its own
    // specific, actionable message — this stack has no HEIC decoder, so a
    // genuine iPhone HEIC export is a real, expected case, not a malformed
    // file.
    const sniffBytes = new Uint8Array(await image.slice(0, 16).arrayBuffer());
    const imageKind = detectImageKind(sniffBytes);
    if (imageKind === "heic") {
      return { error: "HEIC photos aren't supported yet — please export as JPEG or PNG first." };
    }
    if (imageKind === "unknown") {
      return { error: "That file doesn't look like a real photo. Please try a different image." };
    }

    // Random path token, not this row's own id — there's only ever one
    // photo, so (unlike style-requests' multi-photo case) there's no need
    // for the two-phase insert-first/patch-after-upload dance; the photo
    // just gets uploaded a step earlier now (before the row even exists),
    // since classification needs a real accessible URL.
    const token = randomUUID();
    const extension = LISTING_PHOTO_MIME_EXTENSIONS[image.type];
    const path = outfitPhotoPath(user.id, token, extension);

    console.log("[outfit-recreations] Upload start", {
      userId: user.id,
      bucket: OUTFIT_PHOTOS_BUCKET,
      path,
      contentType: image.type,
      size: image.size,
    });

    const { error: uploadError } = await supabase.storage
      .from(OUTFIT_PHOTOS_BUCKET)
      .upload(path, image, { contentType: image.type });

    if (uploadError) {
      console.error("[outfit-recreations] Upload failed:", {
        bucket: OUTFIT_PHOTOS_BUCKET,
        path,
        userId: user.id,
        contentType: image.type,
        size: image.size,
        message: uploadError.message,
      });
      // .message only — never return the raw StorageError object.
      return { error: `Could not upload your photo: ${uploadError.message}` };
    }

    console.log("[outfit-recreations] Upload success", { path });

    const signedUrl = await getSignedOutfitPhotoUrl(supabase, path);
    if (!signedUrl) {
      console.error("[outfit-recreations] Signed URL generation failed", { bucket: OUTFIT_PHOTOS_BUCKET, path });
      await supabase.storage.from(OUTFIT_PHOTOS_BUCKET).remove([path]);
      return { error: "Could not process your photo. Please try again." };
    }

    console.log("[outfit-recreations] Image URL generated", { path });

    console.log("[outfit-recreations] AI classification start", { path });
    // inspoText only ever influences THIS call — there's no column to
    // persist it in, so it's not threaded any further than this.
    const classification = await classifyOutfitPhoto(signedUrl, inspoText);
    console.log("[outfit-recreations] AI classification complete", {
      items: classification.items.map((item) => item.garmentType),
      categories: classification.categories,
      aestheticTagCount: classification.aestheticTags.length,
    });

    return {
      photoPath: path,
      photoUrl: signedUrl,
      items: classification.items,
      categories: classification.categories,
      aestheticTags: classification.aestheticTags,
    };
  } catch (error) {
    console.error("[outfit-recreations] classifyOutfitPhotoForRecreation failed unexpectedly:", error);
    return {
      error: error instanceof Error ? error.message : "Something went wrong processing your photo. Please try again.",
    };
  }
}

export interface SubmitOutfitRecreationInput {
  photoPath: string;
  items: DetectedGarment[];
  categories: OutfitCategory[];
  aestheticTags: string[];
  // One budget selection per detected category (src/lib/budget-options.ts)
  // — stored inside detected_items (see this file's own header comment);
  // a category missing from this map (shouldn't normally happen, since
  // the form seeds every detected category with a default) falls back to
  // "any" wherever it's read back out.
  budgetByCategory: Partial<Record<OutfitCategory, BudgetOption>>;
}

/**
 * Step 2: insert the recreation row. Matches are NOT fetched here — see
 * this file's own header comment — so this is just a single insert, no
 * per-category listing queries.
 *
 * `redirect()` is called AFTER (outside) the try/catch below, on purpose:
 * Next.js implements redirect() by throwing a special internal signal, and
 * a try/catch that wrapped it would catch that throw too and misreport a
 * successful redirect as a failure — so the try/catch only ever covers
 * the actual data work, and `recreationId` is just handed back out of it.
 */
export async function submitOutfitRecreation(
  input: SubmitOutfitRecreationInput,
): Promise<{ error?: string }> {
  let recreationId: string;

  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    console.log("[outfit-recreations] user:", user);

    if (!user) {
      // Do NOT attempt the insert — an RLS policy check (auth.uid() =
      // user_id) can never pass without a real authenticated user, and a
      // null/undefined user_id in the insert payload is exactly what
      // produces "new row violates row-level security policy for table
      // outfit_recreations" instead of a clean, readable error.
      return { error: "User not authenticated" };
    }

    const { photoPath, items, categories, aestheticTags, budgetByCategory } = input;

    if (categories.length === 0) {
      await supabase.storage.from(OUTFIT_PHOTOS_BUCKET).remove([photoPath]);
      return { error: "Couldn't detect any outfit pieces in that photo — try a clearer photo." };
    }

    console.log("[outfit-recreations] Database insert start", { userId: user.id, categories });

    // Visual Similarity Search Foundation (src/lib/image-similarity.ts) —
    // best-effort, never blocks this submission. One embedding for the
    // WHOLE inspiration photo (not per detected item — there's only one
    // photo per recreation), generated from a fresh signed URL for the
    // already-uploaded photo, stored alongside the row so
    // getOutfitRecreation can pass it into rankBySimilarity's optional
    // queryImageEmbedding parameter (src/lib/garment-similarity-ranking.ts).
    // null on any failure (see generateImageEmbedding's own logging) —
    // the insert still proceeds exactly as before either way.
    const inspirationPhotoUrl = await getSignedOutfitPhotoUrl(supabase, photoPath);
    const inspirationEmbedding = inspirationPhotoUrl ? await generateImageEmbedding(inspirationPhotoUrl) : null;

    const { data: recreation, error: insertError } = await supabase
      .from("outfit_recreations")
      .insert({
        user_id: user.id,
        image_url: photoPath,
        detected_items: { items, categories, budgetByCategory },
        style_tags: aestheticTags,
        image_embedding: inspirationEmbedding,
        embedding_generated_at: inspirationEmbedding ? new Date().toISOString() : null,
      })
      .select("id")
      .single();

    if (insertError || !recreation) {
      console.error("[outfit-recreations] Database insert failed:", {
        userId: user.id,
        message: insertError?.message,
      });
      await supabase.storage.from(OUTFIT_PHOTOS_BUCKET).remove([photoPath]);
      // .message only — never the raw PostgrestError object.
      return { error: insertError?.message ?? "Couldn't build your outfit. Please try again." };
    }

    console.log("[outfit-recreations] Database insert success", { recreationId: recreation.id });
    recreationId = recreation.id;
  } catch (error) {
    console.error("[outfit-recreations] submitOutfitRecreation failed unexpectedly:", error);
    return {
      error: error instanceof Error ? error.message : "Something went wrong building your outfit. Please try again.",
    };
  }

  redirect(`/recreate-outfit/${recreationId}`);
}

export interface OutfitRecreationItem {
  category: OutfitCategory;
  rank: number;
  listing: Listing;
}

export interface OutfitRecreationDetail {
  id: string;
  photoUrl: string | null;
  categories: OutfitCategory[];
  itemsByCategory: Record<string, OutfitRecreationItem[]>;
  createdAt: string;
}

// Shape of the detected_items jsonb column — see this file's own header
// comment on why budgetByCategory lives here too.
interface DetectedItems {
  items?: DetectedGarment[];
  categories?: OutfitCategory[];
  budgetByCategory?: Partial<Record<OutfitCategory, BudgetOption>>;
}

/**
 * For /recreate-outfit/[id] — the recreation, with matches fetched/scored
 * live for every category (no outfit_recreation_items table to read
 * pre-computed rows from — see this file's own header comment), each
 * still respecting that category's own stored budget selection. If a
 * photo had multiple distinct items in the same category, only the first
 * one drives matching for that slot (see this file's own header comment).
 */
export async function getOutfitRecreation(
  id: string,
): Promise<{ recreation: OutfitRecreationDetail | null; error?: string }> {
  const supabase = await createClient();

  const { data: recreation, error } = await supabase
    .from("outfit_recreations")
    .select("id, image_url, detected_items, style_tags, image_embedding, created_at")
    .eq("id", id)
    .maybeSingle();

  if (error || !recreation) {
    return { recreation: null, error: "Outfit recreation not found." };
  }

  const photoUrl = await getSignedOutfitPhotoUrl(supabase, recreation.image_url);

  const detected = (recreation.detected_items ?? {}) as DetectedItems;
  const items = detected.items ?? [];
  const categories = detected.categories ?? [];
  const budgetByCategory = detected.budgetByCategory ?? {};
  const aestheticTags = recreation.style_tags ?? [];
  // Visual Similarity Search Foundation (src/lib/image-similarity.ts) —
  // null for every recreation submitted before this column existed, or
  // if generateImageEmbedding failed at submit time (see
  // submitOutfitRecreation's own comment); rankBySimilarity's
  // queryImageEmbedding parameter already treats null as a no-op
  // (src/lib/garment-similarity-ranking.ts), so this is safe either way.
  const inspirationEmbedding: number[] | null = recreation.image_embedding ?? null;

  const itemsByCategory: Record<string, OutfitRecreationItem[]> = {};
  for (const category of categories) {
    const representativeItem = items.find((item) => item.category === category);
    if (!representativeItem) continue;

    const budget = budgetByCategory[category] ?? "any";

    // Fold every piece of AI-extracted detail into one description
    // string — searchMarketplaceItems' query shape only takes a single
    // free-text `description` field (src/lib/marketplace-search.ts), not
    // a fully structured DetectedGarment, so this is where that
    // structured detail becomes searchable text instead of being lost.
    const description = [
      representativeItem.garmentType,
      representativeItem.description,
      representativeItem.pattern,
      representativeItem.material,
      representativeItem.silhouette,
      representativeItem.era,
      ...representativeItem.searchQueries,
    ]
      .filter((part): part is string => Boolean(part))
      .join(" ");

    const results = await searchMarketplaceItems({
      category,
      description,
      color: representativeItem.color,
      style: aestheticTags.join(" "),
      priceLimit: budgetMaxPrice(budget),
    });

    // The UI (OutfitRecreationView.tsx) is untouched this round and only
    // knows how to render a real Lockette Listing (product image, price,
    // link to /listing/[id]) — not the flat NormalizedMarketplaceItem
    // shape searchMarketplaceItems returns for every source. Every
    // non-"reworn" source is still searched, filtered, and ranked into
    // the combined results above; there's just no UI yet to show them —
    // for "reworn" results specifically, one batched follow-up lookup
    // fetches the full Listing rows so the rest of this file's contract
    // stays identical.
    const rewornIds = results.filter((item) => item.platform === "reworn").map((item) => item.id);

    if (rewornIds.length > 0) {
      const hasIntelligenceColumns = await checkRecreationIntelligenceColumnsAvailable(supabase);
      const listingColumns = hasIntelligenceColumns
        ? `${FULL_LISTING_COLUMNS}, ${INTELLIGENCE_LISTING_COLUMNS}`
        : FULL_LISTING_COLUMNS;

      const { data: fullListings, error: listingsError } = await supabase
        .from("listings")
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- runtime-computed select string, see checkRecreationIntelligenceColumnsAvailable's own comment
        .select(listingColumns as any)
        .in("id", rewornIds);

      if (listingsError) {
        console.error("[outfit-recreations] Failed to load matched listings:", listingsError);
      }

      const listingById = new Map(
        ((fullListings ?? []) as unknown as Listing[]).map((listing) => [listing.id, listing]),
      );
      const unrankedListings = rewornIds
        .map((rewornId) => listingById.get(rewornId))
        .filter((listing): listing is Listing => Boolean(listing));

      // Second-stage ranking (src/lib/garment-similarity-ranking.ts) —
      // scored against each listing's own title+description+color+brand,
      // richer than the flat text searchMarketplaceItems itself has to
      // work with, PLUS visual similarity (this recreation's own
      // inspirationEmbedding vs. each listing's own image_embedding) once
      // both sides actually have one — see rankBySimilarity's own
      // queryImageEmbedding parameter and this file's own comment on
      // inspirationEmbedding above. Re-orders this same pool; nothing is
      // added, removed, or re-fetched.
      const rankedListings = rankBySimilarity(
        representativeItem,
        aestheticTags.join(" "),
        unrankedListings.map((listing) => ({
          listing,
          category,
          searchableText: [listing.title, listing.description, listing.color, listing.brand]
            .filter((part): part is string => Boolean(part))
            .join(" "),
          imageEmbedding: listing.image_embedding,
        })),
        inspirationEmbedding,
      ).map(({ listing }) => listing);

      // Inventory Intelligence integration (Part 3) — a further, additive
      // re-sort using each listing's visual_analysis/inventory_quality_score
      // when present, layered ON TOP of rankBySimilarity's own order
      // rather than replacing it. A listing with no visual_analysis yet
      // scores a bonus of exactly 0 and, since the sort below is stable
      // on ties, keeps its rankBySimilarity position untouched — this is
      // a complete no-op (identical order to before) until the indexer
      // (src/lib/inventory/inventory-indexer.ts) has actually analyzed a
      // meaningful slice of inventory.
      const rerankedListings = rankedListings
        .map((listing, index) => {
          if (!listing.visual_analysis) return { listing, bonus: 0, index };
          const match = calculateVisualMatch(
            { ...listing.visual_analysis, price: listing.price, imageEmbedding: listing.visual_embedding ?? null },
            { aesthetics: aestheticTags, queryImageEmbedding: inspirationEmbedding },
          );
          return { listing, bonus: match.score + (listing.inventory_quality_score ?? 0) * 0.1, index };
        })
        .sort((a, b) => b.bonus - a.bonus || a.index - b.index)
        .map(({ listing }) => listing);

      itemsByCategory[category] = rerankedListings.map((listing, rank) => ({ category, rank, listing }));
    }
  }

  return {
    recreation: {
      id: recreation.id,
      photoUrl,
      categories,
      itemsByCategory,
      createdAt: recreation.created_at,
    },
  };
}

export interface MyOutfitRecreation {
  id: string;
  photoUrl: string | null;
  categories: OutfitCategory[];
  createdAt: string;
}

/** For /my-outfits — the caller's own recreations, newest first. */
export async function getMyOutfitRecreations(): Promise<{ recreations: MyOutfitRecreation[]; error?: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { recreations: [] };
  }

  const { data, error } = await supabase
    .from("outfit_recreations")
    .select("id, image_url, detected_items, created_at")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false });

  if (error) {
    return { recreations: [], error: error.message };
  }

  const recreations: MyOutfitRecreation[] = [];
  for (const row of data ?? []) {
    const photoUrl = await getSignedOutfitPhotoUrl(supabase, row.image_url);
    const detected = (row.detected_items ?? {}) as DetectedItems;
    recreations.push({
      id: row.id,
      photoUrl,
      categories: detected.categories ?? [],
      createdAt: row.created_at,
    });
  }

  return { recreations };
}
