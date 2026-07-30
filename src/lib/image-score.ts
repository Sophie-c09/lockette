// Image-based outfit-potential scoring for the Style-Aware Admin
// Scraper — a second, visual gate alongside admin-scraper-filter.ts's
// existing text-based style scoring. Same conventions as this
// codebase's other vision callers (image-tagging.ts, listing-quality.ts,
// outfit-classification.ts): gpt-4o-mini default, 15s timeout, single
// attempt, `chat.completions.parse` + zodResponseFormat, never throws.
//
// One deliberate departure from that shared convention: every other
// vision caller's "safe default" is a NEUTRAL/PASSING one (e.g.
// listing-quality.ts explicitly returns max scores on failure, "an
// unconfigured API key or a transient failure must never turn into
// every bulk-imported listing gets auto-rejected"). The same applies
// here even more directly, since admin-scraper-filter.ts hard-rejects
// anything below a score threshold — a failing default here would
// silently reject 100% of candidates the moment OPENAI_API_KEY is
// unset or one request times out. The safe default is a passing score
// with confidence: 0, so a caller that cares can tell it's not a real
// assessment.
import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import { z } from "zod";

// Non-exhaustive, fixed vocabularies (not free text) — same reasoning as
// image-tagging.ts's IMAGE_TAG_VOCABULARY: constraining the model's
// output to values this module's own boost/penalty logic (see below)
// actually checks for is what makes that logic reliable, rather than
// hoping free-text phrasing happens to match.
const IMAGE_VISUAL_TAG_OPTIONS = [
  "lace",
  "layered",
  "fitted",
  "flowy",
  "sheer",
  "cropped",
  "distressed",
  "boxy",
  "bulky",
  "wrinkled",
  "cheap",
] as const;

const VISUAL_AESTHETIC_OPTIONS = [
  "boho",
  "y2k",
  "basic",
  "streetwear",
  "preppy",
  "grunge",
  "cottagecore",
  "minimalist",
] as const;

// Fills a real gap in the original spec: "prioritize model photos /
// styled outfits, not flat lays" (Step 6) needs a signal to key a boost
// off of, but the given response schema never captured one. Three-way
// rather than a single boolean since "worn by a person" and "styled but
// laid flat" are both distinct from a plain flat lay and both worth
// rewarding.
const PRESENTATION_OPTIONS = ["on_model", "styled_flat_lay", "flat_lay"] as const;

const ImageScoreModelSchema = z.object({
  score: z.number(),
  tags: z.array(z.enum(IMAGE_VISUAL_TAG_OPTIONS)),
  fit: z.enum(["tight", "oversized", "boxy"]),
  aesthetic: z.array(z.enum(VISUAL_AESTHETIC_OPTIONS)),
  confidence: z.number(),
  presentation: z.enum(PRESENTATION_OPTIONS),
});

export interface ImageScoreResult {
  // Final score AFTER the boost/penalty adjustments below — this is
  // what admin-scraper-filter.ts's minImageScore threshold compares
  // against, and what gets persisted as listings.image_score.
  score: number;
  tags: string[];
  fit: "tight" | "oversized" | "boxy";
  aesthetic: string[];
  confidence: number;
}

const SYSTEM_PROMPT = `You are a fashion stylist AI for Lockette, a secondhand clothing marketplace.

Rate this clothing item's outfit potential based ONLY on visual appearance.

Consider:
- Is it styled attractively?
- Could it fit into a Pinterest-style outfit?
- Is it feminine / boho / y2k aesthetic?
- Does it look cheap, bulky, or outdated?
- Would a fashion girl wear this?

Fields:
- score (0-100): overall outfit potential.
- tags: which of [${IMAGE_VISUAL_TAG_OPTIONS.join(", ")}] genuinely apply — never invent a tag outside this list.
- fit: "tight", "oversized", or "boxy" — whichever best describes the garment's silhouette.
- aesthetic: which of [${VISUAL_AESTHETIC_OPTIONS.join(", ")}] genuinely apply — never invent one outside this list, an empty list is fine.
- confidence (0-1): how confident you are in this assessment.
- presentation: "on_model" if a person is wearing it, "styled_flat_lay" if it's arranged as part of a styled outfit shot without a person, or "flat_lay" if it's just the bare item with no styling.

Respond only with the structured fields — no extra commentary.`;

function debugLog(message: string): void {
  console.warn(`[image-score] ${message}`);
}

const DEFAULT_MODEL = "gpt-4o-mini";
const REQUEST_TIMEOUT_MS = 15_000;

