// AI-Powered Outfit Creation — Part 2: bundle candidate ranking. This is
// deliberately a thin COMPOSITION over the two existing ranking engines,
// not a new one: src/lib/garment-similarity-ranking.ts's scoreSimilarity
// already computes category/garment-type/silhouette/pattern/material
// (garment match), style/era/visual-details (style match), and color
// match, plus an optional visual-similarity term; src/lib/image-similarity.ts's
// compareImageSimilarity is reused directly for the visual term. The only
// genuinely new piece here is budget scoring and the specific 40/25/15/10/10
// weighting this feature's own spec calls for — nothing about how any
// individual signal is computed is reimplemented.
import { scoreSimilarity, type RankableCandidate } from "@/lib/garment-similarity-ranking";
import { compareImageSimilarity } from "@/lib/image-similarity";
import type { DetectedGarment } from "@/lib/garment-detection";
import type { BundleDetectedItem } from "@/lib/style-bundle-analysis";

// Max possible values for the scoreSimilarity components this file folds
// into "garment match" and "style match" — mirrors the bonus constants
// already declared in garment-similarity-ranking.ts (CATEGORY_MATCH_BONUS
// = 15, GARMENT_TYPE_FAMILY_MATCH_BONUS = 40, SILHOUETTE_MATCH_BONUS = 12,
// PATTERN_MATCH_BONUS = 10, MATERIAL_MATCH_BONUS = 8, STYLE_CAP = 10,
// ERA_MATCH_BONUS = 6, VISUAL_DETAILS_CAP = 10, COLOR_MATCH_BONUS = 20).
// Used only to normalize those existing point scales into this feature's
// own 0-100-ish percentages before applying its weights — duplicated as
// plain numbers (not imported) since none of those constants are
// exported from that file; if their values ever change there, these
// should be updated to match.
const GARMENT_BUCKET_MAX = 15 + 40 + 12 + 10 + 8;
const STYLE_BUCKET_MAX = 10 + 6 + 10;
const COLOR_BUCKET_MAX = 20;

const WEIGHT_VISUAL = 0.4;
const WEIGHT_GARMENT = 0.25;
const WEIGHT_STYLE = 0.15;
const WEIGHT_COLOR = 0.1;
const WEIGHT_BUDGET = 0.1;

export interface BundleRankableCandidate extends RankableCandidate {
  price: number | null;
}

export interface BundleScoreBreakdown {
  visualSimilarityPercent: number;
  garmentMatchPercent: number;
  stylePercent: number;
  colorPercent: number;
  budgetPercent: number;
  total: number;
}

// No budget set -> neutral (100), never penalizes when the user didn't
// give one. Unknown candidate price -> neutral-ish midpoint (50), not a
// penalty for a data gap that isn't the candidate's fault. Within budget
// -> full marks. Over budget -> decays linearly to 0 at 2x the ceiling,
// so a listing slightly over budget still ranks above one wildly over,
// rather than an all-or-nothing cliff.
function scoreBudget(price: number | null, budgetCeiling: number | null): number {
  if (budgetCeiling == null || budgetCeiling <= 0) return 100;
  if (price == null) return 50;
  if (price <= budgetCeiling) return 100;
  const overageRatio = (price - budgetCeiling) / budgetCeiling;
  return Math.max(0, 100 - overageRatio * 100);
}

// BundleDetectedItem (style-bundle-analysis.ts) carries the same fields
// as DetectedGarment (garment-detection.ts) minus `description` and
// `searchQueries` (runtime-only fields scoreSimilarity doesn't read for
// its own scoring — description isn't scored at all, and searchQueries
// is only used by marketplace-search.ts's OWN keyword scoring, not this
// file). This adapter exists so scoreSimilarity — already proven correct
// for Recreate This Look — needs no changes to also score bundle items.
function toDetectedGarment(item: BundleDetectedItem): DetectedGarment {
  return {
    category: item.category,
    garmentType: item.garmentType,
    description: item.garmentType,
    color: item.color ?? "unknown",
    pattern: item.pattern,
    material: item.material,
    silhouette: item.silhouette ?? "regular fit",
    era: item.era,
    visualDetails: null,
    searchQueries: [],
  };
}

/**
 * Scores one candidate against one detected outfit item using this
 * feature's own weighted formula (visual 40 / garment 25 / style 15 /
 * color 10 / budget 10) — every non-budget, non-visual signal comes
 * straight from scoreSimilarity's existing breakdown, just normalized
 * and re-weighted; visual similarity comes straight from
 * compareImageSimilarity. Neither is recomputed independently.
 */
export function scoreBundleCandidate(
  item: BundleDetectedItem,
  style: string,
  candidate: BundleRankableCandidate,
  queryImageEmbedding: number[] | null,
  budgetCeiling: number | null,
): BundleScoreBreakdown {
  const breakdown = scoreSimilarity(toDetectedGarment(item), style, candidate, queryImageEmbedding);

  const garmentRaw =
    breakdown.categoryScore + breakdown.garmentTypeScore + breakdown.silhouetteScore + breakdown.patternScore + breakdown.materialScore;
  const styleRaw = breakdown.styleScore + breakdown.eraScore + breakdown.visualDetailsScore;

  const garmentMatchPercent = (garmentRaw / GARMENT_BUCKET_MAX) * 100;
  const stylePercent = (styleRaw / STYLE_BUCKET_MAX) * 100;
  const colorPercent = (breakdown.colorScore / COLOR_BUCKET_MAX) * 100;

  // null (no real embedding on one or both sides — see
  // compareImageSimilarity's own doc comment) becomes 0 here, not a
  // fabricated similarity — this term simply contributes nothing until a
  // real embedding exists for both the inspiration photo and the
  // candidate. Negative cosine similarity is floored at 0 too: a
  // dissimilar image should score low, not swing the composite negative
  // for a listing that may still be a fine garment/style match.
  const visualSimilarity = compareImageSimilarity(queryImageEmbedding, candidate.imageEmbedding);
  const visualSimilarityPercent = visualSimilarity != null ? Math.max(0, visualSimilarity) * 100 : 0;

  const budgetPercent = scoreBudget(candidate.price, budgetCeiling);

  const total =
    visualSimilarityPercent * WEIGHT_VISUAL +
    garmentMatchPercent * WEIGHT_GARMENT +
    stylePercent * WEIGHT_STYLE +
    colorPercent * WEIGHT_COLOR +
    budgetPercent * WEIGHT_BUDGET;

  return { visualSimilarityPercent, garmentMatchPercent, stylePercent, colorPercent, budgetPercent, total };
}

/**
 * Re-orders a pool of candidates for one detected outfit item, best-first
 * — same "re-rank, never truncate" shape as garment-similarity-ranking.ts's
 * own rankBySimilarity.
 */
export function rankBundleCandidates<T extends BundleRankableCandidate>(
  item: BundleDetectedItem,
  style: string,
  candidates: T[],
  queryImageEmbedding: number[] | null,
  budgetCeiling: number | null,
): T[] {
  return candidates
    .map((candidate) => ({
      candidate,
      score: scoreBundleCandidate(item, style, candidate, queryImageEmbedding, budgetCeiling).total,
    }))
    .sort((a, b) => b.score - a.score)
    .map(({ candidate }) => candidate);
}
