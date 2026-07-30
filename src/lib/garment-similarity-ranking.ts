// Second-stage visual-similarity ranking for outfit recreation retrieval.
// Sits AFTER src/lib/marketplace-search.ts's searchMarketplaceItems —
// that abstraction is unchanged by this file: it still does its own
// category hard-filter, first-pass keyword scoring, availability/URL
// filtering, and budget filtering, and still returns whatever pool size
// it always has. This module takes THAT pool and re-ranks it using an
// explicit, multi-factor visual-similarity formula instead of trusting
// the abstraction's own (cruder, single-blob) keyword/description
// overlap scoring to already be the final word.
//
// WHY A SEPARATE STAGE, NOT A BIGGER FIRST-STAGE SCORER: searchMarketplaceItems'
// public shape is deliberately flat (id/title/image/price/url/platform/
// category/availability — see that file's own header comment) and isn't
// being changed here, so it can't expose separate color/silhouette/
// pattern/material fields per candidate. This stage instead works off
// whatever free text the CALLER can provide per candidate (ideally a real
// listing's full title+description+color+brand, when available — see
// outfit-recreations.ts's own comment on why it fetches that before
// calling into this file) — it is intentionally decoupled from both
// DetectedGarment and NormalizedMarketplaceItem's exact shapes via the
// generic RankableCandidate below, so it can score against whatever text
// a caller actually has, not just a title string.
//
// RANKING FORMULA (see scoreSimilarity below for the exact numbers):
//   1. Garment accuracy — category match (should already always be true,
//      since searchMarketplaceItems only ever returns same-category
//      candidates; scored/penalized here too as a defensive check, not
//      because it's expected to ever fire) + garment TYPE match, using
//      named "garment type families" per category (e.g. bottoms: skirt /
//      jeans / trousers / leggings / shorts) so a same-bucket but
//      DIFFERENT specific garment (jeans when a skirt was detected) is
//      an explicit PENALTY, not just "no bonus" — this is what
//      guarantees "skirt beats jeans," "cardigan beats hoodie," and
//      "shoulder bag beats backpack" even when every candidate already
//      passed the coarse category filter.
//   2. Visual attributes — color, silhouette/fit (with a small set of
//      known opposing-silhouette pairs penalized the same way garment
//      type families are), pattern, material, and distinctive visual
//      details, each checked as a text-overlap signal against whatever
//      searchable text the candidate provides.
//   3. Style — era and overall aesthetic/vibe, lowest-weighted since
//      they're the least garment-specific signal (same reasoning
//      src/lib/garment-matching.ts already established: don't rank on
//      aesthetic/vibe alone).
//
// This is still a text-attribute similarity approximation, not true
// pixel/embedding-based visual similarity — no image-embedding
// infrastructure exists anywhere in this codebase (no pgvector, no CLIP
// embeddings), so comparing AI-extracted structured attributes via text
// overlap is the closest practical approximation without building that
// from scratch.
import type { DetectedGarment } from "@/lib/garment-detection";
import type { GarmentCategory } from "@/lib/garment-detection";
import { compareImageSimilarity } from "@/lib/image-similarity";

export interface RankableCandidate {
  // Opaque to this module — never read, only used to hand the original
  // array element back after re-sorting.
  category: GarmentCategory;
  searchableText: string;
  // Visual Similarity Search Foundation (src/lib/image-similarity.ts) —
  // optional and, in practice, always absent today: nothing in this
  // codebase populates a real image embedding yet (see that file's own
  // TODO). Present here so a FUTURE caller that has one doesn't need a
  // new candidate shape — see visualSimilarityScore below for how it's
  // used once it exists.
  imageEmbedding?: number[] | null;
}

export interface SimilarityScoreBreakdown {
  categoryScore: number;
  garmentTypeScore: number;
  colorScore: number;
  silhouetteScore: number;
  patternScore: number;
  materialScore: number;
  visualDetailsScore: number;
  eraScore: number;
  styleScore: number;
  // Additional scoring factor (Marketplace Ingestion Part 4) — cosine
  // similarity (src/lib/image-similarity.ts) between the detected
  // garment's own embedding and a candidate's, scaled by
  // VISUAL_SIMILARITY_WEIGHT below. Always 0 today: compareImageSimilarity
  // returns null (not a fake 0-means-similarity value) whenever either
  // side has no real embedding, which is every call right now — so this
  // term changes NOTHING about current rankings until a real embedding
  // pipeline actually populates image_embedding somewhere.
  visualSimilarityScore: number;
  total: number;
}

