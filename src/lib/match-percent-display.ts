// P0 first-60-seconds fix (item 6) — normalizes a raw 0-100 match score
// into what's actually shown to a USER as a match percentage. Deliberately
// NOT applied inside scoreListingMatch/scoreGarmentStyleMatch themselves
// (match-scoring.ts, discover-personalization.ts) — those raw scores are
// also consumed by admin-only tooling with their own absolute thresholds
// (src/lib/urgency-scoring.ts's `> 80`, PurchaseQueueView.tsx's
// HOT_MATCH_BONUS_THRESHOLD, src/lib/order-match-percent.ts) that must
// keep reading the real, uncompressed 0-100 scale. This is applied only
// at the two USER-FACING call sites that actually render a percentage
// (attachMatchPercent for /match, discover-feed.ts's own matchPercent for
// /discover) — a presentation-layer transform, not a scoring change.
//
// "The percentage is a UX signal, not a mathematical probability" (this
// feature's own spec): a plain floor (clamp everything below 25 up to
// exactly 25) would make every weak match read as an identical, robotic
// "25%". A linear rescale of the full 0-100 raw range into a 25-99
// displayed range instead keeps relative differences between listings
// visible (a monotonic transform — sort order by raw score is completely
// unaffected) while guaranteeing the three hard requirements: never below
// 25, never a bare single digit, and a raw score near 100 still reads in
// the "90s" (capped at 99, never a boastful literal 100%).
const MIN_DISPLAYED_PERCENT = 25;
const MAX_DISPLAYED_PERCENT = 99;

export function normalizeMatchPercentForDisplay(rawScore: number): number {
  const clampedRaw = Math.max(0, Math.min(100, rawScore));
  const normalized =
    MIN_DISPLAYED_PERCENT + (clampedRaw / 100) * (MAX_DISPLAYED_PERCENT - MIN_DISPLAYED_PERCENT);
  return Math.round(normalized);
}
