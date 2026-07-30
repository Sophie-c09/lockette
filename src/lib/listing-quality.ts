// AI quality scoring for scraped listings — run after enrichListing()
// (src/lib/listing-enrichment.ts) and before any insert, in both the bulk
// importer (src/lib/bulk-import.ts, which rejects below-threshold
// listings outright) and the single-URL importer (which stores the score
// for every listing but never gates on it — see QUALITY_REJECTION_THRESHOLD's
// own comment for why).
//
// The 0-100 score is a weighted sum of five criteria; only two of them
// actually need the AI vision call:
//   imageQuality      (0-35, AI-judged)   — highest weight, per spec: a
//                                           clear, in-focus product photo
//                                           vs. a blurry image/screenshot/
//                                           collage/text-only image.
//   fashionRelevance  (0-25, code)        — derived from aesthetic_tags
//                                           (already computed by
//                                           enrichListing via text
//                                           classification + image
//                                           tagging) rather than asking
//                                           the model to re-judge this
//                                           independently: that would risk
//                                           disagreeing with the tags
//                                           actually stored on the
//                                           listing, which would read as
//                                           an inconsistent bug to an
//                                           admin looking at both side by
//                                           side.
//   completeness      (0-15, code)        — title/price/brand/image_url
//                                           each present, split evenly.
//                                           Fully deterministic; no reason
//                                           to ask an AI model to check
//                                           for null.
//   productAppeal     (0-15, AI-judged)   — a distinctive, recognizable
//                                           piece vs. a generic/
//                                           undesirable one.
//   priceValue        (0-10, code)        — does this feel like a good
//                                           affordable thrift find, not
//                                           "is this a steal relative to
//                                           its resale value"? Rewards low
//                                           absolute price directly; a
//                                           recognizable brand only adds a
//                                           small, capped bonus on top of
//                                           an otherwise-pricier item, it
//                                           never justifies the price on
//                                           its own. See
//                                           calculatePriceValueScore.
import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import { z } from "zod";
import type { ExtractedListing } from "@/lib/extraction/normalize-listing";

// Listings scoring below this are rejected outright by the bulk importer
// (never inserted, not even as 'rejected' — see bulk-import.ts) rather
// than landing in the moderation queue. The single-URL importer
// (/api/import-listing/route.ts) stores the same score for visibility on
// the admin card but never applies this threshold itself: pasting one
// specific URL is a deliberate admin decision, and silently vetoing it out
// from under them would be a worse outcome than showing them a low score
// and letting them decide.
export const QUALITY_REJECTION_THRESHOLD = 40;

const MAX_IMAGE_QUALITY_SCORE = 35;
const MAX_PRODUCT_APPEAL_SCORE = 15;
const MAX_FASHION_RELEVANCE_SCORE = 25;
const MAX_COMPLETENESS_SCORE = 15;
const MAX_PRICE_VALUE_SCORE = 10;

const QualityScoreSchema = z.object({
  image_quality_score: z.number(),
  product_appeal_score: z.number(),
  reason: z.string(),
});

const SYSTEM_PROMPT = `You are a fashion-listing quality reviewer for Lockette, a secondhand clothing marketplace. Given a listing's photo and a few details, score two things about it:

- image_quality_score (0-${MAX_IMAGE_QUALITY_SCORE}): Is this a clear, well-lit, in-focus photo of the actual clothing item? Score low for: blurry/out-of-focus images, screenshots (of an app, website, or chat), collages or multi-panel photo grids, or images that are mostly text rather than an actual photo of the garment. Score high only for a clean, single, well-lit product photo.
- product_appeal_score (0-${MAX_PRODUCT_APPEAL_SCORE}): Is this a distinctive, recognizable piece likely to attract resale interest on a secondhand fashion app, or a generic/undesirable item?

reason: one or two sentences explaining both scores, written for an internal admin reviewing this listing before approving it (e.g. "Clear, well-lit photo of a distinctive graphic tee — good resale appeal." or "Image is a blurry screenshot; hard to assess the actual garment.").

Respond only with the structured fields — no extra commentary.`;

function debugLog(message: string): void {
  console.warn(`[listing-quality] ${message}`);
}