// Named garment-type "families" within each category — the mechanism
// behind every one of this feature's own worked examples (skirt vs.
// jeans, cardigan vs. hoodie, shoulder bag vs. backpack). Not
// exhaustive — a deliberately modest, common-cases list; anything not
// recognized here just falls back to a plain substring check on the
// detected item's own garmentType (see scoreGarmentType below), same as
// before this file existed.
const GARMENT_TYPE_FAMILIES: Partial<Record<GarmentCategory, string[][]>> = {
  bottoms: [
    ["skirt"],
    ["jean", "denim"],
    ["trouser", "slacks"],
    ["legging"],
    ["short"],
    ["pant"],
  ],
  outerwear: [
    ["jacket"],
    ["coat"],
    ["hoodie"],
    ["cardigan"],
    ["blazer"],
    ["windbreaker"],
    ["sweater"],
  ],
  bags: [
    ["backpack"],
    ["tote"],
    ["clutch"],
    ["purse", "handbag"],
    ["crossbody", "shoulder bag"],
  ],
  tops: [
    ["blouse"],
    ["sweater"],
    ["tank"],
    ["t-shirt", "tee"],
    ["shirt"],
    ["crop top", "cropped top"],
  ],
  shoes: [
    ["sneaker"],
    ["boot"],
    ["sandal"],
    ["heel"],
    ["flat"],
  ],
  accessories: [
    ["jewelry", "necklace", "earring", "bracelet"],
    ["belt"],
    ["scarf"],
    ["sunglasses"],
  ],
};

// A small, deliberately non-exhaustive set of commonly-opposed
// silhouette/fit terms — enough to catch the clearest mismatches (an
// oversized piece is not a good match for a detected fitted one) without
// pretending to be a complete fashion-fit ontology.
const SILHOUETTE_OPPOSITES: [string[], string[]][] = [
  [["oversized", "baggy", "loose", "relaxed"], ["fitted", "slim", "skinny", "bodycon", "tight"]],
  [["cropped", "crop"], ["longline", "maxi", "long"]],
  [["high-rise", "high waisted", "high waist"], ["low-rise", "low waisted", "low waist"]],
];

function normalizeText(text: string): string {
  return text.trim().toLowerCase();
}

function includesTerm(haystack: string, term: string | null | undefined): boolean {
  if (!term) return false;
  return haystack.includes(term.trim().toLowerCase());
}

function matchingFamilyIndex(families: string[][], text: string): number | null {
  for (let index = 0; index < families.length; index++) {
    if (families[index].some((term) => text.includes(term))) return index;
  }
  return null;
}

function silhouetteConflicts(itemSilhouette: string, candidateText: string): boolean {
  const silhouette = normalizeText(itemSilhouette);
  return SILHOUETTE_OPPOSITES.some(([groupA, groupB]) => {
    const itemInA = groupA.some((term) => silhouette.includes(term));
    const itemInB = groupB.some((term) => silhouette.includes(term));
    const candidateInA = groupA.some((term) => candidateText.includes(term));
    const candidateInB = groupB.some((term) => candidateText.includes(term));
    return (itemInA && candidateInB) || (itemInB && candidateInA);
  });
}

// Counts significant (>2 char) word overlaps between a free-text field
// and the candidate's searchable text, capped — used for the two fields
// that are naturally full phrases rather than single terms
// (visualDetails, style/aesthetic), where an exact-phrase match is
// unlikely but partial overlap still means something.
function wordOverlapScore(text: string, haystack: string, perWordWeight: number, cap: number): number {
  if (!text) return 0;
  const words = normalizeText(text).split(/\s+/).filter((word) => word.length > 2);
  const matched = words.filter((word) => haystack.includes(word)).length;
  return Math.min(matched * perWordWeight, cap);
}

const CATEGORY_MATCH_BONUS = 15;
// Should never actually fire — searchMarketplaceItems already hard-
// filters to the requested category before this stage ever sees a
// candidate — but scored anyway per this feature's own requirement to
// penalize a wrong garment category, and as a defensive check in case a
// future caller ever feeds this function mixed-category candidates.
const CATEGORY_MISMATCH_PENALTY = -60;

const GARMENT_TYPE_FAMILY_MATCH_BONUS = 40;
const GARMENT_TYPE_FAMILY_CONFLICT_PENALTY = -35;

const COLOR_MATCH_BONUS = 20;
const SILHOUETTE_MATCH_BONUS = 12;
const SILHOUETTE_CONFLICT_PENALTY = -15;
const PATTERN_MATCH_BONUS = 10;
const MATERIAL_MATCH_BONUS = 8;
const VISUAL_DETAILS_WORD_WEIGHT = 4;
const VISUAL_DETAILS_CAP = 10;
const ERA_MATCH_BONUS = 6;
const STYLE_WORD_WEIGHT = 3;
const STYLE_CAP = 10;
// Scales compareImageSimilarity's [-1, 1] cosine-similarity output into
// the same rough magnitude as this formula's other bonuses (garment type
// match is worth 40) — chosen so, once real embeddings exist, a strong
// visual match can meaningfully move the ranking without dominating
// every other signal already validated by this feature's own worked
// examples (skirt vs. jeans, cardigan vs. hoodie, shoulder bag vs.
// backpack).
const VISUAL_SIMILARITY_WEIGHT = 30;

