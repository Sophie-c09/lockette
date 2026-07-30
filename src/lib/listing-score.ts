// Style-relevance scoring for the admin scraper's score-and-rank
// architecture — see admin-scraper-filter.ts's own header comment for the
// full context this replaced (a hard reject/threshold pipeline). Pure,
// synchronous, no I/O, same "cheap enough to run against every candidate"
// convention as style-score.ts's own scoreListingStyle.
export interface ScorableListing {
  title: string;
  price: number | null;
  images: string[];
  // matched_style from scoreListingStyle (style-score.ts) — one of the
  // archetype names in style-signals.ts (e.g. "boho_y2k", "soft_feminine",
  // "y2k_casual"), or null if nothing matched.
  style: string | null;
}

/**
 * Computes a candidate's ranking score — higher is more style-relevant.
 * There is no threshold/reject here: every candidate that clears the two
 * minimal quality gates (admin-scraper-filter.ts's
 * passesMinimalQualityFilters) gets a score and is imported as 'pending'
 * regardless of how low it is. Discover orders by this value (score desc,
 * created_at desc — see discover-feed.ts) instead of the scraper deciding
 * in advance what's "good enough."
 */
export function calculateScore(item: ScorableListing): number {
  let score = 0;

  if (item.style === "boho_y2k") score += 50;
  if (item.style === "soft_feminine") score += 40;
  if (item.price && item.price < 50) score += 20;
  if (item.images?.length >= 4) score += 10;
  if (item.title?.toLowerCase().includes("low rise")) score += 30;

  return score;
}
