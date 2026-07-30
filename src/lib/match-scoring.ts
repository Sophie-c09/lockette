// Pure scoring logic for the personalized /match page — reorders/filters
// real listings by shared aesthetic_tags with what the user has already
// liked, and computes the displayed match percentage. No I/O, no React.
//
// Deliberately separate from listing-scoring.ts (used by /discover, which
// scores against onboarding style_profiles preferences instead) and from
// feed-scoring.ts (used by /feed, which scores purely against liked-item
// tags with no Style DNA/onboarding component at all) — all three pages
// read the same `listings` table but score it differently on purpose.
import { assessListingAgainstDislikedStyles, type DislikedStyles } from "@/lib/disliked-styles";

// Strips a leading "#" in addition to the usual trim+lowercase: real
// listing.aesthetic_tags are hashtag-prefixed (e.g. "#Y2K", set by
// clean-description.ts's hashtag extraction), while style_profiles.style_tags
// and onboarding answers are plain words (e.g. "Y2K") — without stripping
// the "#" here, every comparison between the two would silently fail even
// when the same tag genuinely exists on both sides. This was the root
// cause of styleScore always coming back 0 for real users with real
// overlapping preferences.
function normalize(tag: string): string {
  return tag.trim().toLowerCase().replace(/^#/, "");
}

/**
 * Top N most frequent tags across a set of tag lists (e.g. the
 * aesthetic_tags of listings the user has already saved), most-frequent
 * first. Returns [] if there's nothing to derive a profile from.
 *
 * excludeTags (a user's currently hard-excluded styles — see
 * disliked-styles.ts's getHardExcludedStyleKeys) is filtered out BEFORE
 * ranking, not after: a user can heavily like a style overall
 * (saved_items) while also having disliked 4+ specific listings that
 * happen to share that same tag (disliked_items) — those are independent
 * signals, and a heavily-disliked tag shouldn't win a "top liked tag"
 * slot and get treated as positive ranking signal by sortByTagAffinity
 * just because it's frequent in saved_items too. This only affects which
 * tags count as positive signal for RANKING — it has no bearing on which
 * listings are eligible at all (sortByTagAffinity never excludes; see its
 * own comment).
 */
export function getTopTags(tagLists: string[][], count = 3, excludeTags: Set<string> = new Set()): string[] {
  const counts = new Map<string, number>();
  for (const tags of tagLists) {
    for (const tag of tags ?? []) {
      const key = normalize(tag);
      if (!key || excludeTags.has(key)) continue;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, count)
    .map(([tag]) => tag);
}

function scoreTagOverlap(topTags: string[], listingTags: string[]): number {
  const listingTagSet = new Set((listingTags ?? []).map(normalize));
  const mostFrequent = topTags[0];
  let total = 0;
  for (const tag of topTags) {
    if (listingTagSet.has(tag)) {
      total += 2;
      if (tag === mostFrequent) total += 1;
    }
  }
  return total;
}

/**
 * RANKING ONLY — every listing passed in comes back out, just reordered
 * by tag-overlap score descending (Array.sort is stable, so ties keep
 * their incoming order — pass listings pre-sorted by recency for a
 * sensible tiebreaker). Style/aesthetic compatibility must never remove
 * a listing from /match's swipe queue (every active, not-yet-interacted-
 * with listing has to stay eligible) — this used to also `.filter(score
 * > 0)`, hard-excluding anything sharing zero tags with topTags; that's
 * exactly the kind of style-based exclusion this function must NOT do
 * anymore, so it was removed. Callers can still skip calling this (and
 * just use the full listing set as-is) when topTags is empty — there's
 * nothing to rank by yet, e.g. a new user with no likes.
 */
export function sortByTagAffinity<T extends { aesthetic_tags: string[] }>(
  listings: T[],
  topTags: string[],
): T[] {
  return listings
    .map((listing) => ({ listing, score: scoreTagOverlap(topTags, listing.aesthetic_tags) }))
    .sort((a, b) => b.score - a.score)
    .map(({ listing }) => listing);
}

// ---------------------------------------------------------------------------
// Match percentage — a separate, display-only score (0-100) shown on each
// card, based purely on user taste (Style DNA, onboarding quiz answers, and
// liked-item similarity). Deliberately independent from
// sortByTagAffinity above: that function only reorders; this only
// computes a number to display. Neither one removes listings. No
// popularity/global-saves signal is used here at all.
// ---------------------------------------------------------------------------

const STYLE_TAG_POINTS = 10;
const STYLE_MAX = 50;

const ONBOARDING_BRAND_POINTS = 10;
const ONBOARDING_CATEGORY_POINTS = 10;
const ONBOARDING_COLOR_POINTS = 5;
const ONBOARDING_SIZE_POINTS = 5;
const ONBOARDING_MAX = 30;

const LIKES_TAG_POINTS = 5;
const LIKES_TOP_TAG_BONUS = 5;
const LIKES_MAX = 20;

// Used only when the user has neither Style DNA nor onboarding answers at
// all (a genuinely blank profile) — a real 0% there would read as broken,
// since there's no taste data to actually be a "0% match" against. Not a
// per-listing floor: a listing that DOES share nothing with a user who HAS
// real preference data still legitimately scores low/zero on its own.
const NEUTRAL_BASELINE = 50;

export interface MatchScoreBreakdown {
  styleScore: number;
  onboardingScore: number;
  likesScore: number;
  // Point deduction from style_profiles.disliked_styles (see
  // src/lib/disliked-styles.ts), scaled by each matching signal's own
  // frequency/recency — 0 when nothing overlaps. A style disliked 4+ times
  // recently isn't handled here at all: that's a full exclusion, applied
  // upstream in match-feed.ts before this function ever runs for that
  // listing.
  dislikePenalty: number;
  total: number;
}

function debugLogScore(breakdown: MatchScoreBreakdown): void {
  console.log("[match-score]");
  console.log(`styleScore: ${breakdown.styleScore}`);
  console.log(`onboardingScore: ${breakdown.onboardingScore}`);
  console.log(`likesScore: ${breakdown.likesScore}`);
  console.log(`dislikePenalty: ${breakdown.dislikePenalty}`);
  console.log(`total: ${breakdown.total}`);
}

// A) Style DNA match (0-50): +10 per distinct tag shared between the
// listing and the user's onboarding style_profiles.style_tags.
function scoreStyleDna(listingTags: string[], stylePreferences: string[]): number {
  if (stylePreferences.length === 0) return 0;
  const listingTagSet = new Set((listingTags ?? []).map(normalize));
  const preferenceSet = new Set(stylePreferences.map(normalize));
  let matches = 0;
  for (const tag of preferenceSet) {
    if (listingTagSet.has(tag)) matches += 1;
  }
  return Math.min(STYLE_MAX, matches * STYLE_TAG_POINTS);
}

interface OnboardingListingFields {
  brand: string | null;
  category: string | null;
  color: string | null;
  size: string | null;
}

interface OnboardingPreferences {
  favoriteBrands: string[];
  favoriteCategories: string[];
  favoriteColors: string[];
  sizePreference: string | null;
}

function hasOnboardingSignal(onboarding: OnboardingPreferences): boolean {
  return (
    onboarding.favoriteBrands.length > 0 ||
    onboarding.favoriteCategories.length > 0 ||
    onboarding.favoriteColors.length > 0 ||
    Boolean(onboarding.sizePreference)
  );
}

// Real scraped brand/category text is often a compound/variant phrase
// rather than the exact word a user picked during onboarding (e.g. listing
// brand "Hollister Co." vs onboarding pick "Hollister"; listing category
// "Women T-shirts" vs onboarding pick "Tops"). Bidirectional substring
// matching catches these without requiring exact equality — used for
// brand/category/color, but deliberately NOT for size, where substring
// matching would wrongly match "S" inside "XS".
function includesEitherWay(a: string, b: string): boolean {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na || !nb) return false;
  return na.includes(nb) || nb.includes(na);
}

// B) Onboarding quiz match (0-30): brand/category are the "strong" signals
// (+10 each), color/size preference are lighter-weight (+5 each) — the four
// add up to exactly the 30 cap when every field matches.
function scoreOnboardingMatch(
  listing: OnboardingListingFields,
  onboarding: OnboardingPreferences,
): number {
  let total = 0;

  if (listing.brand && onboarding.favoriteBrands.some((brand) => includesEitherWay(brand, listing.brand!))) {
    total += ONBOARDING_BRAND_POINTS;
  }
  if (
    listing.category &&
    onboarding.favoriteCategories.some((category) => includesEitherWay(category, listing.category!))
  ) {
    total += ONBOARDING_CATEGORY_POINTS;
  }
  if (listing.color && onboarding.favoriteColors.some((color) => includesEitherWay(color, listing.color!))) {
    total += ONBOARDING_COLOR_POINTS;
  }
  if (listing.size && onboarding.sizePreference && normalize(listing.size) === normalize(onboarding.sizePreference)) {
    total += ONBOARDING_SIZE_POINTS;
  }

  return Math.min(ONBOARDING_MAX, total);
}

// C) Liked-item similarity (0-20): +5 per overlapping top-liked tag, +5
// bonus if the overlap includes the single most-liked tag.
function scoreLikesSimilarity(listingTags: string[], topLikedTags: string[]): number {
  if (topLikedTags.length === 0) return 0;
  const listingTagSet = new Set((listingTags ?? []).map(normalize));
  const mostFrequent = topLikedTags[0];
  let total = 0;
  for (const tag of topLikedTags) {
    if (listingTagSet.has(tag)) {
      total += LIKES_TAG_POINTS;
      if (tag === mostFrequent) total += LIKES_TOP_TAG_BONUS;
    }
  }
  return Math.min(LIKES_MAX, total);
}

export interface MatchScoreInputs {
  listingTags: string[];
  listingBrand: string | null;
  listingCategory: string | null;
  listingColor: string | null;
  listingSize: string | null;
  stylePreferences: string[];
  favoriteBrands: string[];
  favoriteCategories: string[];
  favoriteColors: string[];
  sizePreference: string | null;
  topLikedTags: string[];
  // style_profiles.disliked_styles (src/lib/disliked-styles.ts) — a soft
  // penalty here (see dislikePenalty above), not a filter; the full
  // hard-exclusion case (a style disliked 4+ times recently) happens
  // upstream, before this is ever called for a listing that qualifies.
  dislikedStyles: DislikedStyles;
  // Same clock reading used for the exclusion check upstream — passed in
  // rather than read via Date.now() here so a single scoring pass is
  // internally consistent about "now," and so this stays a pure function.
  now: number;
}

export function scoreListingMatch(inputs: MatchScoreInputs): MatchScoreBreakdown {
  const onboarding: OnboardingPreferences = {
    favoriteBrands: inputs.favoriteBrands,
    favoriteCategories: inputs.favoriteCategories,
    favoriteColors: inputs.favoriteColors,
    sizePreference: inputs.sizePreference,
  };

  const styleScore = scoreStyleDna(inputs.listingTags, inputs.stylePreferences);
  const onboardingScore = scoreOnboardingMatch(
    {
      brand: inputs.listingBrand,
      category: inputs.listingCategory,
      color: inputs.listingColor,
      size: inputs.listingSize,
    },
    onboarding,
  );
  const likesScore = scoreLikesSimilarity(inputs.listingTags, inputs.topLikedTags);
  const dislikePenalty = assessListingAgainstDislikedStyles(
    inputs.listingTags,
    inputs.dislikedStyles,
    inputs.now,
  ).penalty;

  const hasStyleDna = inputs.stylePreferences.length > 0;
  const hasOnboarding = hasOnboardingSignal(onboarding);

  // If NO likes yet -> styleScore + onboardingScore still apply normally
  // (likesScore is just naturally 0, not forced). If NO onboarding ->
  // styleScore + likesScore still apply normally. Only when BOTH core
  // profile signals are entirely missing does this fall back to a neutral
  // baseline instead of a bare sum that would otherwise read as "0% for a
  // brand-new user" — likesScore (if any) still nudges it above baseline.
  const total =
    (!hasStyleDna && !hasOnboarding
      ? NEUTRAL_BASELINE + likesScore
      : styleScore + onboardingScore + likesScore) - dislikePenalty;

  const clamped = Math.max(0, Math.min(100, Math.round(total)));

  const breakdown = { styleScore, onboardingScore, likesScore, dislikePenalty, total: clamped };
  debugLogScore(breakdown);
  return breakdown;
}

/**
 * Attaches a `matchPercent` (0-100) to each listing using the combined
 * style-DNA / onboarding / liked-tag-affinity score above. No popularity
 * signal is used.
 */
export function attachMatchPercent<
  T extends {
    aesthetic_tags: string[];
    brand: string | null;
    category: string | null;
    color: string | null;
    size: string | null;
  },
>(
  listings: T[],
  options: {
    stylePreferences: string[];
    favoriteBrands: string[];
    favoriteCategories: string[];
    favoriteColors: string[];
    sizePreference: string | null;
    topLikedTags: string[];
    dislikedStyles: DislikedStyles;
    now: number;
  },
): (T & { matchPercent: number })[] {
  return listings.map((listing) => {
    // Required debug visibility into what's actually flowing into the
    // scorer for this listing, before scoring runs — makes it obvious at a
    // glance if any of these three inputs is unexpectedly empty.
    console.log("[match-debug]", {
      listingTags: listing.aesthetic_tags,
      styleTags: options.stylePreferences,
      likedTags: options.topLikedTags,
    });

    const { total } = scoreListingMatch({
      listingTags: listing.aesthetic_tags,
      listingBrand: listing.brand,
      listingCategory: listing.category,
      listingColor: listing.color,
      listingSize: listing.size,
      stylePreferences: options.stylePreferences,
      favoriteBrands: options.favoriteBrands,
      favoriteCategories: options.favoriteCategories,
      favoriteColors: options.favoriteColors,
      sizePreference: options.sizePreference,
      topLikedTags: options.topLikedTags,
      dislikedStyles: options.dislikedStyles,
      now: options.now,
    });
    return { ...listing, matchPercent: total };
  });
}
