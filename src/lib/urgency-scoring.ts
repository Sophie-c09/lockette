// Pure scoring logic for the admin fulfillment dashboard — no I/O, no
// React. Estimates how quickly an operator should secure a given item
// before it's likely to sell out on the original marketplace. Kept
// isolated here, same reasoning as pricing.ts: one place to tune the
// factors/weights later.

export interface UrgencyListing {
  price: number | null;
  aestheticTags: string[];
  // Display-only match percentage (see match-scoring.ts), when one could
  // be computed for the order's user — omit/null if not available rather
  // than guessing.
  matchPercent?: number | null;
}

export interface UrgencyScore {
  score: number;
  label: string;
}

const TREND_TAGS = ["y2k", "vintage", "archive", "rare", "designer"];

// "#Y2K" (hashtag-prefixed, as real aesthetic_tags are stored) and "Y2K"
// (plain, as onboarding/style_profiles store them) both need to match the
// same trend word — same normalization match-scoring.ts uses.
function normalizeTag(tag: string): string {
  return tag.trim().toLowerCase().replace(/^#/, "");
}

// Per matching trend tag, not a single flat bonus — a listing tagged both
// "y2k" and "designer" is more urgent than one with just one of those, and
// (deliberately) this is what makes the 80-100 "🔥 Hot" tier reachable at
// all: a flat +15 combined with every other factor's max only totals 70.
function countTrendTagMatches(aestheticTags: string[]): number {
  const normalized = new Set(aestheticTags.map(normalizeTag));
  return TREND_TAGS.filter((trend) => normalized.has(trend)).length;
}

// "Strong" aesthetic tags: a listing with a rich, specific tag set reads
// as more curated/distinctive — and therefore more likely to be a unique,
// low-availability find — than one with just one or two generic tags.
const STRONG_TAG_COUNT_THRESHOLD = 3;

export function calculateUrgencyScore(listing: UrgencyListing): UrgencyScore {
  const price = listing.price ?? 0;
  const aestheticTags = listing.aestheticTags ?? [];

  let score = 0;

  // Price — mutually exclusive tiers (cheaper is more urgent), not
  // additive: a $10 item doesn't also collect the "< $50" bonus on top of
  // the "< $25" one.
  if (price > 0 && price < 25) {
    score += 20;
  } else if (price < 50) {
    score += 10;
  }

  score += countTrendTagMatches(aestheticTags) * 15;

  if (listing.matchPercent != null && listing.matchPercent > 80) {
    score += 20;
  }

  if (aestheticTags.length >= STRONG_TAG_COUNT_THRESHOLD) {
    score += 15;
  }

  const clamped = Math.max(0, Math.min(100, score));

  let label: string;
  if (clamped >= 80) {
    label = "🔥 Hot - Buy First";
  } else if (clamped >= 50) {
    label = "⚡ Medium";
  } else {
    label = "Stable";
  }

  return { score: clamped, label };
}
