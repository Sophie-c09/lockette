// Turns a raw, unordered-priority list of candidate image URLs (gathered
// from JSON-LD, Open Graph, and rendered-DOM gallery scraping — see
// html-extractor.ts / browser-extractor.ts) into a clean, deduplicated
// gallery: resolves relative URLs, drops anything that isn't a usable
// http(s) image URL, and collapses same-image query-string variants
// (tracking params, resize params) down to a single entry. Pure — no I/O.

// Filenames/keywords that indicate a tracking pixel or non-product asset
// rather than an actual listing photo.
const TRACKING_KEYWORDS = ["pixel.gif", "spacer.gif", "1x1", "analytics", "beacon", "tracking-pixel"];

function isLikelyTrackingUrl(url: URL): boolean {
  const haystack = `${url.pathname}${url.search}`.toLowerCase();
  return TRACKING_KEYWORDS.some((keyword) => haystack.includes(keyword));
}

// Origin + pathname only — deliberately ignores the query string, so
// "image1.jpg" and "image1.jpg?tracking=123" (or "?w=800" vs "?w=1600" size
// variants) are treated as the same underlying photo. The first-seen
// variant wins, preserving input order.
function dedupeKey(url: URL): string {
  return `${url.origin}${url.pathname}`;
}

// Scraped listings capture the FULL source gallery, not the small cap
// manually-uploaded listings use (MAX_LISTING_IMAGES in listing-photo.ts,
// 4 — a deliberate UX limit for a human clicking through a file picker,
// unrelated to "how many photos did the marketplace listing actually
// have"). This is a generous safety ceiling instead — verified live that
// a real Vinted listing can have 13+ photos — bounding it here only
// protects against a pathological/malicious page (hundreds of <img>
// tags), not a normal real-world gallery. Applied last, after resolving/
// deduping/filtering, so the ones kept are always the first MAX_IMAGES
// valid, distinct, non-tracking images in priority order. Exported so
// src/lib/listingModeration.ts's updateListingImages can validate against
// the SAME ceiling when an admin trims an already-scraped gallery, rather
// than the much smaller manual-upload limit.
export const MAX_SCRAPED_LISTING_IMAGES = 20;
const MAX_IMAGES = MAX_SCRAPED_LISTING_IMAGES;

function debugLog(message: string): void {
  console.warn(`[listing-extraction] ${message}`);
}

export function normalizeImages(
  images: Array<string | null | undefined>,
  baseUrl: URL,
): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const raw of images) {
    if (!raw || !raw.trim()) continue;

    let resolved: URL;
    try {
      resolved = new URL(raw.trim(), baseUrl);
    } catch {
      continue; // not a resolvable URL at all — drop it
    }

    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") continue;
    if (isLikelyTrackingUrl(resolved)) continue;

    const key = dedupeKey(resolved);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(resolved.toString());
  }

  if (result.length > MAX_IMAGES) {
    debugLog(`Limited images from ${result.length} to ${MAX_IMAGES}`);
    return result.slice(0, MAX_IMAGES);
  }

  return result;
}