/**
 * Scores one candidate against one detected garment item, returning both
 * the total and the per-dimension breakdown (so a caller — or a human
 * debugging a bad ranking — can see exactly why a candidate scored the
 * way it did, not just a single opaque number).
 *
 * `queryImageEmbedding` is optional and, in practice, always omitted
 * today (see RankableCandidate's own comment) — passing one in is how a
 * future caller opts into the visualSimilarityScore term below; every
 * existing caller that doesn't pass it gets exactly the same score this
 * function has always produced.
 */
export function scoreSimilarity(
  item: DetectedGarment,
  style: string,
  candidate: RankableCandidate,
  queryImageEmbedding?: number[] | null,
): SimilarityScoreBreakdown {
  const haystack = normalizeText(candidate.searchableText);

  const categoryScore = candidate.category === item.category ? CATEGORY_MATCH_BONUS : CATEGORY_MISMATCH_PENALTY;

  const families = GARMENT_TYPE_FAMILIES[item.category] ?? [];
  const itemFamilyIndex = matchingFamilyIndex(families, normalizeText(item.garmentType));
  const candidateFamilyIndex = matchingFamilyIndex(families, haystack);

  let garmentTypeScore: number;
  if (itemFamilyIndex != null && candidateFamilyIndex != null) {
    garmentTypeScore =
      itemFamilyIndex === candidateFamilyIndex ? GARMENT_TYPE_FAMILY_MATCH_BONUS : GARMENT_TYPE_FAMILY_CONFLICT_PENALTY;
  } else if (includesTerm(haystack, item.garmentType)) {
    // Fallback for a garment type not covered by the named families
    // above — the exact phrase still appearing is a strong positive
    // signal even without a recognized "family" to compare against.
    garmentTypeScore = GARMENT_TYPE_FAMILY_MATCH_BONUS;
  } else {
    garmentTypeScore = 0;
  }

  const colorScore = includesTerm(haystack, item.color) ? COLOR_MATCH_BONUS : 0;

  let silhouetteScore = 0;
  if (includesTerm(haystack, item.silhouette)) {
    silhouetteScore = SILHOUETTE_MATCH_BONUS;
  } else if (silhouetteConflicts(item.silhouette, haystack)) {
    silhouetteScore = SILHOUETTE_CONFLICT_PENALTY;
  }

  const patternScore = includesTerm(haystack, item.pattern) ? PATTERN_MATCH_BONUS : 0;
  const materialScore = includesTerm(haystack, item.material) ? MATERIAL_MATCH_BONUS : 0;
  const visualDetailsScore = item.visualDetails
    ? wordOverlapScore(item.visualDetails, haystack, VISUAL_DETAILS_WORD_WEIGHT, VISUAL_DETAILS_CAP)
    : 0;
  const eraScore = includesTerm(haystack, item.era) ? ERA_MATCH_BONUS : 0;
  const styleScore = wordOverlapScore(style, haystack, STYLE_WORD_WEIGHT, STYLE_CAP);

  // null whenever either side has no real embedding (see
  // compareImageSimilarity's own doc comment) — which, today, is always,
  // since nothing populates a real image_embedding yet. This term is
  // ONLY ever nonzero once both a query and candidate embedding exist.
  const visualSimilarity = compareImageSimilarity(queryImageEmbedding, candidate.imageEmbedding);
  const visualSimilarityScore = visualSimilarity != null ? visualSimilarity * VISUAL_SIMILARITY_WEIGHT : 0;

  const total =
    categoryScore +
    garmentTypeScore +
    colorScore +
    silhouetteScore +
    patternScore +
    materialScore +
    visualDetailsScore +
    eraScore +
    styleScore +
    visualSimilarityScore;

  return {
    categoryScore,
    garmentTypeScore,
    colorScore,
    silhouetteScore,
    patternScore,
    materialScore,
    visualDetailsScore,
    eraScore,
    styleScore,
    visualSimilarityScore,
    total,
  };
}

/**
 * The second-stage ranking layer itself: re-scores and re-sorts whatever
 * pool a marketplace search already returned (best-first), WITHOUT
 * truncating it — the existing "top 3 shown, Shuffle reveals the next 3
 * highest-ranked unused ones" UI (src/lib/use-ranked-page.ts) depends on
 * a multi-item pool to page through; this only needs to guarantee that
 * pool's own ordering is correct (best match first, second match second,
 * third match third — this feature's own requirement), not shrink it.
 */
export function rankBySimilarity<T extends RankableCandidate>(
  item: DetectedGarment,
  style: string,
  candidates: T[],
  queryImageEmbedding?: number[] | null,
): T[] {
  return candidates
    .map((candidate) => ({ candidate, score: scoreSimilarity(item, style, candidate, queryImageEmbedding).total }))
    .sort((a, b) => b.score - a.score)
    .map(({ candidate }) => candidate);
}
