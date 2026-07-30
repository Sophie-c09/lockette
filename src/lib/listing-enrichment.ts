// Shared "extracted listing -> enriched listing" step: text classification
// (brand/category/color/aesthetic tags) plus AI image tagging, merged on
// top of whatever extractListingFromUrl() already found. Factored out of
// /api/import-listing/route.ts (the single-URL importer) so the bulk
// import pipeline (src/lib/bulk-import.ts) runs the exact same enrichment,
// not a second, drifting copy of it.
import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import { z } from "zod";
import type { ExtractedListing } from "@/lib/extraction/normalize-listing";
import {
  applyClassification,
  classifyListing,
  classifyListingsBatch,
  type ListingClassificationResult,
} from "@/lib/listing-classification";
import { generateImageTags, generateImageTagsBatch } from "@/lib/image-tagging";
import { GARMENT_CATEGORIES, type GarmentCategory } from "@/lib/garment-detection";

function toClassificationInput(listing: ExtractedListing) {
  return {
    title: listing.title,
    description: listing.description,
    brand: listing.brand,
    category: listing.category,
    color: listing.color,
    size: listing.size,
    aesthetic_tags: listing.aesthetic_tags,
  };
}

/**
 * Never throws — classification and image tagging both already catch
 * their own errors internally and degrade to "no enrichment," but this
 * wraps each step in a second safety net too, same reasoning as the
 * original route handler this was extracted from: one enrichment step
 * failing must never take down the import itself.
 *
 * Classification (text) and image tagging (vision) are independent
 * signals that don't depend on each other's output, so they run
 * concurrently via Promise.all rather than sequentially — same total
 * work, lower latency, no change in what either step produces.
 */
export async function enrichListing(listing: ExtractedListing): Promise<ExtractedListing> {
  const [classification, imageTags] = await Promise.all([
    classifyListing(toClassificationInput(listing)).catch((error) => {
      const reason = error instanceof Error ? error.message : String(error);
      console.warn(`[listing-classification] Failed - using original listing (unexpected error: ${reason})`);
      return null;
    }),
    listing.image_url
      ? generateImageTags(listing.image_url).catch((error) => {
          const reason = error instanceof Error ? error.message : String(error);
          console.warn(`[image-tagging] Failed - using text-based tags only (unexpected error: ${reason})`);
          return [] as string[];
        })
      : Promise.resolve([] as string[]),
  ]);

  const classified = applyClassification(listing, classification);

  return {
    ...classified,
    aesthetic_tags: Array.from(new Set([...classified.aesthetic_tags, ...imageTags])),
  };
}

/**
 * Batched counterpart to enrichListing — classifies text AND tags images
 * for a whole group of listings in just two OpenAI calls total (one
 * classification-batch call, one image-tagging-batch call, run
 * concurrently) instead of 2 calls per listing. Only used by
 * src/lib/admin-scraper.ts, which is the only caller that processes many
 * candidates from the same round at once; bulk-import.ts and
 * /api/import-listing/route.ts keep calling enrichListing per-URL as
 * before, since they don't have a natural "batch" of listings available
 * at the same time. Same classification/tagging rules as the per-item
 * path — batching only changes how many requests it takes, never what
 * each listing is classified/tagged as. Never throws (both batch
 * functions already degrade to null/[] per item internally).
 */
export async function enrichListingsBatch(listings: ExtractedListing[]): Promise<ExtractedListing[]> {
  if (listings.length === 0) return [];

  const imageUrls = listings
    .map((listing) => listing.image_url)
    .filter((url): url is string => Boolean(url));

  const [classifications, imageTagsByUrl] = await Promise.all([
    classifyListingsBatch(listings.map(toClassificationInput)),
    imageUrls.length > 0
      ? generateImageTagsBatch(imageUrls).then(
          (tagLists): Map<string, string[]> => new Map(imageUrls.map((url, i) => [url, tagLists[i]])),
        )
      : Promise.resolve(new Map<string, string[]>()),
  ]);

  return listings.map((listing, index) => {
    const classification: ListingClassificationResult | null = classifications[index] ?? null;
    const classified = applyClassification(listing, classification);
    const imageTags = listing.image_url ? (imageTagsByUrl.get(listing.image_url) ?? []) : [];

    return {
      ...classified,
      aesthetic_tags: Array.from(new Set([...classified.aesthetic_tags, ...imageTags])),
    };
  });
}

// ---------------------------------------------------------------------------
// Richer, garment-level metadata (Marketplace Ingestion's Part 2) — a
// SEPARATE, additive export, not a replacement for enrichListing/
// enrichListingsBatch above (those stay exactly as they were; every
// existing caller — /api/import-listing/route.ts, bulk-import.ts,
// admin-scraper.ts — is unaffected). classifyListing/generateImageTags
// already cover color/fit/era/brand/style tags (reused below, not
// reimplemented) — the only genuinely new capability here is pulling
// garment_type/material/pattern/silhouette out of a listing's own photo,
// which nothing in this codebase did before. `category` is deliberately
// GARMENT_CATEGORIES (src/lib/garment-detection.ts — tops/dresses/
// bottoms/outerwear/shoes/bags/accessories), NOT classifyListing's own
// CATEGORY_VOCABULARY (src/lib/listing-classification.ts, which also
// has a separate "jewelry" bucket) — the two vocabularies coexist as
// pre-existing, separate concerns; unifying them is out of scope here.
// ---------------------------------------------------------------------------

