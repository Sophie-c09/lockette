// Pure scoring logic for the personalized /feed page — no I/O, no
// Supabase, no React. Kept separate so the match math is easy to reason
// about (and test) on its own.
import { assessListingAgainstDislikedStyles, type DislikedStyles } from "@/lib/disliked-styles";

function normalize(tag: string): string {
  return tag.trim().toLowerCase();
}

/**
 * Percentage (0-100) of the user's stated aesthetic preferences that a
 * listing's aesthetic_tags satisfy.
 *
 *   score = |preferences ∩ listingTags| / |preferences| * 100
 *
 * Example: preferences ["Y2K", "Coquette"], listing ["Y2K", "Vintage"]
 * -> 1 of 2 preferences matched -> 50.
 *
 * A user with no stated preferences always scores 0 — there's nothing to
 * match against, so nothing can overlap. Comparison is case-insensitive
 * since preference tags (from onboarding) and listing tags (from AI
 * classification) aren't guaranteed to agree on exact casing.
 */
export function scoreListingMatch(
  preferences: string[],
  listingTags: string[],
): number {
  if (preferences.length === 0) return 0;

  const listingTagSet = new Set(listingTags.map(normalize));
  const matchedCount = preferences.filter((tag) =>
    listingTagSet.has(normalize(tag)),
  ).length;

  return Math.round((matchedCount / preferences.length) * 100);
}

export interface ScoredListing<T> {
  listing: T;
  score: number;
}

// Admin-Only Listing Removal's "Hide (Low Quality)" (Step 7,
// src/lib/adminListingRemoval.ts) — deprioritize, don't exclude, so it
// "appears less, but not gone." Same additive-penalty shape as the
// disliked-styles penalty just above, applied independently of it.
const LOW_QUALITY_PENALTY = 30;

// Inventory Intelligence integration — inventory_quality_score (Part 11,
// src/lib/inventory/inventory-quality-score.ts) is 0-1; scaled into a
// small bonus, capped so it can nudge ranking but never dominate the real
// preference-match score. Purely ADDITIVE and only ever applied when the
// column is actually populated (most listings won't have one yet, until
// the indexer — src/lib/inventory/inventory-indexer.ts — has actually
// processed them) — absent/null contributes exactly 0, never a penalty,
// so ranking for not-yet-analyzed inventory behaves exactly as it always
// has.
const INVENTORY_QUALITY_BONUS_MAX = 15;

// Same integration — a listing's visual_analysis (Part 7) carries richer,
// AI-derived aesthetic_tags/style_attributes than the older aesthetic_tags
// column alone (e.g. "coastal grandmother", "dark academia") — folded
// into the SAME tag pool scoreListingMatch already matches against,
// rather than a separate scoring channel, so a listing that's been
// visually analyzed can match on more specific vocabulary without
// changing what "match" means.
function combinedListingTags(listing: { aesthetic_tags: string[]; visual_analysis?: { aesthetic_tags: string[]; style_attributes: string[] } | null }): string[] {
  if (!listing.visual_analysis) return listing.aesthetic_tags;
  return [...listing.aesthetic_tags, ...listing.visual_analysis.aesthetic_tags, ...listing.visual_analysis.style_attributes];
}

/**
 * Attaches a match score to each listing and sorts descending (requirement
 * 3). Array.prototype.sort is a stable sort in every JS engine this app
 * runs on, so listings tied on score keep their incoming relative order —
 * pass listings pre-sorted by recency for a sensible tiebreaker.
 *
 * `dislikedStyles` (style_profiles.disliked_styles — see
 * src/lib/disliked-styles.ts) is RANKING ONLY here — every listing passed
 * in comes back out, never removed. A style disliked 4+ times recently
 * costs a heavier point penalty (via assessment.penalty, which already
 * scales up for a hard-dislike-strength signal — see
 * assessListingAgainstDislikedStyles' own doc comment); it does not
 * exclude a listing outright. Discover must always be able to show the
 * full active inventory (rules out an empty page caused purely by
 * personalization) — only Match's own by-id liked/disliked exclusion
 * (applied upstream by discover-feed.ts/match-feed.ts, not here) actually
 * removes anything. Defaults to {}/now so existing callers that haven't
 * been updated yet behave exactly as before.
 */
export function scoreAndSortListings<
  T extends {
    aesthetic_tags: string[];
    is_low_quality?: boolean | null;
    visual_analysis?: { aesthetic_tags: string[]; style_attributes: string[] } | null;
    inventory_quality_score?: number | null;
  },
>(
  listings: T[],
  preferences: string[],
  dislikedStyles: DislikedStyles = {},
  now: number = Date.now(),
): ScoredListing<T>[] {
  return listings
    .map((listing) => ({
      listing,
      assessment: assessListingAgainstDislikedStyles(listing.aesthetic_tags, dislikedStyles, now),
    }))
    .map(({ listing, assessment }) => {
      const baseScore = scoreListingMatch(preferences, combinedListingTags(listing));
      const lowQualityPenalty = listing.is_low_quality ? LOW_QUALITY_PENALTY : 0;
      const qualityBonus =
        listing.inventory_quality_score != null ? listing.inventory_quality_score * INVENTORY_QUALITY_BONUS_MAX : 0;
      return { listing, score: Math.max(0, baseScore - assessment.penalty - lowQualityPenalty + qualityBonus) };
    })
    .sort((a, b) => b.score - a.score);
}
