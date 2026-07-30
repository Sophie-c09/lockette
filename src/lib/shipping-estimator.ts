// AI-Powered Outfit Creation — Part 7: shipping estimate. Because
// Lockette sources resale items rather than holding its own stock, a
// bundle's arrival is the sum of three real legs: the ORIGINAL seller
// shipping it to Lockette, Lockette's own processing/consolidation, and
// Lockette shipping the finished bundle to the buyer. These are heuristic
// day-ranges (this app has no live carrier-tracking/API integration —
// see src/lib/marketplaces/ for why none of the external marketplaces
// have a live integration either), presented as an ESTIMATE, same as the
// UI's own "Estimated arrival" framing — never claimed as real-time
// tracking data.
import type { MarketplaceSource } from "@/lib/marketplaces/types";

export interface DayRange {
  minDays: number;
  maxDays: number;
}

// Per-platform seller-shipping ranges — this feature's own worked
// examples (Depop 3-7, Vinted 4-8) plus reasonable, clearly-labeled
// estimates for the remaining sources. 'reworn' is Lockette's own
// already-in-house inventory, so it skips a real "seller shipping" leg
// entirely (processing only).
const SELLER_SHIPPING_DAYS: Record<MarketplaceSource, DayRange> = {
  depop: { minDays: 3, maxDays: 7 },
  vinted: { minDays: 4, maxDays: 8 },
  poshmark: { minDays: 3, maxDays: 6 },
  mercari: { minDays: 3, maxDays: 7 },
  ebay: { minDays: 3, maxDays: 7 },
  reworn: { minDays: 0, maxDays: 0 },
};

const BUYER_SHIPPING_DAYS: DayRange = { minDays: 3, maxDays: 5 };

export const DEFAULT_PROCESSING_DAYS = 2;
// Consolidating a larger bundle (more sellers to receive from before
// shipping out as one package) takes marginally longer — a small,
// capped scaling rather than a flat per-item multiplier, so a 6-item
// bundle isn't unrealistically slower than a 2-item one.
const EXTRA_PROCESSING_DAYS_PER_ITEM = 0.5;
const MAX_EXTRA_PROCESSING_DAYS = 3;

export interface ShippingEstimateInput {
  sellerPlatform: MarketplaceSource;
  numberOfItems: number;
  processingDays?: number;
}

/**
 * One item's own estimated day-range: seller shipping + Lockette
 * processing (scaled modestly by bundle size) + buyer shipping.
 */
export function estimateShipping(input: ShippingEstimateInput): DayRange {
  const seller = SELLER_SHIPPING_DAYS[input.sellerPlatform];
  const baseProcessing = input.processingDays ?? DEFAULT_PROCESSING_DAYS;
  const extraProcessing = Math.min(
    MAX_EXTRA_PROCESSING_DAYS,
    Math.max(0, input.numberOfItems - 1) * EXTRA_PROCESSING_DAYS_PER_ITEM,
  );
  const processing = baseProcessing + extraProcessing;

  return {
    minDays: seller.minDays + processing + BUYER_SHIPPING_DAYS.minDays,
    maxDays: seller.maxDays + processing + BUYER_SHIPPING_DAYS.maxDays,
  };
}

export interface BundleDeliveryEstimate {
  start: Date;
  end: Date;
  rangeLabel: string;
}

const MONTH_DAY_FORMAT: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };

function addDays(date: Date, days: number): Date {
  // UTC throughout (setUTCDate, not setDate) — this Date is only ever
  // used to derive a calendar date (both the stored DATE column, via
  // toISOString, and the displayed rangeLabel below), never a real
  // instant-in-time, so it must not drift a day depending on the
  // server/browser's local timezone relative to UTC.
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + Math.round(days));
  return result;
}

/**
 * Whole-bundle estimate: takes the SLOWEST item across every distinct
 * seller platform in the bundle (a bundle only finishes once every item
 * has arrived at Lockette for consolidation), from `now`. `now` is an
 * explicit argument rather than read internally — same "pure, explicit
 * time" convention as src/lib/disliked-styles.ts's own nowMs parameter —
 * so this stays deterministic/testable.
 */
export function estimateBundleDelivery(
  sellerPlatforms: MarketplaceSource[],
  numberOfItems: number,
  now: Date,
  processingDays?: number,
): BundleDeliveryEstimate {
  const platforms = sellerPlatforms.length > 0 ? sellerPlatforms : (["reworn"] as MarketplaceSource[]);

  const ranges = platforms.map((platform) => estimateShipping({ sellerPlatform: platform, numberOfItems, processingDays }));
  const minDays = Math.max(...ranges.map((range) => range.minDays));
  const maxDays = Math.max(...ranges.map((range) => range.maxDays));

  const start = addDays(now, minDays);
  const end = addDays(now, maxDays);

  // timeZone: "UTC" pinned explicitly — start/end are UTC-based calendar
  // dates (see addDays' own comment); formatting them in the server's
  // local timezone instead could roll the displayed label to a different
  // calendar day than what's actually stored (estimated_delivery_start/
  // end, via toISOString — see bundle-generation.ts).
  const utcFormat: Intl.DateTimeFormatOptions = { ...MONTH_DAY_FORMAT, timeZone: "UTC" };
  const startLabel = start.toLocaleDateString("en-US", utcFormat);
  const endLabel =
    start.getUTCMonth() === end.getUTCMonth() ? String(end.getUTCDate()) : end.toLocaleDateString("en-US", utcFormat);

  return { start, end, rangeLabel: `Arrives ${startLabel}-${endLabel}` };
}
