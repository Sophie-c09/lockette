// Discover's own garment-level style-match scoring + fashionability
// quality gate — pure functions, no I/O, no AI call (this file is safe to
// run on every candidate in a Discover request). Deliberately separate
// from match-scoring.ts (/match's own scoring, untouched by this fix) and
// feed-scoring.ts (already unused by discover-feed.ts) — this is the NEW
// pipeline discover-feed.ts calls instead.
//
// scoreGarmentStyleMatch fixes the core reported bug: the old pipeline
// only ever compared aesthetic_tags (broad vibe words), so a floral maxi
// skirt and a fitted lace top could score identically for a user who only
// likes the top, as long as both happened to share one tag like
// "coquette." This scores garment type/category FAR above generic
// aesthetic overlap, using src/lib/discover-style-vector.ts's weighted
// per-user vector instead of a flat top-3-tags list.
import type { UserStyleVector, WeightedTerms } from "@/lib/discover-style-vector";
import { normalizeTerm } from "@/lib/discover-style-vector";
import { categorizeListing } from "@/lib/category-bucket";
import { ITEM_TYPE_CATEGORIES } from "@/lib/item-type-categories";
import type { VisualListingAnalysis } from "@/lib/ai/visual-listing-analysis";

// ---------------------------------------------------------------------------
// Garment-level style match — 30/20/15/10/10/5/5/5, normalized to 0-100.
// ---------------------------------------------------------------------------

const COMPONENT_MAX = {
  garment: 30,
  aesthetic: 20,
  silhouette: 15,
  colorPattern: 10,
  material: 10,
  brand: 5,
} as const;
const PRICE_MAX = 5;
const EXPLORATION_MAX = 5;

export interface GarmentMatchBreakdown {
  garmentScore: number;
  aestheticScore: number;
  silhouetteScore: number;
  colorPatternScore: number;
  materialScore: number;
  brandScore: number;
  priceScore: number;
  explorationScore: number;
  total: number;
}

export interface GarmentMatchListingInputs {
  id: string;
  title: string;
  category: string | null;
  brand: string | null;
  color: string | null;
  price: number | null;
  aestheticTags: string[];
  visualAnalysis?: VisualListingAnalysis | null;
}

function garmentNounsOf(listing: GarmentMatchListingInputs): string[] {
  if (listing.visualAnalysis?.garment_type?.length) return listing.visualAnalysis.garment_type;
  const haystack = `${listing.title} ${listing.category ?? ""}`.toLowerCase();
  const found: string[] = [];
  for (const type of ITEM_TYPE_CATEGORIES) {
    for (const keyword of type.categoryKeywords) {
      if (haystack.includes(keyword)) found.push(keyword);
    }
  }
  return found;
}

// Top-3 weight sum as the "fully matched" denominator — rewards hitting a
// user's DOMINANT preferences in a dimension without requiring every term
// they've ever shown interest in.
function topWeightSum(map: WeightedTerms, topN = 3): number {
  return [...map.values()]
    .sort((a, b) => b - a)
    .slice(0, topN)
    .reduce((a, b) => a + b, 0);
}

// Returns -1 (sentinel: "no vector data for this dimension at all", as
// opposed to a real 0 = "data exists, this candidate just doesn't match
// it") when the map is empty or the candidate supplied no terms for this
// dimension — callers use -1 to dynamically exclude a dimension from
// scoring rather than silently treating "no signal" as "zero match,"
// which would otherwise punish every candidate equally on inventory that
// hasn't been through visual_analysis enrichment yet.
function matchRatio(map: WeightedTerms, candidateTerms: string[]): number {
  if (map.size === 0 || candidateTerms.length === 0) return -1;

  const seen = new Set<string>();
  let matched = 0;
  for (const raw of candidateTerms) {
    const key = normalizeTerm(raw);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const weight = map.get(key);
    if (weight) matched += weight;
  }

  const denom = topWeightSum(map) || 1;
  return Math.max(0, Math.min(1, matched / denom));
}

function scorePriceCompatibility(priceRange: UserStyleVector["priceRange"], price: number | null): number {
  if (!priceRange || price == null || price <= 0) return 0.5; // neutral — not enough data on either side to judge
  const spread = Math.max(priceRange.max - priceRange.min, priceRange.median * 0.5, 5);
  const distance = Math.abs(price - priceRange.median);
  return Math.max(0, Math.min(1, 1 - distance / spread));
}

