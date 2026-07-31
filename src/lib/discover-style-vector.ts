// Deterministic per-user style representation for /discover — built
// entirely from data already in Postgres (saved_items, user_style_feedback,
// style_profiles), no AI call of any kind. This is the direct fix for
// Discover surfacing unfashionable/mismatched inventory: the previous
// pipeline (match-scoring.ts's scoreListingMatch, still used by /match)
// only ever compared aesthetic_tags — broad vibe words like "coquette" or
// "y2k" — so a floral maxi skirt and a fitted lace top could score
// identically for a user who only actually likes the top, as long as both
// happened to share one aesthetic tag. This module instead extracts
// garment-level attributes (specific garment noun, category, silhouette,
// color, pattern, material, brand, price) from what the user has actually
// liked/engaged with, weighted by signal type and recency, so
// src/lib/discover-personalization.ts's scoreGarmentStyleMatch can require
// a real garment-level resemblance, not just a shared vibe tag.
//
// No I/O here — pure functions only, same "data fetching lives in
// discover-feed.ts, scoring/vector-building is pure and testable"
// convention already used by match-scoring.ts/feed-scoring.ts.
import { categorizeListing, type CategoryBucket } from "@/lib/bulk-import";
import { ITEM_TYPE_CATEGORIES } from "@/lib/item-type-categories";
import type { ExtractedListing } from "@/lib/extraction/normalize-listing";
import type { VisualListingAnalysis } from "@/lib/ai/visual-listing-analysis";

export type WeightedTerms = Map<string, number>;

export interface LikedListingAttributes {
  id: string;
  title: string;
  category: string | null;
  brand: string | null;
  color: string | null;
  price: number | null;
  aesthetic_tags: string[];
  visual_analysis?: VisualListingAnalysis | null;
}

export interface UserStyleVector {
  // False only for a genuinely blank profile (no likes, no feedback, no
  // onboarding at all) — callers use this to fall back to a neutral
  // baseline instead of scoring against an empty vector, same reasoning
  // as match-scoring.ts's own NEUTRAL_BASELINE.
  hasSignal: boolean;
  garmentTerms: WeightedTerms;
  categoryTerms: WeightedTerms;
  aestheticTerms: WeightedTerms;
  silhouetteTerms: WeightedTerms;
  colorTerms: WeightedTerms;
  patternTerms: WeightedTerms;
  materialTerms: WeightedTerms;
  brandTerms: WeightedTerms;
  priceRange: { median: number; min: number; max: number } | null;
}

export interface BuildStyleVectorInput {
  now: number;
  styleProfile: {
    styleTags: string[];
    favoriteBrands: string[];
    favoriteCategories: string[];
    favoriteColors: string[];
  } | null;
  // saved_items (the user's current Likes) — every liked listing's own
  // attributes, paired with WHEN it was liked (saved_items.created_at).
  // This is the single strongest signal (45%, per this feature's spec).
  likedListings: Array<{ listing: LikedListingAttributes; occurredAt: string }>;
  // user_style_feedback rows with action in ('save', 'purchase') — the
  // append-only behavioral log (distinct from the CURRENT saved_items
  // state above: it still includes items later unsaved, and captures
  // purchases). Recency-weighted on top of the base Likes signal (15%),
  // so a user's MOST RECENT positive engagement pulls the feed toward it
  // faster than plain Likes recency alone would.
  feedbackListings: Array<{ listing: LikedListingAttributes; occurredAt: string }>;
  // Aesthetic-tag keys currently hard-excluded (disliked 4+ times,
  // recently — see src/lib/disliked-styles.ts's getHardExcludedStyleKeys)
  // stripped from aestheticTerms after building it, same "a heavily
  // disliked style can't win a positive ranking slot just because it's
  // also frequent in Likes" reasoning match-scoring.ts already applies to
  // its own topLikedTags derivation.
  hardExcludedAestheticKeys: Set<string>;
}

// Generic vibe words this feature's spec calls out by name — these
// contribute far less per-match than a specific garment/silhouette/
// material attribute (dampened here, at vector-construction time, rather
// than a second dampening pass at match time — one source of truth for
// "how much does this tag actually tell you").
const GENERIC_AESTHETIC_TERMS = new Set(["vintage", "cute", "casual", "trendy", "feminine", "y2k"]);
const GENERIC_TAG_DAMPENING = 0.35;