// Boost/penalty tuning (Step 5/6 of the spec) — a judgment call, not
// derived from anywhere else in the codebase.
const BOOST_TAGS = ["lace", "layered", "fitted", "flowy"];
const PENALTY_TAGS = ["boxy", "bulky", "wrinkled", "cheap"];
const TAG_ADJUSTMENT = 5;
const STYLED_PRESENTATION_BOOST = 10;

function clampScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function adjustScore(raw: z.infer<typeof ImageScoreModelSchema>): number {
  let score = raw.score;

  for (const tag of raw.tags) {
    if (BOOST_TAGS.includes(tag)) score += TAG_ADJUSTMENT;
    if (PENALTY_TAGS.includes(tag)) score -= TAG_ADJUSTMENT;
  }

  if (raw.presentation === "on_model" || raw.presentation === "styled_flat_lay") {
    score += STYLED_PRESENTATION_BOOST;
  }

  return clampScore(score);
}

// A passing (not failing) score, matching the safe-default reasoning
// above — confidence: 0 marks it as "not a real assessment" for any
// caller that wants to distinguish the two. `fit` has no neutral option
// among its 3 real values (tight/oversized/boxy); "tight" is picked
// arbitrarily rather than fabricating a 4th enum value the real
// schema/column was never meant to hold.
const SAFE_DEFAULT: ImageScoreResult = {
  score: 100,
  tags: [],
  fit: "tight",
  aesthetic: [],
  confidence: 0,
};

// In-memory, per-process cache — a performance optimization (Step 9),
// not a correctness requirement, so it's fine that it's lost on
// redeploy/restart and not shared across serverless instances (worst
// case: a few redundant OpenAI calls for the same URL, never incorrect
// output). No new infrastructure (e.g. Redis) exists in this app to do
// better, and none is needed for a single admin-triggered scrape run.
const scoreCache = new Map<string, ImageScoreResult>();

/**
 * Scores one listing image's outfit potential. Never throws — any
 * failure (missing API key, network error, malformed response) is
 * caught and logged, returning a passing SAFE_DEFAULT so a missing/
 * misbehaving vision call can never silently reject every candidate.
 */
export async function scoreImageOutfitPotential(imageUrl: string): Promise<ImageScoreResult> {
  const cached = scoreCache.get(imageUrl);
  if (cached) return cached;

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    debugLog("Failed - using safe (passing) default (OPENAI_API_KEY is not set)");
    return SAFE_DEFAULT;
  }

  try {
    const client = new OpenAI({ apiKey, timeout: REQUEST_TIMEOUT_MS });
    const model = process.env.OPENAI_IMAGE_SCORE_MODEL || DEFAULT_MODEL;

    const completion = await client.chat.completions.parse({
      model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: [{ type: "image_url", image_url: { url: imageUrl } }],
        },
      ],
      response_format: zodResponseFormat(ImageScoreModelSchema, "image_score"),
    });

    const parsed = completion.choices[0]?.message?.parsed;
    if (!parsed) {
      throw new Error("no parsed output returned");
    }

    const result: ImageScoreResult = {
      score: adjustScore(parsed),
      tags: parsed.tags,
      fit: parsed.fit,
      aesthetic: parsed.aesthetic,
      confidence: parsed.confidence,
    };

    debugLog(`Success (score=${result.score} fit=${result.fit} tags=${result.tags.join(",") || "none"})`);
    scoreCache.set(imageUrl, result);

    return result;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    debugLog(`Failed - using safe (passing) default (${reason})`);
    return SAFE_DEFAULT;
  }
}

const ImageScoreBatchModelSchema = z.object({
  results: z.array(ImageScoreModelSchema),
});

const BATCH_SYSTEM_PROMPT = `You are a fashion stylist AI for Lockette, a secondhand clothing marketplace. You will be shown multiple clothing item images, each labeled "Image N". Rate EACH image's outfit potential independently, based ONLY on visual appearance.

For every image, consider:
- Is it styled attractively?
- Could it fit into a Pinterest-style outfit?
- Is it feminine / boho / y2k aesthetic?
- Does it look cheap, bulky, or outdated?
- Would a fashion girl wear this?

Fields per image:
- score (0-100): overall outfit potential.
- tags: which of [${IMAGE_VISUAL_TAG_OPTIONS.join(", ")}] genuinely apply — never invent a tag outside this list.
- fit: "tight", "oversized", or "boxy" — whichever best describes the garment's silhouette.
- aesthetic: which of [${VISUAL_AESTHETIC_OPTIONS.join(", ")}] genuinely apply — never invent one outside this list, an empty list is fine.
- confidence (0-1): how confident you are in this assessment.
- presentation: "on_model" if a person is wearing it, "styled_flat_lay" if it's arranged as part of a styled outfit shot without a person, or "flat_lay" if it's just the bare item with no styling.

Base each image's answer only on what that image shows — never let one image influence another's rating. Return exactly one result per image, in the SAME ORDER the images were shown (Image 1 first, Image 2 second, etc.) — never skip, merge, or reorder any. Respond only with the structured fields — no extra commentary.`;

