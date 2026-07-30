// AI-Powered Outfit Creation — Part 1: the inspiration photo(s) are the
// PRIMARY signal for a style bundle, not text/categories/budget (which
// this file treats as secondary context only, folded into the prompt as
// supporting detail, never as a substitute for actually looking at the
// image). Modeled on this codebase's existing vision callers
// (src/lib/outfit-classification.ts for the single-photo case,
// src/lib/style-me-classification.ts for the multi-photo case) — same
// conventions: gpt-4o-mini default, 15s timeout, single attempt, never
// throws, returns null (not a fabricated guess) on any failure. This is
// deliberately a NEW module, not a rewrite of either of those: this one
// is scoped to Style Bundles' own richer output shape (aesthetic +
// outfit_description + shopping_strategy alongside per-item detection),
// which neither existing classifier produces.
import OpenAI, { APIError } from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import { z } from "zod";
import { GARMENT_CATEGORIES, type GarmentCategory } from "@/lib/garment-detection";
import { IMAGE_TAG_VOCABULARY } from "@/lib/image-tagging";

export interface BundleDetectedItem {
  category: GarmentCategory;
  garmentType: string;
  color: string | null;
  material: string | null;
  silhouette: string | null;
  pattern: string | null;
  era: string | null;
  styleTags: string[];
}

export interface StyleBundleAnalysis {
  aesthetic: string[];
  outfitDescription: string;
  detectedItems: BundleDetectedItem[];
  shoppingStrategy: string;
  // Overall-image signal, filled in independently of detectedItems — an
  // aesthetic/mood-board-style photo can legitimately yield zero discrete
  // garments while still clearly reading as "teal, black, fitted
  // silhouettes." bundle-generation.ts's vibe-based fallback (see its own
  // buildVibeFallbackItems) uses these two fields plus `aesthetic` to
  // build a shoppable capsule when detectedItems comes back empty,
  // instead of failing the whole request.
  dominantColors: string[];
  silhouettes: string[];
}

export interface StyleBundleAnalysisInput {
  // Highest-weight signal — see this file's own header comment. At least
  // one required; analyzeBundleInspiration returns null without one,
  // same as it would for any other failure (see that function's own
  // comment on why this never fabricates an analysis).
  imageUrls: string[];
  // Secondary — supporting context only, folded into the prompt as notes
  // alongside the image(s), never a substitute for them.
  inspoText?: string | null;
  categories?: string[];
  budget?: number | null;
}

const BundleDetectedItemSchema = z.object({
  category: z.enum(GARMENT_CATEGORIES),
  garment_type: z.string(),
  color: z.string().nullable(),
  material: z.string().nullable(),
  silhouette: z.string().nullable(),
  pattern: z.string().nullable(),
  era: z.string().nullable(),
  style_tags: z.array(z.string()),
});

const StyleBundleAnalysisSchema = z.object({
  aesthetic: z.array(z.enum(IMAGE_TAG_VOCABULARY)),
  outfit_description: z.string(),
  detected_items: z.array(BundleDetectedItemSchema),
  shopping_strategy: z.string(),
  // Always filled in, even when detected_items ends up empty — see this
  // field's twin comment on StyleBundleAnalysis.dominantColors above.
  dominant_colors: z.array(z.string()),
  silhouettes: z.array(z.string()),
});

