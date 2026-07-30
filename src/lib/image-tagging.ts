// AI image-tagging step for the admin importer (/admin/import) — a second,
// independent tagging signal alongside the existing text-based tagging
// (src/lib/extraction/infer-aesthetic-tags.ts) and text-based AI
// classification (src/lib/listing-classification.ts). Given a listing's
// image, asks an OpenAI vision model to pick 0-3 aesthetic tags from the
// same fixed vocabulary the homepage/Discover filters already key off of
// (src/lib/aesthetic-categories.ts), using structured output (via Zod) so
// the response is guaranteed to match the vocabulary rather than needing
// hand-rolled JSON-text parsing — the same pattern listing-classification.ts
// already uses for its text-based call.
//
// The vocabulary here is deliberately the same six aesthetics as
// HOMEPAGE_CATEGORIES, not the larger AESTHETIC_TAG_VOCABULARY in
// listing-classification.ts — those are the only tags Discover/the
// homepage actually filter on, so image-derived tags outside that set
// would be invisible to both. Tags are mapped back to their canonical
// `#`-prefixed form (e.g. "Y2K" -> "#Y2K") via HOMEPAGE_CATEGORIES itself,
// so the two files can never drift out of casing sync.
//
// Never throws: any failure (missing API key, network error, malformed
// response) is caught and logged, and generateImageTags() returns an empty
// array so the caller falls back to whatever text-based tags it already
// had. Importing a listing should never be blocked by this step.
import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import { z } from "zod";
import { HOMEPAGE_CATEGORIES } from "@/lib/aesthetic-categories";

export const IMAGE_TAG_VOCABULARY = [
  "Y2K",
  "Vintage",
  "Coquette",
  "Indie Sleaze",
  "Streetwear",
  "Cottagecore",
] as const;

const ImageTagsSchema = z.object({
  tags: z.array(z.enum(IMAGE_TAG_VOCABULARY)),
});

const SYSTEM_PROMPT = `You are a fashion cataloging assistant for Lockette, a secondhand clothing marketplace. Analyze the clothing item in this image and classify its aesthetic — ignore any surrounding scenery, model, or background.

Rules:
- Return 0-3 tags from [${IMAGE_TAG_VOCABULARY.join(", ")}] that genuinely fit the garment's look.
- An empty list is fine if nothing in the list clearly applies — never invent a tag outside it.
- Base your answer only on what the image shows, not assumptions about the brand or price.`;

function debugLog(message: string): void {
  console.warn(`[image-tagging] ${message}`);
}

const DEFAULT_MODEL = "gpt-4o-mini";
const REQUEST_TIMEOUT_MS = 15_000;

// Safety valve for a model that ignores the "0-3 tags" instruction: the
// Zod schema above can't enforce a max length (structured-output JSON
// schemas don't support minItems/maxItems reliably here, matching why
// listing-classification.ts doesn't attempt it either) so an
// over-generous response is trimmed in code instead of being rejected
// outright — rejecting it would throw away a perfectly usable result over
// a minor over-count. More than 3 tags reads as low-confidence/scattergun
// output, so that case keeps only the first 2 (the model's most confident
// picks, since it lists tags in descending confidence order) rather than
// the first 3.
function limitTagConfidence(tags: string[]): string[] {
  return tags.length > 3 ? tags.slice(0, 2) : tags.slice(0, 3);
}

function toCanonicalTag(label: string): string | undefined {
  return HOMEPAGE_CATEGORIES.find((category) => category.label === label)?.tag;
}

const ImageTagsBatchSchema = z.object({
  results: z.array(ImageTagsSchema),
});

const BATCH_SYSTEM_PROMPT = `You are a fashion cataloging assistant for Lockette, a secondhand clothing marketplace. You will be shown multiple clothing item images, each labeled "Image N". For EACH image independently, analyze the clothing item's aesthetic — ignore any surrounding scenery, model, or background.

Rules (apply identically to every image):
- Return 0-3 tags from [${IMAGE_TAG_VOCABULARY.join(", ")}] that genuinely fit that image's garment.
- An empty list is fine if nothing in the list clearly applies — never invent a tag outside it.
- Base each image's answer only on what that image shows — never let one image influence another's tags.

Return exactly one result per image, in the SAME ORDER the images were shown (Image 1 first, Image 2 second, etc.) — never skip, merge, or reorder any.`;