function debugLogBatch(message: string): void {
  console.warn(`[image-score-batch] ${message}`);
}

function batchTimeoutMs(batchSize: number): number {
  return Math.min(45_000, REQUEST_TIMEOUT_MS * Math.max(1, batchSize));
}

/**
 * Scores multiple listing images' outfit potential in ONE OpenAI vision
 * call instead of one call per image — same scoring/boost/penalty logic
 * as scoreImageOutfitPotential, batched to cut round-trip overhead (see
 * src/lib/admin-scraper.ts, the only caller that needs this). Checks the
 * shared in-memory cache first (same cache scoreImageOutfitPotential
 * uses) and only batches the uncached URLs; returns one result per input
 * URL, in the same order. Never throws — any failure (missing API key,
 * mismatched result count, network error) falls back to per-item
 * scoreImageOutfitPotential calls, same "never lose good data to a batch
 * failure" reasoning as classifyListingsBatch.
 */
export async function scoreImagesOutfitPotentialBatch(imageUrls: string[]): Promise<ImageScoreResult[]> {
  if (imageUrls.length === 0) return [];

  const results = new Array<ImageScoreResult | undefined>(imageUrls.length);
  const uncachedIndices: number[] = [];
  const uncachedUrls: string[] = [];

  imageUrls.forEach((url, index) => {
    const cached = scoreCache.get(url);
    if (cached) {
      results[index] = cached;
    } else {
      uncachedIndices.push(index);
      uncachedUrls.push(url);
    }
  });

  if (uncachedUrls.length === 0) {
    return results as ImageScoreResult[];
  }

  if (uncachedUrls.length === 1) {
    results[uncachedIndices[0]] = await scoreImageOutfitPotential(uncachedUrls[0]);
    return results as ImageScoreResult[];
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    debugLogBatch(`Failed - using safe (passing) defaults (OPENAI_API_KEY is not set), batch size ${uncachedUrls.length}`);
    for (const index of uncachedIndices) results[index] = SAFE_DEFAULT;
    return results as ImageScoreResult[];
  }

  try {
    const client = new OpenAI({ apiKey, timeout: batchTimeoutMs(uncachedUrls.length) });
    const model = process.env.OPENAI_IMAGE_SCORE_MODEL || DEFAULT_MODEL;

    const content = uncachedUrls.flatMap((url, index) => [
      { type: "text" as const, text: `Image ${index + 1}:` },
      { type: "image_url" as const, image_url: { url } },
    ]);

    const completion = await client.chat.completions.parse({
      model,
      messages: [
        { role: "system", content: BATCH_SYSTEM_PROMPT },
        { role: "user", content },
      ],
      response_format: zodResponseFormat(ImageScoreBatchModelSchema, "image_score_batch"),
    });

    const parsed = completion.choices[0]?.message?.parsed;
    if (!parsed || parsed.results.length !== uncachedUrls.length) {
      debugLogBatch(
        `Failed - falling back to per-item scoring (${
          !parsed ? "no parsed output" : `got ${parsed.results.length} results, expected ${uncachedUrls.length}`
        })`,
      );
      const fallback = await Promise.all(uncachedUrls.map((url) => scoreImageOutfitPotential(url)));
      uncachedIndices.forEach((index, i) => {
        results[index] = fallback[i];
      });
      return results as ImageScoreResult[];
    }

    parsed.results.forEach((raw, i) => {
      const result: ImageScoreResult = {
        score: adjustScore(raw),
        tags: raw.tags,
        fit: raw.fit,
        aesthetic: raw.aesthetic,
        confidence: raw.confidence,
      };
      results[uncachedIndices[i]] = result;
      scoreCache.set(uncachedUrls[i], result);
    });

    debugLogBatch(`Success (${uncachedUrls.length} images, 1 call)`);
    return results as ImageScoreResult[];
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    debugLogBatch(`Failed - falling back to per-item scoring (${reason})`);
    const fallback = await Promise.all(uncachedUrls.map((url) => scoreImageOutfitPotential(url)));
    uncachedIndices.forEach((index, i) => {
      results[index] = fallback[i];
    });
    return results as ImageScoreResult[];
  }
}