export interface ListingMetadata {
  category: GarmentCategory;
  garmentType: string;
  color: string | null;
  material: string | null;
  pattern: string | null;
  silhouette: string;
  fit: string | null;
  era: string | null;
  styleTags: string[];
  brand: string | null;
}

const GarmentAttributesSchema = z.object({
  category: z.enum(GARMENT_CATEGORIES),
  garment_type: z.string(),
  material: z.string().nullable(),
  pattern: z.string().nullable(),
  silhouette: z.string(),
});

const GARMENT_ATTRIBUTES_SYSTEM_PROMPT = `You are a fashion cataloging assistant for Lockette, a secondhand clothing marketplace, enriching ONE resale listing's product photo with structured attributes (this is a single item for sale, not a full outfit).

Return:
- category: one of [${GARMENT_CATEGORIES.join(", ")}] — the garment slot this item occupies.
- garment_type: the specific, concrete name of the item (e.g. "cardigan", "mini skirt", "baby tee", "shoulder bag") — never a vague restatement of the category.
- material: the visible or likely fabric/material (e.g. "denim", "leather", "knit") — null if not determinable.
- pattern: the pattern if any (e.g. "floral", "striped", "solid") — null if none is visible.
- silhouette: the cut/silhouette (e.g. "oversized", "slim fit", "A-line", "cropped").

Use the listing's own title/description as supporting context, but base material/pattern/silhouette primarily on what the image actually shows.

Respond only with the structured fields — no extra commentary.`;

function debugLogGarmentAttributes(message: string): void {
  console.warn(`[listing-enrichment] ${message}`);
}

const GARMENT_ATTRIBUTES_MODEL = "gpt-4o-mini";
const GARMENT_ATTRIBUTES_TIMEOUT_MS = 15_000;

async function extractGarmentAttributes(
  listing: Pick<ExtractedListing, "title" | "description" | "image_url">,
): Promise<Pick<ListingMetadata, "category" | "garmentType" | "material" | "pattern" | "silhouette"> | null> {
  if (!listing.image_url) {
    debugLogGarmentAttributes("Failed - no enrichment (listing has no image)");
    return null;
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.log("[Marketplace Search] Listing enrichment unavailable — OPENAI_API_KEY is not set");
    debugLogGarmentAttributes("Failed - no enrichment (OPENAI_API_KEY is not set)");
    return null;
  }

  try {
    const client = new OpenAI({ apiKey, timeout: GARMENT_ATTRIBUTES_TIMEOUT_MS });
    const model = process.env.OPENAI_LISTING_ENRICHMENT_MODEL || GARMENT_ATTRIBUTES_MODEL;
    const notes = [listing.title, listing.description].filter(Boolean).join(" — ") || "No listing text provided.";

    const completion = await client.chat.completions.parse({
      model,
      messages: [
        { role: "system", content: GARMENT_ATTRIBUTES_SYSTEM_PROMPT },
        {
          role: "user",
          content: [
            { type: "text", text: notes },
            { type: "image_url", image_url: { url: listing.image_url } },
          ],
        },
      ],
      response_format: zodResponseFormat(GarmentAttributesSchema, "garment_attributes"),
    });

    const parsed = completion.choices[0]?.message?.parsed;
    if (!parsed) throw new Error("no parsed output returned");

    debugLogGarmentAttributes(`Success (${parsed.garment_type}, category=${parsed.category})`);

    return {
      category: parsed.category,
      garmentType: parsed.garment_type,
      material: parsed.material,
      pattern: parsed.pattern,
      silhouette: parsed.silhouette,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    debugLogGarmentAttributes(`Failed - no enrichment (${reason})`);
    return null;
  }
}

/**
 * Full garment-level metadata for one listing — category, garment_type,
 * and every requested attribute (color, material, pattern, silhouette,
 * fit, era, style_tags, brand). Reuses classifyListing (color/fit/era/
 * brand) and generateImageTags (style_tags) rather than re-deriving them;
 * only garment_type/material/pattern/silhouette come from a new call
 * (extractGarmentAttributes above). Returns null if that new call fails
 * (missing API key, network error, no image) — never a fabricated
 * category/garment_type — but still degrades gracefully field-by-field
 * for color/fit/era/brand/styleTags, matching every other enrichment
 * function in this file's own "one failing step never blocks the rest"
 * convention.
 */
export async function enrichListingMetadata(listing: ExtractedListing): Promise<ListingMetadata | null> {
  const [attributes, classification, styleTags] = await Promise.all([
    extractGarmentAttributes(listing),
    classifyListing(toClassificationInput(listing)).catch((error) => {
      const reason = error instanceof Error ? error.message : String(error);
      console.warn(`[listing-classification] Failed - using original listing (unexpected error: ${reason})`);
      return null as ListingClassificationResult | null;
    }),
    listing.image_url
      ? generateImageTags(listing.image_url).catch(() => [] as string[])
      : Promise.resolve([] as string[]),
  ]);

  if (!attributes) return null;

  return {
    category: attributes.category,
    garmentType: attributes.garmentType,
    material: attributes.material,
    pattern: attributes.pattern,
    silhouette: attributes.silhouette,
    color: classification?.color ?? listing.color,
    fit: classification?.fit ?? null,
    era: classification?.style_era ?? null,
    brand: classification?.brand ?? listing.brand,
    styleTags,
  };
}