function debugLogBatch(message: string): void {
  console.warn(`[image-tagging-batch] ${message}`);
}

function batchTimeoutMs(batchSize: number): number {
  return Math.min(45_000, REQUEST_TIMEOUT_MS * Math.max(1, batchSize));
}

/**
 * Tags multiple listing images in ONE OpenAI vision call instead of one
 * call per image — same vocabulary/output shape as generateImageTags,
 * batched to cut round-trip overhead (see src/lib/admin-scraper.ts, the
 * only caller that needs this). Returns one tag array per input URL, in
 * the same order — an empty array for any image that couldn't be tagged,
 * never throws.
 *
 * Falls back to per-item generateImageTags calls if the batch call fails
 * outright or the model returns a mismatched result count — same "never
 * lose good data to a batch failure" reasoning as classifyListingsBatch.
 */
export async function generateImageTagsBatch(imageUrls: string[]): Promise<string[][]> {
  if (imageUrls.length === 0) return [];
  if (imageUrls.length === 1) return [await generateImageTags(imageUrls[0])];

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    debugLogBatch(`Failed - no image tags generated (OPENAI_API_KEY is not set), batch size ${imageUrls.length}`);
    return imageUrls.map(() => []);
  }

  try {
    const client = new OpenAI({ apiKey, timeout: batchTimeoutMs(imageUrls.length) });
    const model = process.env.OPENAI_IMAGE_TAGGING_MODEL || DEFAULT_MODEL;

    const content = imageUrls.flatMap((url, index) => [
      { type: "text" as const, text: `Image ${index + 1}:` },
      { type: "image_url" as const, image_url: { url } },
    ]);

    const completion = await client.chat.completions.parse({
      model,
      messages: [
        { role: "system", content: BATCH_SYSTEM_PROMPT },
        { role: "user", content },
      ],
      response_format: zodResponseFormat(ImageTagsBatchSchema, "image_tags_batch"),
    });

    const parsed = completion.choices[0]?.message?.parsed;
    if (!parsed || parsed.results.length !== imageUrls.length) {
      debugLogBatch(
        `Failed - falling back to per-item tagging (${
          !parsed ? "no parsed output" : `got ${parsed.results.length} results, expected ${imageUrls.length}`
        })`,
      );
      return Promise.all(imageUrls.map((url) => generateImageTags(url)));
    }

    const results = parsed.results.map((result) => {
      const limited = limitTagConfidence(result.tags);
      return limited.map(toCanonicalTag).filter((tag): tag is string => Boolean(tag));
    });

    debugLogBatch(`Success (${imageUrls.length} images, 1 call)`);
    return results;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    debugLogBatch(`Failed - falling back to per-item tagging (${reason})`);
    return Promise.all(imageUrls.map((url) => generateImageTags(url)));
  }
}

/**
 * Generates aesthetic tags for a listing image using an OpenAI vision
 * model, in the same canonical `#`-prefixed form as HOMEPAGE_CATEGORIES
 * (e.g. "#Y2K", "#Indie Sleaze"). Returns an empty array (never throws) if
 * OpenAI isn't configured or the call fails for any reason — callers
 * should treat an empty array as "no image-derived tags," not an error.
 */
export async function generateImageTags(imageUrl: string): Promise<string[]> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    debugLog("Failed - no image tags generated (OPENAI_API_KEY is not set)");
    return [];
  }

  try {
    const client = new OpenAI({ apiKey, timeout: REQUEST_TIMEOUT_MS });
    const model = process.env.OPENAI_IMAGE_TAGGING_MODEL || DEFAULT_MODEL;

    const completion = await client.chat.completions.parse({
      model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: [{ type: "image_url", image_url: { url: imageUrl } }],
        },
      ],
      response_format: zodResponseFormat(ImageTagsSchema, "image_tags"),
    });

    const parsed = completion.choices[0]?.message?.parsed;
    if (!parsed) {
      debugLog("Failed - no image tags generated (no parsed output returned)");
      return [];
    }

    const limited = limitTagConfidence(parsed.tags);
    const canonicalTags = limited
      .map(toCanonicalTag)
      .filter((tag): tag is string => Boolean(tag));

    debugLog(`Success (${canonicalTags.join(", ") || "no tags"})`);
    return canonicalTags;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    debugLog(`Failed - no image tags generated (${reason})`);
    return [];
  }
}
