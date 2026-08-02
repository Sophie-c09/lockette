// Lightweight, synchronous safety net for the "listings go live
// automatically" ingestion change — sits ALONGSIDE the existing scoring/
// quality stack (admin-scraper-filter.ts's passesMinimalQualityFilters,
// listing-quality.ts's AI quality score, listing-quality-gate.ts's
// post-insert recheck, inventory-quality-score.ts's composite score), not
// inside or instead of any of them. Those all still run exactly as before;
// this is the one new check that decides 'active' vs 'flagged' at insert
// time.
//
// Deliberately narrow, per explicit product direction: this only catches
// HARD failures (missing/junk title, no images, broken image URLs,
// invalid/missing/non-positive price, banned keywords, non-clothing) — it
// must NEVER flag a listing for being cheap, having a terse-but-real
// title ("Vintage Tee", "Nike Shirt"), only one photo, an uncommon style,
// or being fast fashion. Low price in particular is explicitly GOOD for
// marketplace liquidity, not a defect. An earlier version of this file
// also flagged vague/short titles and price outside a $3-$5000 band —
// both deliberately removed; only EXACT placeholder-junk titles ("item",
// "test", "asdf", "n/a") or a genuinely empty title are flagged now, a
// narrower check than "vague," not a re-addition of it.
//
// Deliberately NOT an AI call: every check here is a cheap, deterministic
// heuristic over data the pipeline already has by insert time (images,
// price, category/title). "No expensive AI calls per listing" is the
// explicit constraint this was built under; if a genuinely AI-based safety
// check is wanted later, it belongs in listing-quality.ts's existing
// AI-scoring pass, not duplicated here.

export interface FlaggableListing {
  title: string;
  description?: string | null;
  images: string[];
  price: number | null;
  category?: string | null;
  // The following three are optional so existing/other callers that don't
  // have them yet still compile — but every real ingestion path (single
  // import, bulk import, admin scraper) now passes all three (see each
  // route's own flagListing() call site).
  productUrl?: string | null;
  platform?: string | null;
  // Set by the shared extraction pipeline (normalize-listing.ts) when the
  // source page itself signals the item is sold/removed/expired — see
  // availability-signal.ts. Distinct from the later check-listing-status
  // cron, which re-checks listings that looked fine AT import time.
  removalSignal?: string | null;
}

export interface FlagResult {
  isSafe: boolean;
  reasons?: string[];
}

// Exact list, per explicit spec — deliberately shorter/more specific than
// an earlier version of this file (which also caught "counterfeit", "aaa
// quality", generic "bulk lot", etc.). Matched case-insensitively as
// literal substrings.
const BANNED_KEYWORDS = ["replica", "fake", "wholesale bulk", "lot of 100", "mystery box"];

// Title-level signal for "this isn't clothing at all" — a blocklist
// (rather than a category allowlist) since real clothing titles use far
// more free-text variety than any fixed allowlist could cover without
// false-positiving constantly; a blocklist only needs to catch the
// unambiguous non-clothing categories that occasionally slip into a
// marketplace-wide search.
const NON_CLOTHING_KEYWORDS = [
  "iphone",
  "ipad",
  "macbook",
  "laptop",
  "gaming console",
  "playstation",
  "xbox",
  "nintendo switch",
  "furniture",
  "sofa",
  "mattress",
  "kitchenware",
  "cookware",
  "power tool",
  "car part",
  "auto part",
  "textbook",
  "video game",
];

// Recognizable placeholder/broken-image URL patterns — a real syntax/
// content check, not a network fetch (an HTTP HEAD request per image
// would violate "keep flagging lightweight" and "do not slow down the
// scraper").
const BROKEN_IMAGE_PATTERNS = [/^(no|null|undefined)$/i, /placeholder/i, /no[-_]?image/i, /404/, /broken/i];

