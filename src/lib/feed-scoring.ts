// Pure liked-item-affinity scoring — no I/O, no React. Originally /feed's
// own exclusive scoring signal before /feed and /discover were merged into
// one page; now blended alongside listing-scoring.ts's onboarding
// style_profiles preference score in discover-feed.ts's fetchDiscoverBatch
// (see that file's own comment), rather than being the only signal.
// Deliberately kept separate from listing-scoring.ts: this is scored
// purely from what the user has actually liked — no onboarding, no
// popularity, no global-saves signal at all.
//
// Three signals, each capped so they sum to exactly 100:
//   A) Direct aesthetic tag match   0-50  (+10 per shared tag)
//   B) Related style similarity     0-25  (+5 per related-but-not-identical tag)
//   C) Listing keyword similarity   0-25  (+5 per shared meaningful word in
//                                          title/description vs liked items)
import { areStylesRelated } from "@/lib/style-relationships";
import { assessListingAgainstDislikedStyles, type DislikedStyles } from "@/lib/disliked-styles";

// Admin-Only Listing Removal's "Hide (Low Quality)" (Step 7,
// src/lib/adminListingRemoval.ts) — deprioritize, don't exclude. Same
// value/shape as listing-scoring.ts's own constant of the same name,
// duplicated rather than imported since these two files are deliberately
// independent (see this file's own top-of-file comment).
const LOW_QUALITY_PENALTY = 30;

// Inventory Intelligence integration — same bonus/tag-merging shape as
// listing-scoring.ts's own identically-named constant/helper (duplicated
// rather than imported, matching this file's own "deliberately kept
// separate" convention already used for LOW_QUALITY_PENALTY above). Purely
// additive, 0 when not yet AI-analyzed.
const INVENTORY_QUALITY_BONUS_MAX = 15;

function combinedListingTags(listing: { aesthetic_tags: string[]; visual_analysis?: { aesthetic_tags: string[]; style_attributes: string[] } | null }): string[] {
  if (!listing.visual_analysis) return listing.aesthetic_tags;
  return [...listing.aesthetic_tags, ...listing.visual_analysis.aesthetic_tags, ...listing.visual_analysis.style_attributes];
}

function normalize(tag: string): string {
  return tag.trim().toLowerCase().replace(/^#/, "");
}

/**
 * Every distinct tag across the user's liked listings, ranked most-liked
 * first. Returns [] if the user hasn't liked anything yet — callers use
 * that to mean "don't score/sort at all," not "score everything 0."
 */
export function getLikedTags(likedTagLists: string[][]): string[] {
  const counts = new Map<string, number>();
  for (const tags of likedTagLists) {
    for (const tag of tags) {
      const key = normalize(tag);
      if (!key) continue;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }

  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([tag]) => tag);
}

const DIRECT_TAG_POINTS = 10;
const DIRECT_MAX = 50;

const RELATED_TAG_POINTS = 5;
const RELATED_MAX = 25;

const KEYWORD_POINTS = 5;
const KEYWORD_MAX = 25;

// A) +10 per tag the listing shares exactly with anything the user has
// liked, capped at 50.
function scoreDirectTags(likedTags: string[], listingTags: string[]): number {
  const likedSet = new Set(likedTags);
  const listingSet = new Set(listingTags.map(normalize));
  let matches = 0;
  for (const tag of listingSet) {
    if (likedSet.has(tag)) matches += 1;
  }
  return Math.min(DIRECT_MAX, matches * DIRECT_TAG_POINTS);
}

// B) +5 per listing tag that's related (not identical — those are already
// covered by signal A) to something the user has liked, capped at 25.
function scoreRelatedStyles(likedTags: string[], listingTags: string[]): { score: number; relatedMatches: string[] } {
  const likedSet = new Set(likedTags);
  const listingSet = new Set(listingTags.map(normalize));
  const relatedMatches: string[] = [];

  for (const listingTag of listingSet) {
    if (likedSet.has(listingTag)) continue; // exact match, already scored by signal A
    if (likedTags.some((likedTag) => areStylesRelated(likedTag, listingTag))) {
      relatedMatches.push(listingTag);
    }
  }

  return { score: Math.min(RELATED_MAX, relatedMatches.length * RELATED_TAG_POINTS), relatedMatches };
}

// Words too generic to count as a "meaningful" keyword match on their own —
// connectors, condition/quality filler, and common size tokens.
const KEYWORD_STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "for", "with", "in", "on", "of", "to", "by", "from", "is", "are",
  "this", "that", "size", "sz", "fit", "new", "used", "great", "good", "condition", "perfect",
  "cute", "super", "so", "very", "no", "international", "shipping", "dm", "questions", "please",
  "xs", "s", "m", "l", "xl", "xxl", "small", "medium", "large",
]);

