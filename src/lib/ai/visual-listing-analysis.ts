// Part 7 of the AI inventory architecture — richer, array-based visual
// analysis than src/lib/listing-enrichment.ts's enrichListingMetadata
// (which stays exactly as it is; every existing caller — bulk-import.ts,
// /api/import-listing/route.ts, admin-scraper.ts — is unaffected). That
// function already covers this same ground (category/garment_type/
// material/pattern/silhouette/color/fit/era/brand/styleTags) via a real
// OpenAI vision call — this file is a NEW, additive function built the
// same way (same model, same "image is the primary source of truth"
// framing) but returning the fuller, array-valued shape Part 7 asks for
// (colors/patterns/materials/silhouette/fit as arrays, not one value
// each) plus a confidence score, for the inventory-indexer's own
// enrichment queue (Part 6) to write into listings.visual_analysis
// (Part 8) — not a replacement for the existing enrichment path.
import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import { z } from "zod";
import { GARMENT_CATEGORIES } from "@/lib/garment-detection";
import type { GarmentCategory } from "@/lib/garment-detection";

const VisualListingAnalysisSchema = z.object({
  category: z.enum(GARMENT_CATEGORIES),
  garment_type: z.array(z.string()),
  colors: z.array(z.string()),
  patterns: z.array(z.string()),
  materials: z.array(z.string()),
  silhouette: z.array(z.string()),
  fit: z.array(z.string()),
  era: z.string(),
  aesthetic_tags: z.array(z.string()),
  style_attributes: z.array(z.string()),
  confidence: z.number(),
});

export interface VisualListingAnalysis {
  category: GarmentCategory;
  garment_type: string[];
  colors: string[];
  patterns: string[];
  materials: string[];
  silhouette: string[];
  fit: string[];
  era: string;
  aesthetic_tags: string[];
  style_attributes: string[];
  confidence: number;
}

const SYSTEM_PROMPT = `You are a fashion visual-analysis system for Lockette, a secondhand clothing marketplace. The IMAGE is the primary source of truth — the title/description are only supporting context, never a substitute for what the photo actually shows.

Analyze the garment's photo and return:
- category: one of [${GARMENT_CATEGORIES.join(", ")}].
- garment_type: specific concrete item name(s) (e.g. ["cardigan"], ["mini skirt"]) — never a vague restatement of category.
- colors: every visually distinct color present, most dominant first.
- patterns: any patterns visible (e.g. "floral", "striped", "plaid") — empty array if solid/no pattern.
- materials: visible or likely fabric/material(s) (e.g. "denim", "leather", "knit").
- silhouette: cut/silhouette descriptor(s) (e.g. "oversized", "A-line", "cropped").
- fit: fit descriptor(s) (e.g. "relaxed", "slim", "high-waisted").
- era: a single decade/era label if the piece evokes one (e.g. "90s", "Y2K", "contemporary" if none applies).
- aesthetic_tags: broad aesthetic/vibe tags this piece fits (e.g. "streetwear", "cottagecore").
- style_attributes: specific named aesthetics/subcultures this piece could style into, from real fashion vocabulary — examples: "90s minimalist", "coastal grandmother", "Y2K feminine", "streetwear", "old money", "bohemian", "dark academia". Use terms like these, not generic adjectives.
- confidence: 0-1, your own confidence in this analysis given image clarity/angle/lighting.

Respond only with the structured fields — no extra commentary.`;

const MODEL = "gpt-4o-mini";
const TIMEOUT_MS = 15_000;

/**
 * Never throws — returns null on any failure (no image, no API key, a
 * failed/malformed model response), same "never fabricate structured
 * data" posture as generateImageEmbedding (src/lib/image-similarity.ts).
 */
export async function analyzeListingVisually(
  listing: { title: string; description: string | null; image_url: string | null },
): Promise<VisualListingAnalysis | null> {
  if (!listing.image_url) {
    console.warn("[visual-listing-analysis] No image_url — skipping.");
    return null;
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.warn("[visual-listing-analysis] OPENAI_API_KEY is not set — skipping.");
    return null;
  }

  try {
    const client = new OpenAI({ apiKey, timeout: TIMEOUT_MS });
    const model = process.env.OPENAI_VISUAL_ANALYSIS_MODEL || MODEL;
    const notes = [listing.title, listing.description].filter(Boolean).join(" — ") || "No listing text provided.";

    const completion = await client.chat.completions.parse({
      model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: [
            { type: "text", text: notes },
            { type: "image_url", image_url: { url: listing.image_url } },
          ],
        },
      ],
      response_format: zodResponseFormat(VisualListingAnalysisSchema, "visual_listing_analysis"),
    });

    const parsed = completion.choices[0]?.message?.parsed;
    if (!parsed) throw new Error("no parsed output returned");

    console.log(
      `[visual-listing-analysis] Analyzed "${listing.title}" — category=${parsed.category}, confidence=${parsed.confidence}`,
    );

    return parsed;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`[visual-listing-analysis] Failed for "${listing.title}":`, reason);
    return null;
  }
}