// Exact-match junk titles only — deliberately NOT a "vague title" heuristic
// (short/generic/no-brand titles like "Vintage Tee", "Black Cardigan",
// "Y2K Top", "Nike Shirt" are completely normal marketplace listing titles
// and must never be flagged). This only catches a title that is
// literally placeholder/test data, not one that's merely terse.
const JUNK_TITLES = new Set(["item", "test", "asdf", "n/a", "na"]);

function isMissingOrJunkTitle(title: string): boolean {
  const trimmed = title.trim();
  if (!trimmed) return true;
  return JUNK_TITLES.has(trimmed.toLowerCase());
}

function containsBannedKeyword(text: string): string | null {
  const lower = text.toLowerCase();
  for (const keyword of BANNED_KEYWORDS) {
    if (lower.includes(keyword)) return keyword;
  }
  return null;
}

function hasBrokenImageUrl(images: string[]): boolean {
  return images.some((url) => {
    if (!url || !url.trim()) return true;
    if (!/^https?:\/\//i.test(url)) return true;
    return BROKEN_IMAGE_PATTERNS.some((pattern) => pattern.test(url));
  });
}

function isLikelyNonClothing(title: string, category: string | null | undefined): boolean {
  const haystack = `${title} ${category ?? ""}`.toLowerCase();
  return NON_CLOTHING_KEYWORDS.some((keyword) => haystack.includes(keyword));
}

function isValidMarketplaceUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * The insert-time safety net — everything here is additive to the
 * existing minimal quality gate and scoring pipeline, never a replacement
 * for either. Only catches clear, hard failures; anything not explicitly
 * listed here (price level, title terseness, single photo, style, brand)
 * must pass through untouched. Returns isSafe:true (no reasons) for the
 * overwhelming majority of real listings, including cheap ones —
 * isSafe:false with every matching reason (not just the first) when
 * something is concretely broken or unsafe.
 */
export function flagListing(listing: FlaggableListing): FlagResult {
  const reasons: string[] = [];
  const combinedText = `${listing.title} ${listing.description ?? ""}`;

  if (isMissingOrJunkTitle(listing.title)) {
    reasons.push("title is missing or placeholder junk");
  }

  if (!Array.isArray(listing.images) || listing.images.length === 0) {
    reasons.push("no images at all");
  } else if (hasBrokenImageUrl(listing.images)) {
    reasons.push("broken image URL");
  }

  if (listing.price == null) {
    reasons.push("price is missing");
  } else if (Number.isNaN(listing.price)) {
    reasons.push("price is not a valid number");
  } else if (listing.price === 0) {
    reasons.push("price is zero");
  } else if (listing.price < 0) {
    reasons.push("price is negative");
  }
  // No upper or lower bound beyond the above — a $1-$5 listing is
  // explicitly fine (good for marketplace liquidity), never flagged for
  // being cheap.

  const bannedMatch = containsBannedKeyword(combinedText);
  if (bannedMatch) {
    reasons.push(`banned keyword: "${bannedMatch}"`);
  }

  if (isLikelyNonClothing(listing.title, listing.category)) {
    reasons.push("likely non-clothing item");
  }

  // productUrl/platform/removalSignal are optional on FlaggableListing so
  // any not-yet-updated caller still compiles, but every real ingestion
  // path passes all three — `=== null` (not `== null`) deliberately only
  // fires when a caller actually checked and found nothing, not when a
  // caller simply didn't pass the field at all.
  if (listing.productUrl !== undefined && !isValidMarketplaceUrl(listing.productUrl)) {
    reasons.push("invalid or missing marketplace URL");
  }

  if (listing.platform === null) {
    reasons.push("unrecognized source platform");
  }

  if (listing.removalSignal) {
    reasons.push(`source listing appears sold/removed: ${listing.removalSignal}`);
  }

  if (reasons.length > 0) {
    return { isSafe: false, reasons };
  }
  return { isSafe: true };
}