const RECENCY_HALF_LIFE_DAYS = 30;
// A like/interaction from a year ago still counts for something (taste
// persists), just far less than one from yesterday — never fully zeroed.
const RECENCY_FLOOR = 0.08;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function normalizeTerm(raw: string): string {
  return raw.trim().toLowerCase().replace(/^#/, "");
}

function recencyWeight(iso: string, nowMs: number): number {
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return 1; // no/garbled timestamp -> don't penalize, just don't decay
  const ageDays = Math.max(0, (nowMs - parsed) / MS_PER_DAY);
  const decayed = Math.pow(0.5, ageDays / RECENCY_HALF_LIFE_DAYS);
  return Math.max(RECENCY_FLOOR, decayed);
}

function addTerm(map: WeightedTerms, raw: string | null | undefined, weight: number, dampenGeneric = false): void {
  if (!raw || weight <= 0) return;
  const key = normalizeTerm(raw);
  if (!key) return;
  const finalWeight = dampenGeneric && GENERIC_AESTHETIC_TERMS.has(key) ? weight * GENERIC_TAG_DAMPENING : weight;
  map.set(key, (map.get(key) ?? 0) + finalWeight);
}

function addTerms(map: WeightedTerms, raws: string[] | undefined, weight: number, dampenGeneric = false): void {
  for (const raw of raws ?? []) addTerm(map, raw, weight, dampenGeneric);
}

// Specific garment nouns (cami, blazer, sneaker, ...) reused from
// item-type-categories.ts's own ?type= vocabulary — genuinely specific
// terms, not aesthetic vibes. Used as the fallback source of "garment
// type" for a liked listing that hasn't been through the visual_analysis
// enrichment pipeline yet (visual_analysis.garment_type is preferred when
// present, since it's a real per-photo AI read rather than a keyword
// guess against title/category text).
function extractGarmentNouns(title: string, category: string | null): string[] {
  const haystack = `${title} ${category ?? ""}`.toLowerCase();
  const found: string[] = [];
  for (const type of ITEM_TYPE_CATEGORIES) {
    for (const keyword of type.categoryKeywords) {
      if (haystack.includes(keyword)) found.push(keyword);
    }
  }
  return found;
}

function bucketOf(listing: Pick<LikedListingAttributes, "title" | "category">): CategoryBucket {
  return categorizeListing({ title: listing.title, category: listing.category } as ExtractedListing);
}

interface MutableVectorMaps {
  garmentTerms: WeightedTerms;
  categoryTerms: WeightedTerms;
  aestheticTerms: WeightedTerms;
  silhouetteTerms: WeightedTerms;
  colorTerms: WeightedTerms;
  patternTerms: WeightedTerms;
  materialTerms: WeightedTerms;
  brandTerms: WeightedTerms;
}

function emptyVectorMaps(): MutableVectorMaps {
  return {
    garmentTerms: new Map(),
    categoryTerms: new Map(),
    aestheticTerms: new Map(),
    silhouetteTerms: new Map(),
    colorTerms: new Map(),
    materialTerms: new Map(),
    patternTerms: new Map(),
    brandTerms: new Map(),
  };
}

// Injects one liked/engaged-with listing's attributes into the shared
// term maps at the given weight, and returns what it contributed to the
// "repeated garment/category" occurrence tally (see buildUserStyleVector's
// own section 4) — every signal bucket that touches a real listing
// (Likes, positive feedback) goes through this one function so garment/
// category/aesthetic/silhouette/color/pattern/material/brand extraction
// stays identical regardless of which bucket is injecting it.
function injectListingAttributes(vectors: MutableVectorMaps, listing: LikedListingAttributes, weight: number): { garmentNouns: string[]; bucket: CategoryBucket } {
  const va = listing.visual_analysis ?? null;

  const garmentNouns = va?.garment_type?.length ? va.garment_type : extractGarmentNouns(listing.title, listing.category);
  addTerms(vectors.garmentTerms, garmentNouns, weight);

  const bucket = bucketOf(listing);
  if (bucket !== "other") addTerm(vectors.categoryTerms, bucket, weight);
  if (listing.category) addTerm(vectors.categoryTerms, listing.category, weight * 0.5);

  addTerms(vectors.aestheticTerms, listing.aesthetic_tags, weight, true);
  addTerms(vectors.aestheticTerms, va?.aesthetic_tags, weight, true);
  // style_attributes (e.g. "90s minimalist", "coastal grandmother") are
  // specific fashion vocabulary by design (see visual-listing-analysis.ts's
  // own prompt) — no generic dampening.
  addTerms(vectors.aestheticTerms, va?.style_attributes, weight);

  addTerms(vectors.silhouetteTerms, va?.silhouette, weight);
  addTerms(vectors.silhouetteTerms, va?.fit, weight);

  addTerm(vectors.colorTerms, listing.color, weight);
  addTerms(vectors.colorTerms, va?.colors, weight);
  addTerms(vectors.patternTerms, va?.patterns, weight);
  addTerms(vectors.materialTerms, va?.materials, weight);

  addTerm(vectors.brandTerms, listing.brand, weight);

  return { garmentNouns, bucket };
}

function bumpOccurrence(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

// Distributes recency weight across a bucket's fixed point budget so
// individual items keep their relative recency-weighted proportions
// (recent ones earn more of the bucket than stale ones) while the bucket
// AS A WHOLE always injects exactly `bucketTotal` units of weight — this
// is what makes "45% Likes / 15% positive interactions" a real, enforced
// ratio rather than a vague aspiration, regardless of how many items are
// in each bucket.
function injectBucket(
  vectors: MutableVectorMaps,
  entries: Array<{ listing: LikedListingAttributes; occurredAt: string }>,
  bucketTotal: number,
  now: number,
  categoryOccurrences: Map<string, number>,
  priceSamples: Array<{ price: number; weight: number }>,
): void {
  if (entries.length === 0) return;

  const recencyWeights = entries.map(({ occurredAt }) => recencyWeight(occurredAt, now));
  const weightSum = recencyWeights.reduce((a, b) => a + b, 0);

  entries.forEach(({ listing }, i) => {
    const share = weightSum > 0 ? recencyWeights[i] / weightSum : 1 / entries.length;
    const weight = bucketTotal * share;
    const { garmentNouns, bucket } = injectListingAttributes(vectors, listing, weight);

    for (const noun of garmentNouns) bumpOccurrence(categoryOccurrences, `g:${normalizeTerm(noun)}`);
    if (bucket !== "other") bumpOccurrence(categoryOccurrences, `c:${bucket}`);

    if (listing.price != null && listing.price > 0) priceSamples.push({ price: listing.price, weight });
  });
}

function topUpMostFrequent(map: WeightedTerms, amount: number): void {
  if (map.size === 0 || amount <= 0) return;
  let bestKey: string | null = null;
  let bestWeight = -Infinity;
  for (const [key, weight] of map.entries()) {
    if (weight > bestWeight) {
      bestWeight = weight;
      bestKey = key;
    }
  }
  if (bestKey) map.set(bestKey, (map.get(bestKey) ?? 0) + amount);
}

function computePriceRange(samples: Array<{ price: number; weight: number }>): UserStyleVector["priceRange"] {
  if (samples.length === 0) return null;
  const prices = samples.map((s) => s.price);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const weightSum = samples.reduce((a, s) => a + s.weight, 0);
  // Weighted average as a practical stand-in for a true weighted median —
  // recency-weighted, so a user's CURRENT price comfort zone (not their
  // all-time average) sets the center.
  const median = weightSum > 0 ? samples.reduce((a, s) => a + s.price * s.weight, 0) / weightSum : prices.reduce((a, b) => a + b, 0) / prices.length;
  return { median, min, max };
}

/**
 * Builds a deterministic style vector from what the user has actually
 * liked/engaged with plus their onboarding answers, weighted per this
 * feature's spec:
 *   45% liked/saved listings (recency-weighted)
 *   25% selected profile aesthetic tags (+ favorite brand/category/color)
 *   15% positive swipe/interaction history (recency-weighted, additive)
 *   10% repeated garment/category preference (bonus for anything the
 *       user has engaged with 2+ times, across every bucket above)
 *    5% brand/color/material tendencies (top-up to the single most
 *       frequent value in each)
 * Percentages are relative signal-injection weights, not a normalized
 * probability distribution — a user with plenty of Likes but no
 * onboarding answers still gets a fully usable vector, just without the
 * 25% bucket's contribution; nothing is redistributed to compensate,
 * since sections with real signal should simply carry more absolute
 * weight than one with none.
 */
export function buildUserStyleVector(input: BuildStyleVectorInput): UserStyleVector {
  const vectors = emptyVectorMaps();
  const categoryOccurrences = new Map<string, number>();
  const priceSamples: Array<{ price: number; weight: number }> = [];

  // 1. Likes — 45%.
  injectBucket(vectors, input.likedListings, 45, input.now, categoryOccurrences, priceSamples);

  // 2. Onboarding profile — 25%, split across its four fields (aesthetic
  // tags carry the bulk of it; brand/category/color are lighter-weight
  // stated preferences, same relative emphasis match-scoring.ts's own
  // onboarding scoring already uses).
  if (input.styleProfile) {
    const { styleTags, favoriteBrands, favoriteCategories, favoriteColors } = input.styleProfile;
    if (styleTags.length > 0) addTerms(vectors.aestheticTerms, styleTags, 15 / styleTags.length, true);
    if (favoriteCategories.length > 0) {
      addTerms(vectors.categoryTerms, favoriteCategories, 5 / favoriteCategories.length);
      for (const category of favoriteCategories) bumpOccurrence(categoryOccurrences, `c:${normalizeTerm(category)}`);
    }
    if (favoriteBrands.length > 0) addTerms(vectors.brandTerms, favoriteBrands, 3 / favoriteBrands.length);
    if (favoriteColors.length > 0) addTerms(vectors.colorTerms, favoriteColors, 2 / favoriteColors.length);
  }

  // 3. Positive interaction history — 15%, additive on top of the same
  // maps Likes already populated (so an item BOTH saved and recently
  // reinforced by real behavior counts for more than either alone).
  injectBucket(vectors, input.feedbackListings, 15, input.now, categoryOccurrences, priceSamples);

  // 4. Repeated garment/category preference — 10%, distributed only
  // among terms the user has actually engaged with 2+ times (a single
  // one-off Like doesn't qualify) proportional to how many times beyond
  // the first.
  const repeated = [...categoryOccurrences.entries()].filter(([, count]) => count >= 2);
  const repeatedTotal = repeated.reduce((sum, [, count]) => sum + (count - 1), 0);
  if (repeatedTotal > 0) {
    for (const [key, count] of repeated) {
      const bonus = (10 * (count - 1)) / repeatedTotal;
      if (key.startsWith("g:")) addTerm(vectors.garmentTerms, key.slice(2), bonus);
      else if (key.startsWith("c:")) addTerm(vectors.categoryTerms, key.slice(2), bonus);
    }
  }

  // 5. Brand/color/material tendencies — 5%, a small top-up to whichever
  // single value already leads each map (this user's clearest brand/
  // color/material tendency, not a broad re-scoring of every value).
  topUpMostFrequent(vectors.brandTerms, 5 / 3);
  topUpMostFrequent(vectors.colorTerms, 5 / 3);
  topUpMostFrequent(vectors.materialTerms, 5 / 3);

  for (const key of input.hardExcludedAestheticKeys) vectors.aestheticTerms.delete(key);

  const hasSignal =
    input.likedListings.length > 0 ||
    input.feedbackListings.length > 0 ||
    Boolean(
      input.styleProfile &&
        (input.styleProfile.styleTags.length > 0 ||
          input.styleProfile.favoriteBrands.length > 0 ||
          input.styleProfile.favoriteCategories.length > 0 ||
          input.styleProfile.favoriteColors.length > 0),
    );

  return { hasSignal, ...vectors, priceRange: computePriceRange(priceSamples) };
}
