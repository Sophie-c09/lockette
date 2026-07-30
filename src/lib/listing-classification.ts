// AI enrichment step for the admin importer (/admin/import), run after
// extraction (src/lib/listing-extraction.ts) and before saving. Given the
// raw extracted signal, asks an OpenAI model to normalize/predict a small
// set of fashion fields against a fixed vocabulary, using OpenAI's
// structured-output mode (via Zod) so the response is guaranteed to match
// the shape below rather than needing hand-rolled JSON parsing.
//
// Never throws: any failure (missing API key, network error, malformed
// response) is caught and logged, and classifyListing() returns null so
// the caller falls back to the original, unclassified listing. Importing
// a listing should never be blocked by this step.
import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import { z } from "zod";
import type { ExtractedListing } from "@/lib/listing-extraction";

export const CATEGORY_VOCABULARY = [
  "tops",
  "bottoms",
  "dresses",
  "outerwear",
  "shoes",
  "accessories",
  "jewelry",
  "bags",
] as const;

export const AESTHETIC_TAG_VOCABULARY = [
  "Y2K",
  "Vintage",
  "90s",
  "2000s",
  "Streetwear",
  "Old Money",
  "Coquette",
  "Cottagecore",
  "Grunge",
  "Minimalist",
  "Preppy",
  "Boho",
  "Balletcore",
  "Punk",
] as const;

export const STYLE_ERA_VOCABULARY = [
  "50s",
  "60s",
  "70s",
  "80s",
  "90s",
  "2000s",
  "Contemporary",
  "Unknown",
] as const;

export interface ListingClassificationInput {
  title: string;
  description: string | null;
  brand: string | null;
  category: string | null;
  color: string | null;
  size: string | null;
  aesthetic_tags: string[];
}

export interface ListingClassificationResult {
  category: (typeof CATEGORY_VOCABULARY)[number] | null;
  color: string | null;
  aesthetic_tags: (typeof AESTHETIC_TAG_VOCABULARY)[number][];
  style_era: (typeof STYLE_ERA_VOCABULARY)[number];
  // No fixed vocabulary was specified for this field — left as a
  // model-described free-form string (with examples in the prompt) rather
  // than inventing an unrequested enum.
  fit: string | null;
  brand: string | null;
}

// `strict` structured-output mode requires every key to be present on
// every response (no `.optional()`) — absence is expressed as `.nullable()`
// instead, which is why category/color/fit/brand are typed as such below.
const ClassificationSchema = z.object({
  category: z.enum(CATEGORY_VOCABULARY).nullable(),
  color: z.string().nullable(),
  aesthetic_tags: z.array(z.enum(AESTHETIC_TAG_VOCABULARY)),
  style_era: z.enum(STYLE_ERA_VOCABULARY),
  fit: z.string().nullable(),
  brand: z.string().nullable(),
});

const SYSTEM_PROMPT = `You are a fashion cataloging assistant for Lockette, a secondhand clothing marketplace. Given a scraped thrift listing, classify it for the catalog.

Rules:
- category: pick exactly one from [${CATEGORY_VOCABULARY.join(", ")}]. If genuinely unclear, use your best guess from the list — never invent a category outside it.
- color: the single most dominant garment color, as a plain word (e.g. "black", "olive green"). Null only if truly unknowable from the given text.
- aesthetic_tags: 0-4 tags from [${AESTHETIC_TAG_VOCABULARY.join(", ")}] that genuinely fit; an empty list is fine if nothing clearly applies. Never invent tags outside this list.
- style_era: pick exactly one from [${STYLE_ERA_VOCABULARY.join(", ")}]. Use "Contemporary" for clearly modern/current pieces and "Unknown" only when there's truly no signal.
- fit: a short, free-form garment fit descriptor (e.g. "Oversized", "Slim", "Regular", "Cropped", "Boxy", "Relaxed"), or null if unclear. No fixed list for this one — use your judgement.
- brand: the normalized brand name if one is identifiable from the input, otherwise null. Prefer the existing extracted brand unless the title/description clearly indicates a different or more specific brand.

Base your answer on the title, description, and any existing extracted hints provided. Respond only with the structured fields — no extra commentary.`;

function debugLog(message: string): void {
  console.warn(`[listing-classification] ${message}`);
}

const DEFAULT_MODEL = "gpt-4o-mini";
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Classifies a listing's fashion metadata using OpenAI structured output.
 * Returns null (never throws) if OpenAI isn't configured or the call
 * fails for any reason — callers should treat null as "keep the original
 * listing unchanged."
 */
export async function classifyListing(
  input: ListingClassificationInput,
): Promise<ListingClassificationResult | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    debugLog("Failed - using original listing (OPENAI_API_KEY is not set)");
    return null;
  }

  try {
    const client = new OpenAI({ apiKey, timeout: REQUEST_TIMEOUT_MS });
    const model = process.env.OPENAI_CLASSIFICATION_MODEL || DEFAULT_MODEL;

    const completion = await client.chat.completions.parse({
      model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: JSON.stringify(input) },
      ],
      response_format: zodResponseFormat(ClassificationSchema, "listing_classification"),
    });

    const parsed = completion.choices[0]?.message?.parsed;
    if (!parsed) {
      debugLog("Failed - using original listing (no parsed output returned)");
      return null;
    }

    debugLog("Success");
    return parsed;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    debugLog(`Failed - using original listing (${reason})`);
    return null;
  }
}