// Deterministic, NOT random — a stable hash of the listing id gives
// controlled diversity (two candidates with an identical style match
// don't always sort in the exact same order) without any non-determinism:
// the same listing gets the same exploration ratio on every request, and
// this file never calls Math.random()/Date.now() internally.
function stableExplorationRatio(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) | 0;
  }
  return (Math.abs(hash) % 1000) / 1000;
}

const NEUTRAL_BASELINE_TOTAL = 50;

/**
 * Scores one candidate listing against a user's style vector. When the
 * vector has no real signal at all (vector.hasSignal === false — a
 * brand-new user with no Likes/feedback/onboarding), every listing gets
 * the same neutral baseline (same reasoning as match-scoring.ts's own
 * NEUTRAL_BASELINE) so Discover's sort falls through to price/quality
 * instead of an arbitrary tag coincidence.
 */
export function scoreGarmentStyleMatch(vector: UserStyleVector, listing: GarmentMatchListingInputs): GarmentMatchBreakdown {
  const explorationRatio = stableExplorationRatio(listing.id);

  if (!vector.hasSignal) {
    return {
      garmentScore: 0,
      aestheticScore: 0,
      silhouetteScore: 0,
      colorPatternScore: 0,
      materialScore: 0,
      brandScore: 0,
      priceScore: 0,
      explorationScore: Math.round(explorationRatio * EXPLORATION_MAX),
      total: NEUTRAL_BASELINE_TOTAL,
    };
  }

  const bucket = categorizeListing({ title: listing.title, category: listing.category });
  const garmentNouns = garmentNounsOf(listing);
  const categoryCandidateTerms = bucket !== "other" ? [bucket, ...(listing.category ? [listing.category] : [])] : listing.category ? [listing.category] : [];

  const garmentRatio = Math.max(matchRatio(vector.garmentTerms, garmentNouns), matchRatio(vector.categoryTerms, categoryCandidateTerms));

  const aestheticCandidateTerms = [
    ...listing.aestheticTags,
    ...(listing.visualAnalysis?.aesthetic_tags ?? []),
    ...(listing.visualAnalysis?.style_attributes ?? []),
  ];
  const aestheticRatio = matchRatio(vector.aestheticTerms, aestheticCandidateTerms);

  const silhouetteCandidateTerms = [...(listing.visualAnalysis?.silhouette ?? []), ...(listing.visualAnalysis?.fit ?? [])];
  const silhouetteRatio = matchRatio(vector.silhouetteTerms, silhouetteCandidateTerms);

  const colorCandidateTerms = [...(listing.color ? [listing.color] : []), ...(listing.visualAnalysis?.colors ?? [])];
  const patternCandidateTerms = listing.visualAnalysis?.patterns ?? [];
  const colorRatio = matchRatio(vector.colorTerms, colorCandidateTerms);
  const patternRatio = matchRatio(vector.patternTerms, patternCandidateTerms);
  // One combined "color/pattern" component (matches this feature's own
  // 10% "color/pattern similarity" line item) — averaged across whichever
  // of the two sub-signals actually has data.
  const colorPatternParts = [colorRatio, patternRatio].filter((ratio) => ratio >= 0);
  const colorPatternRatio = colorPatternParts.length > 0 ? colorPatternParts.reduce((a, b) => a + b, 0) / colorPatternParts.length : -1;

  const materialCandidateTerms = listing.visualAnalysis?.materials ?? [];
  const materialRatio = matchRatio(vector.materialTerms, materialCandidateTerms);

  const brandRatio = matchRatio(vector.brandTerms, listing.brand ? [listing.brand] : []);

  // Dynamic reweighting — a dimension with NO vector data at all (ratio
  // === -1) is excluded here rather than scored as a 0-ratio match, and
  // its point budget is redistributed proportionally across whichever
  // dimensions DO have real data. garment/category and aesthetic are
  // derived from columns present on every listing, so they're almost
  // always available even on inventory that hasn't been through the
  // visual_analysis enrichment pipeline yet — this is what keeps
  // Discover's ranking meaningful on that inventory instead of collapsing
  // toward the same score for everyone.
  const components: Array<{ key: keyof typeof COMPONENT_MAX; ratio: number }> = [
    { key: "garment", ratio: garmentRatio },
    { key: "aesthetic", ratio: aestheticRatio },
    { key: "silhouette", ratio: silhouetteRatio },
    { key: "colorPattern", ratio: colorPatternRatio },
    { key: "material", ratio: materialRatio },
    { key: "brand", ratio: brandRatio },
  ];
  const available = components.filter((component) => component.ratio >= 0);
  const availableCap = available.reduce((sum, component) => sum + COMPONENT_MAX[component.key], 0);
  const definedCap = PRICE_MAX + EXPLORATION_MAX;
  const redistributeFactor = availableCap > 0 ? (100 - definedCap) / availableCap : 0;

  const priceRatio = scorePriceCompatibility(vector.priceRange, listing.price);

  const scores: Record<keyof typeof COMPONENT_MAX, number> = {
    garment: 0,
    aesthetic: 0,
    silhouette: 0,
    colorPattern: 0,
    material: 0,
    brand: 0,
  };
  for (const component of components) {
    scores[component.key] = component.ratio >= 0 ? component.ratio * COMPONENT_MAX[component.key] * redistributeFactor : 0;
  }
  const priceScore = priceRatio * PRICE_MAX;
  const explorationScore = explorationRatio * EXPLORATION_MAX;

  const total = Math.max(
    0,
    Math.min(100, Math.round(scores.garment + scores.aesthetic + scores.silhouette + scores.colorPattern + scores.material + scores.brand + priceScore + explorationScore)),
  );

  return {
    garmentScore: Math.round(scores.garment),
    aestheticScore: Math.round(scores.aesthetic),
    silhouetteScore: Math.round(scores.silhouette),
    colorPatternScore: Math.round(scores.colorPattern),
    materialScore: Math.round(scores.material),
    brandScore: Math.round(scores.brand),
    priceScore: Math.round(priceScore),
    explorationScore: Math.round(explorationScore),
    total,
  };
}