function extractKeywords(text: string): Set<string> {
  const words = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  return new Set(words.filter((word) => word.length > 2 && !KEYWORD_STOPWORDS.has(word)));
}

// C) +5 per meaningful word (title/description) the listing shares with
// the user's liked items' combined text, capped at 25.
function scoreKeywordSimilarity(
  likedKeywords: Set<string>,
  listingTitle: string,
  listingDescription: string | null,
): { score: number; keywordMatches: string[] } {
  const listingKeywords = extractKeywords(`${listingTitle} ${listingDescription ?? ""}`);
  const keywordMatches = [...listingKeywords].filter((word) => likedKeywords.has(word));
  return { score: Math.min(KEYWORD_MAX, keywordMatches.length * KEYWORD_POINTS), keywordMatches };
}

/** Combines every liked item's title+description into one keyword set. */
export function getLikedKeywords(likedTextPairs: Array<{ title: string; description: string | null }>): Set<string> {
  const combined = new Set<string>();
  for (const { title, description } of likedTextPairs) {
    for (const word of extractKeywords(`${title} ${description ?? ""}`)) {
      combined.add(word);
    }
  }
  return combined;
}

export interface ScoredFeedListing<T> {
  listing: T;
  // null means "the user hasn't liked anything yet" — there's no taste
  // signal to score against, so the UI should hide the % badge entirely
  // rather than show a hollow 0%.
  score: number | null;
}

/**
 * Attaches a combined direct/related/keyword score to each listing and
 * sorts descending (ties keep their incoming order — pass listings
 * pre-sorted by recency). When likedTags is empty, every listing gets
 * score: null and the incoming order is left untouched — no scoring
 * happens at all in that case.
 *
 * `dislikedStyles` (style_profiles.disliked_styles — see
 * src/lib/disliked-styles.ts) is RANKING ONLY — every listing passed in
 * comes back out, never removed, regardless of whether likedTags is
 * empty. A style disliked 4+ times recently costs a heavier point penalty
 * (assessListingAgainstDislikedStyles' own penalty value already scales up
 * for that case — see that function's doc comment); it does not exclude a
 * listing outright. Discover must always be able to show the full active
 * inventory — personalization here only ever reorders it.
 */
export function scoreAndSortByLikedTags<
  T extends {
    title: string;
    description: string | null;
    aesthetic_tags: string[];
    is_low_quality?: boolean | null;
    visual_analysis?: { aesthetic_tags: string[]; style_attributes: string[] } | null;
    inventory_quality_score?: number | null;
  },
>(
  listings: T[],
  likedTags: string[],
  likedKeywords: Set<string>,
  dislikedStyles: DislikedStyles = {},
  now: number = Date.now(),
): ScoredFeedListing<T>[] {
  const withDislikePenalty = listings.map((listing) => ({
    listing,
    dislikePenalty: assessListingAgainstDislikedStyles(listing.aesthetic_tags, dislikedStyles, now),
  }));

  if (likedTags.length === 0) {
    // No scoring happens here (see this function's own doc comment), but
    // "Hide (Low Quality)" (src/lib/adminListingRemoval.ts) still applies
    // — a stable sort keyed only on is_low_quality pushes those listings
    // after everything else while leaving each group's relative order
    // (recency) untouched.
    return withDislikePenalty
      .map(({ listing }) => ({ listing, score: null }))
      .sort((a, b) => Number(Boolean(a.listing.is_low_quality)) - Number(Boolean(b.listing.is_low_quality)));
  }

  return withDislikePenalty
    .map(({ listing, dislikePenalty }) => {
      const listingTags = combinedListingTags(listing);
      const directScore = scoreDirectTags(likedTags, listingTags);
      const { score: relatedScore, relatedMatches } = scoreRelatedStyles(likedTags, listingTags);
      const { score: keywordScore, keywordMatches } = scoreKeywordSimilarity(
        likedKeywords,
        listing.title,
        listing.description,
      );

      const lowQualityPenalty = listing.is_low_quality ? LOW_QUALITY_PENALTY : 0;
      const qualityBonus =
        listing.inventory_quality_score != null ? listing.inventory_quality_score * INVENTORY_QUALITY_BONUS_MAX : 0;
      const total = Math.max(
        0,
        Math.min(100, directScore + relatedScore + keywordScore) - dislikePenalty.penalty - lowQualityPenalty + qualityBonus,
      );

      console.log("[feed-debug]", {
        likedTags,
        listingTags: listing.aesthetic_tags,
        relatedMatches,
        keywordMatches,
        dislikePenalty: dislikePenalty.penalty,
      });
      console.log("[feed-score]", { total });

      return { listing, score: total };
    })
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
}
