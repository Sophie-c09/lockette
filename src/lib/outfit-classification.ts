// AI classification for "Recreate This Outfit" — given a user's uploaded
// outfit photo (+ optional text), identifies EVERY visible garment/
// accessory with rich structured detail (src/lib/garment-detection.ts),
// not just a coarse category label. Modeled on this codebase's two
// existing vision-based OpenAI callers: src/lib/image-tagging.ts (vision,
// vocabulary-constrained structured output) and src/lib/listing-quality.ts
// (mixed text+image in one call). Same conventions throughout: gpt-4o-mini
// default, 15s timeout, single attempt (no retries), never throws, always
// returns a safe default.
//
// UPGRADE (reverse-image-search accuracy): this used to output only
// `categories: ("top"|"bottom"|"layer")[]` — a vocabulary with no way to
// even NAME accessories, bags, or shoes, let alone describe them — plus a
// loose free-text `styleKeywords` list. Matching against that coarse
// signal meant a generic aesthetic-tag overlap decided results, which is
// exactly why a specific skirt could lose to random jeans that merely
// "matched the vibe," and why accessories/outerwear were silently
// dropped instead of searched for at all. `items` now carries one
// DetectedGarment per visible piece (specific garment type, color,
// pattern, material, silhouette, era, ready resale search queries) across
// the full six-bucket vocabulary (src/lib/garment-detection.ts) — see
// src/lib/garment-matching.ts for how that gets used to actually rank
// real listings.
import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import { z } from "zod";
import { HOMEPAGE_CATEGORIES } from "@/lib/aesthetic-categories";
import { IMAGE_TAG_VOCABULARY } from "@/lib/image-tagging";
import { GARMENT_CATEGORIES, type DetectedGarment, type GarmentCategory } from "@/lib/garment-detection";

// Alias, not a new type — every existing caller (src/app/actions/
// outfit-recreations.ts, RecreateOutfitForm.tsx, OutfitRecreationView.tsx)
// imports `OutfitCategory` from this file, so keeping the name (now
// widened to the full garment vocabulary instead of top/bottom/layer)
// means none of those call sites need to change their imports.
export type OutfitCategory = GarmentCategory;

export interface OutfitClassification {
  items: DetectedGarment[];
  // Derived from `items` — the unique categories present, first-occurrence
  // order. Kept alongside `items` because every downstream consumer
  // (matching, storage, the per-category budget selector) still thinks in
  // terms of "one slot per category," not "one slot per specific item" —
  // see outfit-recreations.ts's own comment on why that simplification is
  // deliberate for now.
  categories: OutfitCategory[];
  aestheticTags: string[];
}

const DetectedGarmentSchema = z.object({
  category: z.enum(GARMENT_CATEGORIES),
  garment_type: z.string(),
  description: z.string(),
  color: z.string(),
  pattern: z.string().nullable(),
  material: z.string().nullable(),
  silhouette: z.string(),
  era: z.string().nullable(),
  visual_details: z.string().nullable(),
  search_queries: z.array(z.string()),
});

const OutfitClassificationSchema = z.object({
  items: z.array(DetectedGarmentSchema),
  aesthetic_tags: z.array(z.enum(IMAGE_TAG_VOCABULARY)),
});

// Deliberately blunt/repetitive ("do not summarize," "every single one,"
// the 3-item worked example) — this prompt replaced an earlier version
// that technically listed accessories/bags/outerwear as valid categories
// but didn't insist hard enough that the model actually go looking for
// them, and in practice kept returning just a top + a bottom. The
// instructions below exist specifically to stop that under-detection.
const SYSTEM_PROMPT = `You are a fashion cataloging assistant for Lockette, a secondhand clothing marketplace, performing reverse-image search on an uploaded outfit photo (plus any notes the user gave).

CRITICAL: You must identify EVERY visible wearable item in the photo, not just the main garment. Do NOT summarize the outfit as a whole, and do NOT focus only on the shirt/top and pants/bottom. A real outfit almost always has more pieces than that — outerwear, shoes, bags, and accessories are just as important to find matches for as the top and bottom are, and must NEVER be skipped just because they aren't the most obvious item in the photo.

Check specifically for items in EACH of these categories, and return every one you actually see, each as its own separate entry:
- tops
- bottoms
- outerwear — sweaters, jackets, cardigans, coats, hoodies, blazers: anything worn as a layer over the rest of the outfit
- dresses
- shoes
- bags — purses, backpacks, totes, clutches
- accessories — jewelry, belts, scarves, sunglasses, hats, and anything else worn or carried that isn't a bag

Example: if someone is wearing a skirt, a sweater, and carrying a purse, you must return exactly 3 separate items — one for the skirt (category: bottoms), one for the sweater (category: outerwear), one for the purse (category: bags). Never merge multiple items into a single entry, and never omit one because it seems secondary.

For EACH item you see, return:
- category: one of [${GARMENT_CATEGORIES.join(", ")}] — the garment slot this item occupies.
- garment_type: the specific, concrete name of the item (e.g. "mini skirt", "straight-leg jeans", "denim jacket", "crossbody bag", "ankle boots") — never a vague restatement of the category.
- description: a detailed visual description covering cut and overall look.
- color: the item's primary color(s).
- pattern: the pattern if any (e.g. "floral", "striped", "solid") — null if none is visible.
- material: the visible or likely fabric/material (e.g. "denim", "leather", "knit") — null if not determinable.
- silhouette: the fit/silhouette (e.g. "oversized", "slim fit", "A-line", "cropped").
- era: the likely style era if it clearly reads as one (e.g. "Y2K", "90s", "70s") — null if it doesn't read as any particular era.
- visual_details: important, specific visual details beyond the general description — buttons, zippers, hardware, logos, trim, distressing, embellishments, etc. — null if nothing notable stands out beyond the basic look.
- search_queries: 2-4 short phrases optimized for searching resale marketplaces (Depop, Vinted, Poshmark, Mercari, eBay) for this SPECIFIC item — concrete and searchable, not vague style words.

Also return aesthetic_tags: 0-3 tags from [${IMAGE_TAG_VOCABULARY.join(", ")}] that genuinely fit the overall outfit — never invent a tag outside this list, an empty list is fine if none clearly apply.

Respond only with the structured fields — no extra commentary.`;