// ---------------------------------------------------------------------------
// Fashionability quality gate — personal relevance alone isn't enough;
// visibly weak inventory (bad photos, near-empty titles, no useful
// metadata) is deprioritized before ranking even runs.
// ---------------------------------------------------------------------------

export const FASHION_QUALITY_GATE = 60;

export interface FashionQualityInputs {
  images: string[] | undefined;
  imageUrl: string | null;
  title: string;
  aestheticTags: string[];
  brand: string | null;
  category: string | null;
  price: number | null;
  // Existing AI-judged 0-100 score computed at import time
  // (src/lib/listing-quality.ts) — preferred when present.
  qualityScore: number | null;
  // Existing 0-1 composite computed post-import
  // (src/lib/inventory/inventory-quality-score.ts) — preferred over the
  // deterministic fallback below, but AFTER qualityScore: it already
  // folds qualityScore's own image_score in as one of its inputs, so it's
  // the richer of the two existing signals when both are present.
  inventoryQualityScore: number | null;
}

export interface FashionQualityResult {
  score: number;
  source: "inventory_quality_score" | "quality_score" | "deterministic_fallback";
}

/**
 * Deterministic (no AI call) 0-100 fashionability/quality score. Prefers
 * whichever existing quality field this listing already has —
 * inventory_quality_score (0-1, richest — already folds in image quality,
 * AI-analysis confidence, style-tag relevance, price, and freshness) over
 * quality_score (0-100, the pre-import AI read) — falling back to a
 * lightweight deterministic estimate from whatever base columns Discover
 * already selects only when NEITHER exists yet (a listing imported before
 * either pipeline exists, or by a path that skips them).
 */
export function computeFashionQualityScore(inputs: FashionQualityInputs): FashionQualityResult {
  if (inputs.inventoryQualityScore != null) {
    return { score: Math.round(Math.max(0, Math.min(1, inputs.inventoryQualityScore)) * 100), source: "inventory_quality_score" };
  }
  if (inputs.qualityScore != null) {
    return { score: Math.round(Math.max(0, Math.min(100, inputs.qualityScore))), source: "quality_score" };
  }

  let score = 50;

  const imageCount = inputs.images?.length ?? (inputs.imageUrl ? 1 : 0);
  score += imageCount >= 3 ? 15 : imageCount === 2 ? 8 : imageCount === 1 ? 0 : -30;

  score += inputs.aestheticTags.length >= 2 ? 10 : inputs.aestheticTags.length === 1 ? 3 : -10;
  score += inputs.brand ? 5 : -3;
  score += inputs.category ? 5 : -3;

  // Generic/near-empty titles ("Cute top", "Nice dress") read as
  // low-effort/low-confidence listings; a genuinely descriptive title is
  // rewarded instead.
  const wordCount = inputs.title.trim().split(/\s+/).filter(Boolean).length;
  score += wordCount <= 2 ? -12 : wordCount >= 5 ? 6 : 0;

  if (inputs.price == null || inputs.price <= 0) score -= 15;
  else if (inputs.price > 500) score -= 8; // implausible for this marketplace's real inventory

  return { score: Math.max(0, Math.min(100, Math.round(score))), source: "deterministic_fallback" };
}
