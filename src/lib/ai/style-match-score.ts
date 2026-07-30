// Part 9 of the AI inventory architecture — replaces basic tag matching
// with the weighted composite scoring this spec calls for. Deliberately a
// thin COMPOSITION over existing engines, same pattern
// src/lib/bundle-ranking.ts already established for its own weighted
// composite: compareImageSimilarity (src/lib/image-similarity.ts) is
// reused directly for the visual term when both sides have a real
// embedding; text/tag overlap is the fallback (and, for aesthetic
// matching specifically, the PRIMARY signal — "soft feminine vintage"
// preferring a cream cardigan over a graphic hoodie is fundamentally a
// tag/vocabulary match, not something an image embedding alone
// determines) — nothing here reimplements compareImageSimilarity itself.
import { compareImageSimilarity } from "@/lib/image-similarity";
import type { VisualListingAnalysis } from "@/lib/ai/visual-listing-analysis";
import type { GarmentCategory } from "@/lib/garment-detection";

export interface UserStyleProfile {
  // e.g. ["soft feminine", "vintage"] — the user's own stated/derived
  // aesthetic preferences (src/lib/style-dna.ts's StyleDnaInput.aesthetics
  // is a compatible source for this).
  aesthetics: string[];
  preferredCategories?: GarmentCategory[] | null;
  preferredColors?: string[] | null;
  preferredSilhouettes?: string[] | null;
  preferredEras?: string[] | null;
  budgetMax?: number | null;
  // Optional real visual signal — a query image's own embedding (e.g.
  // from a liked item or inspiration photo), blended into the visual
  // term when the listing also has one. Absent = pure tag/text scoring.
  queryImageEmbedding?: number[] | null;
}

export interface VisualMatchResult {
  score: number;
  matching_features: string[];
  mismatches: string[];
  reasoning: string;
}

const WEIGHT_VISUAL_AESTHETIC = 0.4;
const WEIGHT_SILHOUETTE = 0.2;
const WEIGHT_COLOR = 0.15;
const WEIGHT_CATEGORY = 0.1;
const WEIGHT_ERA = 0.1;
const WEIGHT_PRICE = 0.05;

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

// Overlap ratio (0-1): how much of `wanted` is actually present in
// `have`, checking substring containment both ways so "Y2K" matches
// "y2k feminine" and vice versa — same lightweight text-overlap approach
// this codebase already uses throughout (marketplace-search.ts's
// scoreCandidate, garment-similarity-ranking.ts's text checks) rather
// than a new NLP dependency.
function overlapRatio(wanted: string[], have: string[]): { ratio: number; matched: string[] } {
  if (wanted.length === 0) return { ratio: 1, matched: [] }; // no preference stated -> neutral, never penalized
  if (have.length === 0) return { ratio: 0, matched: [] };

  const haveNormalized = have.map(normalize);
  const matched: string[] = [];

  for (const want of wanted) {
    const wantNormalized = normalize(want);
    const hit = haveNormalized.some((h) => h.includes(wantNormalized) || wantNormalized.includes(h));
    if (hit) matched.push(want);
  }

  return { ratio: matched.length / wanted.length, matched };
}

function scoreVisualAesthetic(
  profile: UserStyleProfile,
  listing: VisualListingAnalysis,
  imageEmbedding: number[] | null | undefined,
): { percent: number; matched: string[] } {
  const listingAesthetics = [...listing.aesthetic_tags, ...listing.style_attributes];
  const { ratio, matched } = overlapRatio(profile.aesthetics, listingAesthetics);

  const visualSimilarity = compareImageSimilarity(profile.queryImageEmbedding, imageEmbedding);
  // Blend a real embedding signal in when available, without letting it
  // fully override tag matching — tags are still the primary signal for
  // named-aesthetic preferences (see this file's own header comment).
  const percent = visualSimilarity != null ? ratio * 0.7 + Math.max(0, visualSimilarity) * 0.3 : ratio;

  return { percent, matched };
}

function scoreCategory(profile: UserStyleProfile, listing: VisualListingAnalysis): { percent: number; matched: boolean } {
  if (!profile.preferredCategories || profile.preferredCategories.length === 0) return { percent: 1, matched: false };
  const matched = profile.preferredCategories.includes(listing.category);
  return { percent: matched ? 1 : 0, matched };
}

function scorePrice(budgetMax: number | null | undefined, price: number | null | undefined): number {
  if (budgetMax == null) return 1; // no budget stated -> neutral, same "never penalize an unset preference" convention as bundle-ranking.ts
  if (price == null) return 0.5; // unknown price -> can't confirm, don't fully penalize
  if (price <= budgetMax) return 1;
  const overBy = (price - budgetMax) / budgetMax;
  return Math.max(0, 1 - overBy); // graceful degrade, not a hard cutoff — matches marketplace-search.ts's own "real match slightly over budget beats nothing" stance
}

/**
 * Weighted composite: visual aesthetic 40%, silhouette 20%, color 15%,
 * category 10%, era/vibe 10%, price 5% (this feature's own spec).
 */
export function calculateVisualMatch(
  listingAnalysis: VisualListingAnalysis & { price?: number | null; imageEmbedding?: number[] | null },
  userStyleProfile: UserStyleProfile,
): VisualMatchResult {
  const aesthetic = scoreVisualAesthetic(userStyleProfile, listingAnalysis, listingAnalysis.imageEmbedding);
  const silhouette = overlapRatio(userStyleProfile.preferredSilhouettes ?? [], [...listingAnalysis.silhouette, ...listingAnalysis.fit]);
  const color = overlapRatio(userStyleProfile.preferredColors ?? [], listingAnalysis.colors);
  const category = scoreCategory(userStyleProfile, listingAnalysis);
  const era = overlapRatio(userStyleProfile.preferredEras ?? [], [listingAnalysis.era]);
  const pricePercent = scorePrice(userStyleProfile.budgetMax, listingAnalysis.price);

  const score =
    aesthetic.percent * WEIGHT_VISUAL_AESTHETIC +
    silhouette.ratio * WEIGHT_SILHOUETTE +
    color.ratio * WEIGHT_COLOR +
    category.percent * WEIGHT_CATEGORY +
    era.ratio * WEIGHT_ERA +
    pricePercent * WEIGHT_PRICE;

  const matching_features: string[] = [
    ...aesthetic.matched,
    ...silhouette.matched,
    ...color.matched,
    ...(category.matched ? [listingAnalysis.category] : []),
    ...era.matched,
  ];

  const mismatches: string[] = [];
  if (aesthetic.percent < 0.3 && userStyleProfile.aesthetics.length > 0) mismatches.push("aesthetic doesn't match stated style");
  if (color.ratio === 0 && (userStyleProfile.preferredColors?.length ?? 0) > 0) mismatches.push("color palette doesn't match");
  if (pricePercent < 0.5) mismatches.push("over stated budget");

  const reasoning =
    matching_features.length > 0
      ? `Matches on ${matching_features.slice(0, 3).join(", ")}.`
      : "Little overlap found with the stated style profile.";

  return {
    score: Math.round(score * 100) / 100,
    matching_features: Array.from(new Set(matching_features)),
    mismatches,
    reasoning,
  };
}
