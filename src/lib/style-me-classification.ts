// AI classification for Style Me — given a user's MULTIPLE inspiration
// photos (+ optional text), identifies EVERY recurring garment/accessory
// across ALL of them with rich structured detail
// (src/lib/garment-detection.ts) in a single OpenAI call (the model does
// the cross-image aggregation itself, rather than classifying each image
// separately and merging results in code). Same conventions as
// src/lib/outfit-classification.ts: gpt-4o-mini default, 15s timeout,
// single attempt, never throws, always returns a safe default.
//
// UPGRADE (reverse-image-search accuracy): this used to output only a
// coarse `categories: CategoryBucket[]` list plus a loose `dominantStyles`
// aesthetic signal — matching against that meant aesthetic-tag overlap
// alone decided which listing won each category, the same "vibe beats
// garment" problem src/lib/outfit-classification.ts had. `items` now
// carries one DetectedGarment per recurring piece (specific garment type,
// color, pattern, material, silhouette, era, resale search queries) — see
// src/lib/garment-matching.ts for how that drives real ranking now.
import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import { z } from "zod";
import { HOMEPAGE_CATEGORIES } from "@/lib/aesthetic-categories";
import { IMAGE_TAG_VOCABULARY } from "@/lib/image-tagging";
import { GARMENT_CATEGORIES, type DetectedGarment, type GarmentCategory } from "@/lib/garment-detection";

export interface StyleAggregateClassification {
  items: DetectedGarment[];
  dominantStyles: string[];
  // Derived from `items` — the unique categories present, first-occurrence
  // order (same "one slot per category" simplification as
  // outfit-classification.ts's own OutfitClassification.categories).
  categories: GarmentCategory[];
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

const StyleAggregateSchema = z.object({
  items: z.array(DetectedGarmentSchema),
  dominant_styles: z.array(z.enum(IMAGE_TAG_VOCABULARY)),
});

const SYSTEM_PROMPT = `You are a fashion cataloging assistant for Lockette, a secondhand clothing marketplace, performing reverse-image search. You'll be shown several inspiration photos (plus any notes the user gave) that together represent one person's style.

CRITICAL: Looking at ALL the photos together, identify EVERY garment type and accessory that recurs or stands out — not just tops and bottoms. Do NOT summarize the overall look instead of naming individual pieces.

Check specifically for items in EACH of these categories, and include every one that's a real recurring part of this person's style:
- tops
- bottoms
- outerwear — sweaters, jackets, cardigans, coats, hoodies, blazers
- dresses
- shoes
- bags — purses, backpacks, totes, clutches
- accessories — jewelry, belts, scarves, sunglasses, hats, and anything else worn or carried that isn't a bag

Pick the items a real curated bundle should include (recurring or clearly representative), not just anything glimpsed once — but never skip a whole category (outerwear, bags, accessories) just because tops/bottoms are the most obvious pieces.

For EACH recurring item, return:
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

Also return dominant_styles: 0-3 tags from [${IMAGE_TAG_VOCABULARY.join(", ")}] that genuinely capture the overall aesthetic across the photos — never invent a tag outside this list, an empty list is fine if none clearly apply.

Respond only with the structured fields — no extra commentary.`;

function debugLog(message: string): void {
  console.warn(`[style-me-classification] ${message}`);
}

const DEFAULT_MODEL = "gpt-4o-mini";
const REQUEST_TIMEOUT_MS = 15_000;

function toCanonicalTag(label: string): string | undefined {
  return HOMEPAGE_CATEGORIES.find((category) => category.label === label)?.tag;
}

// Zero AI signal still needs at least two categories for a bundle to
// make sense at all — same "assume the two most fundamental slots"
// reasoning as outfit-classification.ts's SAFE_DEFAULT.
const SAFE_DEFAULT: StyleAggregateClassification = {
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
  dominantStyles: [],
  categories: ["tops", "bottoms"],
};

function uniqueCategories(items: DetectedGarment[]): GarmentCategory[] {
  const seen: GarmentCategory[] = [];
  for (const item of items) {
    if (!seen.includes(item.category)) seen.push(item.category);
  }
  return seen;
}

/**
 * Classifies a user's aggregated inspiration photos in one call. Never
 * throws — any failure (missing API key, network error, malformed
 * response) is caught and logged, returning SAFE_DEFAULT so a submission
 * is never blocked by this step.
 */
export async function classifyStyleAggregate(
  imageUrls: string[],
  inspoText?: string | null,
): Promise<StyleAggregateClassification> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || imageUrls.length === 0) {
    debugLog(
      !apiKey ? "Failed - using safe default (OPENAI_API_KEY is not set)" : "Failed - using safe default (no images)",
    );
    return SAFE_DEFAULT;
  }

  try {
    const client = new OpenAI({ apiKey, timeout: REQUEST_TIMEOUT_MS });
    const model = process.env.OPENAI_STYLE_ME_MODEL || DEFAULT_MODEL;

    const completion = await client.chat.completions.parse({
      model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: [
            { type: "text", text: inspoText?.trim() || "No additional notes provided." },
            ...imageUrls.map((url) => ({ type: "image_url" as const, image_url: { url } })),
          ],
        },
      ],
      response_format: zodResponseFormat(StyleAggregateSchema, "style_aggregate"),
    });

    const parsed = completion.choices[0]?.message?.parsed;
    if (!parsed) {
      throw new Error("no parsed output returned");
    }

    const dominantStyles = parsed.dominant_styles.map(toCanonicalTag).filter((tag): tag is string => Boolean(tag));

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

    const result: StyleAggregateClassification = {
      items: items.length > 0 ? items : SAFE_DEFAULT.items,
      dominantStyles,
      categories: items.length > 0 ? uniqueCategories(items) : SAFE_DEFAULT.categories,
    };

    debugLog(
      `Success (items=${result.items.map((item) => item.garmentType).join(", ") || "none"} styles=${dominantStyles.join(",") || "none"} categories=${result.categories.join(",")})`,
    );

    return result;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    debugLog(`Failed - using safe default (${reason})`);
    return SAFE_DEFAULT;
  }
}