const ClassificationBatchSchema = z.object({
  results: z.array(ClassificationSchema),
});

const BATCH_SYSTEM_PROMPT = `You are a fashion cataloging assistant for Lockette, a secondhand clothing marketplace. You will be given a JSON array of scraped thrift listings. Classify EACH one independently for the catalog, using the exact same rules for every listing:

- category: pick exactly one from [${CATEGORY_VOCABULARY.join(", ")}]. If genuinely unclear, use your best guess from the list — never invent a category outside it.
- color: the single most dominant garment color, as a plain word (e.g. "black", "olive green"). Null only if truly unknowable from the given text.
- aesthetic_tags: 0-4 tags from [${AESTHETIC_TAG_VOCABULARY.join(", ")}] that genuinely fit; an empty list is fine if nothing clearly applies. Never invent tags outside this list.
- style_era: pick exactly one from [${STYLE_ERA_VOCABULARY.join(", ")}]. Use "Contemporary" for clearly modern/current pieces and "Unknown" only when there's truly no signal.
- fit: a short, free-form garment fit descriptor (e.g. "Oversized", "Slim", "Regular", "Cropped", "Boxy", "Relaxed"), or null if unclear. No fixed list for this one — use your judgement.
- brand: the normalized brand name if one is identifiable from the input, otherwise null. Prefer the existing extracted brand unless the title/description clearly indicates a different or more specific brand.

Base each listing's answer ONLY on that listing's own title/description/extracted hints — never let one listing's content influence another's classification.

Return exactly one result per input listing, in the SAME ORDER as the input array — never skip, merge, or reorder any. Respond only with the structured fields — no extra commentary.`;

function debugLogBatch(message: string): void {
  console.warn(`[listing-classification-batch] ${message}`);
}

// Scales with batch size (more listings -> more tokens to process) rather
// than reusing the single-item REQUEST_TIMEOUT_MS outright, which would
// risk a premature timeout on a bigger batch; capped so a pathologically
// large batch can't hang indefinitely.
function batchTimeoutMs(batchSize: number): number {
  return Math.min(45_000, REQUEST_TIMEOUT_MS * Math.max(1, batchSize));
}

/**
 * Classifies multiple listings in ONE OpenAI call instead of one call per
 * listing — same rules/vocabulary/output shape as classifyListing, just
 * batched to cut round-trip overhead when scoring many candidates at once
 * (see src/lib/admin-scraper.ts, the only caller that needs this). Returns
 * one result per input, in the same order, `null` for any listing that
 * couldn't be classified — never throws.
 *
 * Falls back to per-item classifyListing calls (same "never lose good
 * data to a batch failure" reasoning as admin-scraper.ts's own DB
 * chunk-insert fallback) if the batch call fails outright or the model
 * returns a mismatched result count.
 */
export async function classifyListingsBatch(
  inputs: ListingClassificationInput[],
): Promise<(ListingClassificationResult | null)[]> {
  if (inputs.length === 0) return [];
  if (inputs.length === 1) return [await classifyListing(inputs[0])];

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    debugLogBatch(`Failed - using original listings (OPENAI_API_KEY is not set), batch size ${inputs.length}`);
    return inputs.map(() => null);
  }

  try {
    const client = new OpenAI({ apiKey, timeout: batchTimeoutMs(inputs.length) });
    const model = process.env.OPENAI_CLASSIFICATION_MODEL || DEFAULT_MODEL;

    const completion = await client.chat.completions.parse({
      model,
      messages: [
        { role: "system", content: BATCH_SYSTEM_PROMPT },
        { role: "user", content: JSON.stringify(inputs) },
      ],
      response_format: zodResponseFormat(ClassificationBatchSchema, "listing_classification_batch"),
    });

    const parsed = completion.choices[0]?.message?.parsed;
    if (!parsed || parsed.results.length !== inputs.length) {
      debugLogBatch(
        `Failed - falling back to per-item classification (${
          !parsed ? "no parsed output" : `got ${parsed.results.length} results, expected ${inputs.length}`
        })`,
      );
      return Promise.all(inputs.map((input) => classifyListing(input)));
    }

    debugLogBatch(`Success (${inputs.length} listings, 1 call)`);
    return parsed.results;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    debugLogBatch(`Failed - falling back to per-item classification (${reason})`);
    return Promise.all(inputs.map((input) => classifyListing(input)));
  }
}

// Merges a classification result into an already-extracted listing.
// Compatible with the existing `listings` table: only fields that already
// have a column (category, color, aesthetic_tags, brand) are merged in.
// `style_era` and `fit` have no matching column yet, so they're logged for
// visibility but not persisted — add columns for them later if you want to
// store them.
export function applyClassification(
  listing: ExtractedListing,
  classification: ListingClassificationResult | null,
): ExtractedListing {
  if (!classification) return listing;

  debugLog(
    `style_era=${classification.style_era} fit=${classification.fit ?? "null"} ` +
      "(not stored — no matching column on `listings` yet)",
  );

  return {
    ...listing,
    category: classification.category ?? listing.category,
    color: classification.color ?? listing.color,
    aesthetic_tags:
      classification.aesthetic_tags.length > 0
        ? classification.aesthetic_tags
        : listing.aesthetic_tags,
    brand: classification.brand ?? listing.brand,
  };
}