const SYSTEM_PROMPT = `You are a personal stylist for Lockette, a secondhand clothing marketplace, breaking down an outfit inspiration photo (e.g. a Pinterest pin, a screenshot, a photo of a real outfit) into a shoppable plan.

CRITICAL: The image(s) are your primary source of truth. Any notes the user typed are supporting context only — use them to disambiguate what you see (e.g. "I run cold" might explain a layering piece), never as a substitute for actually looking at the photo. If the notes and the image seem to disagree, trust the image.

Identify EVERY visible wearable item in the outfit — tops, bottoms, outerwear, dresses, shoes, bags, and accessories are all equally important to find, not just the most obvious piece. Never merge multiple items into one entry, never skip one because it seems secondary.

Look hard before concluding an item isn't there. Garments show up in many forms — all of these count and should be reported under the category noted:
- tops: shirts, blouses, corsets, corset tops, bustiers, tanks, camisoles, crop tops, bodysuits
- dresses: any one-piece garment covering torso and legs
- bottoms: skirts, pants, jeans, trousers, shorts, leggings
- outerwear: jackets, sweaters, cardigans, coats, hoodies, blazers
- shoes: any visible footwear, even a single partially-cropped shoe
- bags: purses, totes, backpacks, clutches
- accessories: jewelry (necklaces, earrings, rings, bracelets), belts, scarves, hats, sunglasses, and anything else worn or carried that isn't clothing, a bag, or shoes

Keep looking even when the photo makes it harder:
- Partial visibility — if only a sleeve, hem, or strap is visible, report the item anyway with your best-guess garment_type and mark uncertain fields (color, material, pattern) null rather than skipping the item entirely.
- Pinterest-style/screenshot photos — these often crop tightly, have overlaid text/watermarks, or show only part of a body; analyze whatever garment area IS visible.
- Worn by a person — treat the person as a mannequin for the clothing; describe the garment itself, never the person's body or appearance.
- Aesthetic/vibe-focused images (a mood board, a flat-lay of accessories/objects, a color-palette-style photo) — if there's genuinely no wearable item to identify, it's correct to return an empty detected_items list, but still fill in aesthetic, dominant_colors, silhouettes, and outfit_description from whatever IS visible (colors, textures, styling cues) so a vibe-based bundle can still be built. An empty detected_items list should be rare — only when the image truly has no discernible clothing, not a shortcut for a photo that's merely difficult.

For EACH detected item, return:
- category: one of [${GARMENT_CATEGORIES.join(", ")}].
- garment_type: the specific, concrete name (e.g. "low rise jeans", "baby tee", "shoulder bag", "corset top") — never a vague restatement of the category.
- color: the item's primary color(s) — null if truly indeterminate.
- material: the visible or likely fabric (e.g. "denim", "cotton jersey") — null if not determinable.
- silhouette: the fit/cut (e.g. "low-rise", "cropped", "oversized") — null if not clear.
- pattern: the pattern if any (e.g. "floral", "striped", "solid") — null if none is visible.
- era: the likely style era if it clearly reads as one (e.g. "Y2K", "90s") — null if it doesn't read as any particular era.
- style_tags: 2-5 short, concrete descriptors for this specific item (e.g. ["Y2K", "streetwear"]) — not generic filler words.

Also return, describing the outfit/image AS A WHOLE (fill these in regardless of how many discrete items you found above — they're the fallback signal for a vibe-based bundle when detected_items is empty):
- aesthetic: 0-3 overall tags from [${IMAGE_TAG_VOCABULARY.join(", ")}] that genuinely fit the WHOLE outfit — never invent a tag outside this list.
- dominant_colors: 1-5 colors that define the overall look (e.g. ["teal", "black"]) — your best read even if no single item was confidently identified.
- silhouettes: 1-5 fit/cut/shape words that describe the overall look (e.g. ["fitted", "cropped", "oversized"]) — your best read even if no single item was confidently identified.
- outfit_description: one or two sentences describing the outfit as a whole, in plain language a shopper would recognize.
- shopping_strategy: one or two sentences of practical guidance for sourcing this outfit secondhand — e.g. which pieces are easiest to find close matches for, which are more distinctive and worth prioritizing, how the stated budget (if any) should be split across pieces.

Respond only with the structured fields — no extra commentary.`;

function debugLog(message: string): void {
  console.warn(`[style-bundle-analysis] ${message}`);
}

const isDev = process.env.NODE_ENV !== "production";

// Development-only diagnostics around the OpenAI vision call — request
// outcome, the OpenAI error type/status when it fails, and the shape of
// whatever the model returned. Deliberately NEVER includes: the API key,
// the inspiration image URLs (signed Supabase URLs carry a short-lived
// access token — logging them would leak it), or any user-typed text
// (inspoText) — only counts/metadata and the AI's own structured output,
// none of which is sensitive.
function logDev(message: string, details: Record<string, unknown>): void {
  if (!isDev) return;
  console.log(`[style-bundle-analysis] ${message}`, details);
}

