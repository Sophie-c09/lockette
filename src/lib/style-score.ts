import { STYLE_SIGNALS } from "./style-signals";

export interface StyleScoreResult {
  score: number;
  style: string | null;
}

/**
 * Scores a candidate against every STYLE_SIGNALS archetype and returns
 * the best match — the archetype name (not an aesthetic_tags value) plus
 * its score. Pure text matching, no AI call: cheap enough to run against
 * every discovered candidate before extraction/AI-enrichment even
 * happens (see admin-scraper.ts).
 */
export function scoreListingStyle(listing: { title: string; description: string | null }): StyleScoreResult {
  const text = `${listing.title} ${listing.description ?? ""}`.toLowerCase();

  let bestScore = 0;
  let matchedStyle: string | null = null;

  for (const [styleName, style] of Object.entries(STYLE_SIGNALS)) {
    let score = 0;

    for (const word of style.required_any) {
      if (text.includes(word)) score += 10;
    }

    if (style.brands?.some((brand) => text.includes(brand))) {
      score += 15;
    }

    if (style.preferred_items?.some((item) => text.includes(item))) {
      score += 10;
    }

    if (style.preferred_colors?.some((color) => text.includes(color))) {
      score += 5;
    }

    if (score > bestScore) {
      bestScore = score;
      matchedStyle = styleName;
    }
  }

  return { score: bestScore, style: matchedStyle };
}