const DEFAULT_MODEL = "gpt-4o-mini";
const REQUEST_TIMEOUT_MS = 15_000;

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

interface CompletenessResult {
  score: number;
  missing: string[];
}

function scoreCompleteness(listing: ExtractedListing): CompletenessResult {
  const checks: [boolean, string][] = [
    [Boolean(listing.title?.trim()), "title"],
    [listing.price != null && listing.price > 0, "price"],
    [Boolean(listing.brand?.trim()), "brand"],
    [Boolean(listing.image_url), "image"],
  ];

  const pointsPerCheck = MAX_COMPLETENESS_SCORE / checks.length;
  let score = 0;
  const missing: string[] = [];

  for (const [present, label] of checks) {
    if (present) {
      score += pointsPerCheck;
    } else {
      missing.push(label);
    }
  }

  return { score: Math.round(score), missing };
}

// 0 tags -> 0, 1 tag -> just over half, 2+ tags -> the full amount — a
// listing with no detected aesthetic match at all shouldn't score as
// "fashion relevant" just because it exists, but a single genuine match
// already counts for a lot more than half credit.
function scoreFashionRelevance(aestheticTags: string[]): number {
  if (aestheticTags.length === 0) return 0;
  if (aestheticTags.length === 1) return 15;
  return MAX_FASHION_RELEVANCE_SCORE;
}

// ---------------------------------------------------------------------------
// Price/value scoring — entirely code-computed, no AI call. Answers "does
// this feel like a good thrift find," not "is this a steal relative to
// its resale value." An earlier version of this scored a $100 vintage
// Coach bag as a perfect 10 because $100 is a bargain for a bag genuinely
// worth several times that — which is exactly the wrong incentive for
// Lockette: it kept surfacing expensive vintage/designer pieces instead of
// the $3-$6 affordable thrift finds the marketplace is actually meant to
// be about. This version rewards low absolute price directly, with only a
// small, capped brand-recognition bonus for pricier pieces ("unless
// exceptional") rather than letting brand justify the price on its own.
// ---------------------------------------------------------------------------

type BrandTier = "top" | "mid" | "genericMall" | "unknown";

// Explicitly named in spec, plus a small, deliberately non-exhaustive set
// of other unambiguously recognizable designer/vintage names — this is a
// heuristic keyword match, not a curated catalog; add to these lists as
// real-world data suggests, rather than treating them as complete.
const TOP_TIER_BRANDS = [
  "coach",
  "ralph lauren",
  "polo ralph lauren",
  "juicy couture",
  "true religion",
  "ed hardy",
  "levi's",
  "levis",
  "carhartt",
  "tommy hilfiger",
  "guess",
  "kate spade",
  "michael kors",
  "dooney",
];

const MID_TIER_BRANDS = [
  "abercrombie",
  "american eagle",
  "hollister",
  "free people",
  "urban outfitters",
  "gap",
  "j.crew",
  "jcrew",
  "eddie bauer",
];

const GENERIC_MALL_BRANDS = [
  "forever 21",
  "forever21",
  "old navy",
  "target",
  "wild fable",
  "no boundaries",
  "shein",
  "h&m",
  "primark",
];

function detectBrandTier(brand: string | null): BrandTier {
  if (!brand) return "unknown";
  const normalized = brand.toLowerCase();
  if (TOP_TIER_BRANDS.some((name) => normalized.includes(name))) return "top";
  if (MID_TIER_BRANDS.some((name) => normalized.includes(name))) return "mid";
  if (GENERIC_MALL_BRANDS.some((name) => normalized.includes(name))) return "genericMall";
  return "unknown";
}

const BRAND_TIER_LABEL: Record<BrandTier, string> = {
  top: "recognizable designer/vintage",
  mid: "on-trend brand",
  genericMall: "generic mall-brand",
  unknown: "generic",
};

