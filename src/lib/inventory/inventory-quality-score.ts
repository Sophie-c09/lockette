// Part 11 of the AI inventory architecture — the NEW composite score
// stored in listings.inventory_quality_score (schema.sql, Part 8). Kept
// distinct from src/lib/listing-score.ts's calculateScore (Discover's own
// ranking signal) and src/lib/listing-quality.ts's pre-import 0-100 score
// — see schema.sql's own column comment for why these three coexist
// rather than one replacing another. This formula reuses whatever of
// those existing signals already exist on a listing (image_score,
// aesthetic_tags) rather than re-deriving them, and adds the two
// genuinely new inputs Part 7/8 introduce: visual_analysis.confidence and
// last_verified_at-based freshness.
export interface InventoryQualityInputs {
  imageCount: number;
  imageScore: number | null; // existing AI-judged 0-100 column
  visualAnalysisConfidence: number | null; // Part 7's 0-1 confidence
  aestheticTagCount: number; // proxy for "style relevance" — a listing with real, specific style tags is more useful for style-based search than one with none
  price: number | null;
  createdAt: string;
  lastVerifiedAt: string | null;
}

export interface InventoryQualityResult {
  score: number;
  breakdown: {
    imageQuality: number;
    multipleImages: number;
    aiConfidence: number;
    styleRelevance: number;
    price: number;
    freshness: number;
  };
}

const WEIGHT_IMAGE_QUALITY = 0.2;
const WEIGHT_MULTIPLE_IMAGES = 0.15;
const WEIGHT_AI_CONFIDENCE = 0.2;
const WEIGHT_STYLE_RELEVANCE = 0.25;
const WEIGHT_PRICE = 0.1;
const WEIGHT_FRESHNESS = 0.1;

const MS_PER_DAY = 24 * 60 * 60 * 1000;
// A listing "confirmed fresh" today scores 1.0, decaying linearly to 0
// by FRESHNESS_HORIZON_DAYS since it was last verified/created — the
// specific horizon is a reasonable default for a resale marketplace
// (secondhand items can plausibly still be available weeks later), not
// a value derived from real observed sell-through data.
const FRESHNESS_HORIZON_DAYS = 60;

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function scoreFreshness(createdAt: string, lastVerifiedAt: string | null): number {
  const referenceDate = lastVerifiedAt ?? createdAt;
  const ageDays = (Date.now() - new Date(referenceDate).getTime()) / MS_PER_DAY;
  return clamp01(1 - ageDays / FRESHNESS_HORIZON_DAYS);
}

function scorePrice(price: number | null): number {
  // Same "cheap thrift find scores well, expensive isn't fully rejected"
  // shape as src/lib/listing-quality.ts's calculatePriceValueScore, kept
  // as its own small local formula here rather than importing that
  // pre-import-scoped function into this post-import context.
  if (price == null || price <= 0) return 0.3;
  if (price <= 12) return 1;
  if (price <= 25) return 0.7;
  if (price <= 50) return 0.5;
  return 0.3;
}

export function calculateInventoryQualityScore(inputs: InventoryQualityInputs): InventoryQualityResult {
  const imageQuality = inputs.imageScore != null ? clamp01(inputs.imageScore / 100) : 0.5; // neutral when not yet AI-scored
  const multipleImages = clamp01(inputs.imageCount / 4); // 4+ images = full credit
  const aiConfidence = inputs.visualAnalysisConfidence != null ? clamp01(inputs.visualAnalysisConfidence) : 0.5;
  const styleRelevance = clamp01(inputs.aestheticTagCount / 3); // 3+ real tags = full credit
  const price = scorePrice(inputs.price);
  const freshness = scoreFreshness(inputs.createdAt, inputs.lastVerifiedAt);

  const score =
    imageQuality * WEIGHT_IMAGE_QUALITY +
    multipleImages * WEIGHT_MULTIPLE_IMAGES +
    aiConfidence * WEIGHT_AI_CONFIDENCE +
    styleRelevance * WEIGHT_STYLE_RELEVANCE +
    price * WEIGHT_PRICE +
    freshness * WEIGHT_FRESHNESS;

  return {
    score: Math.round(score * 100) / 100,
    breakdown: { imageQuality, multipleImages, aiConfidence, styleRelevance, price, freshness },
  };
}