function debugLog(message: string): void {
  console.warn(`[outfit-classification] ${message}`);
}

const DEFAULT_MODEL = "gpt-4o-mini";
const REQUEST_TIMEOUT_MS = 15_000;

function toCanonicalTag(label: string): string | undefined {
  return HOMEPAGE_CATEGORIES.find((category) => category.label === label)?.tag;
}

// With zero AI signal, assuming a generic top + bottom beats guessing
// nothing at all — the rest of the pipeline still runs, it just scores
// every candidate low for lack of any real detail to match on (same
// "never crash, just look less personalized" philosophy as
// scoreListingMatch returning 0 for an empty preference set) rather than
// failing the whole request.
const SAFE_DEFAULT: OutfitClassification = {
  items: [
    {
      category: "tops",
      garmentType: "top",
      description: "A top.",
      color: "unknown",
      pattern: null,
      material: null,
      silhouette: "regular fit",
      era: null,
      visualDetails: null,
      searchQueries: ["top"],
    },
    {
      category: "bottoms",
      garmentType: "bottoms",
      description: "A bottom.",
      color: "unknown",
      pattern: null,
      material: null,
      silhouette: "regular fit",
      era: null,
      visualDetails: null,
      searchQueries: ["bottoms"],
    },
  ],
  categories: ["tops", "bottoms"],
  aestheticTags: [],
};

function uniqueCategories(items: DetectedGarment[]): OutfitCategory[] {
  const seen: OutfitCategory[] = [];
  for (const item of items) {
    if (!seen.includes(item.category)) seen.push(item.category);
  }
  return seen;
}

/**
 * Classifies an uploaded outfit photo. Never throws — any failure
 * (missing API key, network error, malformed response) is caught and
 * logged, returning SAFE_DEFAULT so a submission is never blocked by
 * this step.
 */
export async function classifyOutfitPhoto(
  imageUrl: string,
  inspoText?: string | null,
): Promise<OutfitClassification> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.log("[Outfit Classification] Using SAFE_DEFAULT fallback");
    debugLog("Failed - using safe default (OPENAI_API_KEY is not set)");
    return SAFE_DEFAULT;
  }

  try {
    const client = new OpenAI({ apiKey, timeout: REQUEST_TIMEOUT_MS });
    const model = process.env.OPENAI_OUTFIT_CLASSIFICATION_MODEL || DEFAULT_MODEL;
    console.log(`[Outfit Classification] Using OpenAI vision model (${model})`);

    const completion = await client.chat.completions.parse({
      model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: [
            { type: "text", text: inspoText?.trim() || "No additional notes provided." },
            { type: "image_url", image_url: { url: imageUrl } },
          ],
        },
      ],
      response_format: zodResponseFormat(OutfitClassificationSchema, "outfit_classification"),
    });

    const parsed = completion.choices[0]?.message?.parsed;
    if (!parsed) {
      throw new Error("no parsed output returned");
    }

    const aestheticTags = parsed.aesthetic_tags.map(toCanonicalTag).filter((tag): tag is string => Boolean(tag));

    const items: DetectedGarment[] = parsed.items.map((item) => ({
      category: item.category,
      garmentType: item.garment_type,
      description: item.description,
      color: item.color,
      pattern: item.pattern,
      material: item.material,
      silhouette: item.silhouette,
      era: item.era,
      visualDetails: item.visual_details,
      searchQueries: item.search_queries,
    }));

    const result: OutfitClassification = {
      items: items.length > 0 ? items : SAFE_DEFAULT.items,
      categories: items.length > 0 ? uniqueCategories(items) : SAFE_DEFAULT.categories,
      aestheticTags,
    };

    debugLog(
      `Success (items=${result.items.map((item) => item.garmentType).join(", ") || "none"} categories=${result.categories.join(",")} tags=${aestheticTags.join(",") || "none"})`,
    );

    return result;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.log("[Outfit Classification] Using SAFE_DEFAULT fallback");
    debugLog(`Failed - using safe default (${reason})`);
    return SAFE_DEFAULT;
  }
}