// Absolute price bands — per spec: ideal $3-$6, good $6-$12, lower
// priority $12-$20, avoid $30+. The $20-$30 band isn't named explicitly
// in the spec but needs a value of its own to interpolate sensibly
// between "lower priority" and "avoid" (calibrated so a $25 generic
// leather jacket, one of the spec's own worked examples, lands at 5/10).
// Never returns 0 for having *a* price — "do NOT completely reject
// expensive items, but reduce discovery priority" — the floor is 2, not 0.
function priceRangeScore(price: number): number {
  if (price <= 6) return MAX_PRICE_VALUE_SCORE; // ideal thrift-find price (and anything cheaper)
  if (price <= 12) return 8; // good
  if (price <= 20) return 6; // lower priority
  if (price <= 30) return 5; // matches the spec's own $25 leather-jacket example
  return 2; // avoid, but never fully rejected
}

// A small, capped bonus for recognizable brands on pricier pieces — "a
// $50 designer item: lower priority unless exceptional." Only applied
// above $20: below that, priceRangeScore is already at or near the max,
// so there's nothing meaningful left to add, and a cheap generic item
// shouldn't get a brand bonus it didn't earn just for being cheap.
function brandExceptionBonus(tier: BrandTier, price: number): number {
  if (price <= 20) return 0;
  if (tier === "top") return 2;
  if (tier === "mid") return 1;
  return 0;
}

interface PriceValueResult {
  score: number;
  tier: BrandTier;
}

/**
 * Scores 0-${MAX_PRICE_VALUE_SCORE} on "does this feel like a good thrift
 * find," not "is this a good deal relative to what it's really worth."
 * Cheap scores high regardless of brand; a recognizable brand only adds a
 * small, capped bonus on top of an otherwise-expensive price, it never
 * justifies the price on its own. A listing with no price at all can't be
 * assessed for value and scores 0 — distinct from a merely expensive one,
 * which still scores a nonzero 2.
 */
export function calculatePriceValueScore(listing: ExtractedListing): PriceValueResult {
  const tier = detectBrandTier(listing.brand);

  if (listing.price == null || listing.price <= 0) {
    return { score: 0, tier };
  }

  const score = clampInt(priceRangeScore(listing.price) + brandExceptionBonus(tier, listing.price), 0, MAX_PRICE_VALUE_SCORE);

  return { score, tier };
}

function describePriceValue(priceValue: PriceValueResult, hadPrice: boolean): string {
  if (!hadPrice) return "No price to assess value.";
  if (priceValue.score >= MAX_PRICE_VALUE_SCORE) return "Priced like a great thrift find.";
  if (priceValue.score >= 8) return "A solid, affordable price.";
  if (priceValue.score >= 5) {
    const label = BRAND_TIER_LABEL[priceValue.tier];
    return `A bit pricey for what Lockette shoppers are usually after, though reasonable for a ${label} piece.`;
  }
  return "Priced high for what this is — lower priority unless it's an exceptional piece.";
}

export interface QualityScoreBreakdown {
  imageQuality: number;
  fashionRelevance: number;
  completeness: number;
  productAppeal: number;
  priceValue: number;
}

export interface QualityScoreResult {
  qualityScore: number;
  qualityReason: string;
  breakdown: QualityScoreBreakdown;
}

function buildResult(
  breakdown: QualityScoreBreakdown,
  reasonParts: string[],
  missing: string[],
): QualityScoreResult {
  const qualityScore = clampInt(
    breakdown.imageQuality + breakdown.fashionRelevance + breakdown.completeness + breakdown.productAppeal + breakdown.priceValue,
    0,
    100,
  );

  const parts = [...reasonParts];
  if (missing.length > 0) {
    parts.push(`Missing: ${missing.join(", ")}.`);
  }

  return { qualityScore, qualityReason: parts.join(" "), breakdown };
}

/**
 * Scores a listing 0-100 for the incoming moderation queue. Never throws.
 *
 * Two different kinds of "can't judge the photo" are handled differently
 * on purpose:
 * - No OPENAI_API_KEY, or the AI call itself fails: this is OUR
 *   infrastructure's limitation, not a fact about the listing, so
 *   imageQuality/productAppeal fall back to their maximum — an
 *   unconfigured API key or a transient failure must never turn into
 *   "every bulk-imported listing gets auto-rejected," matching this
 *   codebase's existing "AI enrichment is best-effort, never a hard
 *   blocker" convention (see classifyListing/generateImageTags).
 * - The listing itself has no image at all: this IS a fact about the
 *   listing — a shopper can't see it either — so imageQuality scores 0
 *   rather than assuming the best.
 *
 * priceValue and completeness are always real either way — they never
 * depend on the AI call at all.
 */