// Distills a caught error into a loggable {type, status, message} without
// ever assuming the shape of an arbitrary thrown value.
function describeError(error: unknown): { type: string; status: number | undefined; message: string } {
  if (error instanceof APIError) {
    return { type: error.constructor.name, status: error.status, message: error.message };
  }
  if (error instanceof Error) {
    return { type: error.name, status: undefined, message: error.message };
  }
  return { type: "UnknownError", status: undefined, message: String(error) };
}

const DEFAULT_MODEL = "gpt-4o-mini";
const REQUEST_TIMEOUT_MS = 15_000;

function buildNotes(input: StyleBundleAnalysisInput): string {
  const parts: string[] = [];
  if (input.inspoText?.trim()) parts.push(`User notes: ${input.inspoText.trim()}`);
  if (input.categories && input.categories.length > 0) parts.push(`Categories of interest: ${input.categories.join(", ")}`);
  if (input.budget != null) parts.push(`Total budget: $${input.budget}`);
  return parts.length > 0 ? parts.join("\n") : "No additional notes provided.";
}

/**
 * Analyzes one or more inspiration photos into a shoppable outfit
 * breakdown. Returns null (never a fabricated analysis) if there are no
 * images, OPENAI_API_KEY isn't configured, or the call fails for any
 * reason — same "never block, never fake it" convention as every other
 * vision caller in this codebase.
 */
export async function analyzeBundleInspiration(input: StyleBundleAnalysisInput): Promise<StyleBundleAnalysis | null> {
  if (input.imageUrls.length === 0) {
    debugLog("Failed - no analysis (no inspiration images provided)");
    return null;
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    debugLog("Failed - no analysis (OPENAI_API_KEY is not set)");
    return null;
  }

  const model = process.env.OPENAI_BUNDLE_ANALYSIS_MODEL || DEFAULT_MODEL;

  try {
    const client = new OpenAI({ apiKey, timeout: REQUEST_TIMEOUT_MS });

    const completion = await client.chat.completions.parse({
      model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: [
            { type: "text", text: buildNotes(input) },
            ...input.imageUrls.map((url) => ({ type: "image_url" as const, image_url: { url } })),
          ],
        },
      ],
      response_format: zodResponseFormat(StyleBundleAnalysisSchema, "style_bundle_analysis"),
    });

    const parsed = completion.choices[0]?.message?.parsed;
    const refusal = completion.choices[0]?.message?.refusal;
    if (!parsed) throw new Error(refusal ? `model refused: ${refusal}` : "no parsed output returned");

    const result: StyleBundleAnalysis = {
      aesthetic: parsed.aesthetic,
      outfitDescription: parsed.outfit_description,
      shoppingStrategy: parsed.shopping_strategy,
      dominantColors: parsed.dominant_colors,
      silhouettes: parsed.silhouettes,
      detectedItems: parsed.detected_items.map((item) => ({
        category: item.category,
        garmentType: item.garment_type,
        color: item.color,
        material: item.material,
        silhouette: item.silhouette,
        pattern: item.pattern,
        era: item.era,
        styleTags: item.style_tags,
      })),
    };

    debugLog(`Success (${result.detectedItems.length} items: ${result.detectedItems.map((i) => i.garmentType).join(", ")})`);
    // Dev-only: the full returned structure — not just the summary line
    // above — since diagnosing "why did the model return 0 items" (or a
    // wrongly-categorized item) needs every field it filled in. Counts
    // and metadata only; never the request's images or user-typed notes.
    logDev("OpenAI vision call succeeded", {
      model,
      imageCount: input.imageUrls.length,
      itemCount: result.detectedItems.length,
      detectedItems: result.detectedItems,
      aesthetic: result.aesthetic,
      dominantColors: result.dominantColors,
      silhouettes: result.silhouettes,
    });
    return result;
  } catch (error) {
    const { type, status, message } = describeError(error);
    debugLog(`Failed - no analysis (${message})`);
    logDev("OpenAI vision call failed", { model, imageCount: input.imageUrls.length, errorType: type, status, message });
    return null;
  }
}