export async function scoreListingQuality(listing: ExtractedListing): Promise<QualityScoreResult> {
  const completeness = scoreCompleteness(listing);
  const fashionRelevance = scoreFashionRelevance(listing.aesthetic_tags);
  const priceValue = calculatePriceValueScore(listing);
  const priceValuePhrase = describePriceValue(priceValue, listing.price != null && listing.price > 0);

  // Checked BEFORE the API-key check below, deliberately: this is a fact
  // about the listing itself (no photo exists at all), not about our
  // infrastructure's ability to judge one — it must apply regardless of
  // whether an API key happens to be configured. A shopper browsing
  // Lockette also can't see an item with no photo, which is a genuine
  // quality problem, not something to assume the best on. imageQuality
  // scores 0; productAppeal gets partial credit since title/brand text
  // alone can still suggest some appeal even with nothing to look at.
  if (!listing.image_url) {
    debugLog("No image on listing — imageQuality scores 0, productAppeal reduced");
    return buildResult(
      {
        imageQuality: 0,
        fashionRelevance,
        completeness: completeness.score,
        productAppeal: Math.round(MAX_PRODUCT_APPEAL_SCORE / 2),
        priceValue: priceValue.score,
      },
      ["No photo provided — can't assess image quality.", priceValuePhrase],
      completeness.missing,
    );
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    debugLog("Scoring image/appeal on completeness fallback only (OPENAI_API_KEY is not set)");
    return buildResult(
      {
        imageQuality: MAX_IMAGE_QUALITY_SCORE,
        fashionRelevance,
        completeness: completeness.score,
        productAppeal: MAX_PRODUCT_APPEAL_SCORE,
        priceValue: priceValue.score,
      },
      ["AI quality scoring unavailable (no API key).", priceValuePhrase],
      completeness.missing,
    );
  }

  try {
    const client = new OpenAI({ apiKey, timeout: REQUEST_TIMEOUT_MS });
    const model = process.env.OPENAI_QUALITY_SCORE_MODEL || DEFAULT_MODEL;

    const completion = await client.chat.completions.parse({
      model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: JSON.stringify({
                title: listing.title,
                description: listing.description,
                brand: listing.brand,
                price: listing.price,
              }),
            },
            { type: "image_url", image_url: { url: listing.image_url } },
          ],
        },
      ],
      response_format: zodResponseFormat(QualityScoreSchema, "listing_quality_score"),
    });

    const parsed = completion.choices[0]?.message?.parsed;
    if (!parsed) {
      throw new Error("no parsed output returned");
    }

    const imageQuality = clampInt(parsed.image_quality_score, 0, MAX_IMAGE_QUALITY_SCORE);
    const productAppeal = clampInt(parsed.product_appeal_score, 0, MAX_PRODUCT_APPEAL_SCORE);

    const result = buildResult(
      { imageQuality, fashionRelevance, completeness: completeness.score, productAppeal, priceValue: priceValue.score },
      [parsed.reason, priceValuePhrase],
      completeness.missing,
    );

    debugLog(
      `Score ${result.qualityScore} (image=${imageQuality}/${MAX_IMAGE_QUALITY_SCORE} appeal=${productAppeal}/${MAX_PRODUCT_APPEAL_SCORE} fashion=${fashionRelevance}/${MAX_FASHION_RELEVANCE_SCORE} completeness=${completeness.score}/${MAX_COMPLETENESS_SCORE} priceValue=${priceValue.score}/${MAX_PRICE_VALUE_SCORE})`,
    );

    return result;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    debugLog(`Failed - defaulting to completeness fallback only (${reason})`);
    return buildResult(
      {
        imageQuality: MAX_IMAGE_QUALITY_SCORE,
        fashionRelevance,
        completeness: completeness.score,
        productAppeal: MAX_PRODUCT_APPEAL_SCORE,
        priceValue: priceValue.score,
      },
      [`AI quality scoring failed (${reason}).`, priceValuePhrase],
      completeness.missing,
    );
  }
}
