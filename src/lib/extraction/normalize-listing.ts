// Normalization: turns the raw, unstructured strings the extractors find
// (html-extractor.ts, browser-extractor.ts) into the clean, typed shape the
// `listings` table expects. No fetching or parsing of HTML happens here —
// just cleanup of values that already exist.
import type { RawExtraction } from "./html-extractor";
import { normalizeImages } from "./normalize-images";
import type { AvailabilitySignal } from "./availability-signal";

// Field shape matches the `listings` table exactly (minus id/created_at,
// which the database generates), so a caller can pass the result straight
// into saveListing() without remapping anything.
export interface ExtractedListing {
  title: string;
  description: string | null;
  price: number | null;
  // First image in `images` (kept alongside it for backward compatibility —
  // existing code that only ever read a single image_url still works).
  image_url: string | null;
  // Full, deduplicated gallery, in priority order.
  images: string[];
  product_url: string;
  platform: string | null;
  brand: string | null;
  category: string | null;
  size: string | null;
  color: string | null;
  aesthetic_tags: string[];
  // Engagement on the ORIGINAL marketplace listing (see hot-score.ts) —
  // null when the source page didn't publish it, which is the common case.
  source_likes_count: number | null;
  source_views_count: number | null;
  source_comments_count: number | null;
  // Human-readable reason the source page appears sold/removed/unavailable
  // (see availability-signal.ts), or null when the page gave no such
  // signal. Consulted by listing-flagging.ts so an already-dead listing
  // never gets auto-published — this is a real signal read off THIS
  // extraction, not the later check-listing-status cron's job.
  removal_signal: string | null;
}

function describeUnavailabilitySignal(signal: AvailabilitySignal): string | null {
  if (signal.kind !== "unavailable") return null;
  return signal.source === "json-ld"
    ? `source page's own product data marked it "${signal.detail}"`
    : `source page says "${signal.detail}"`;
}

const PLATFORM_BY_HOSTNAME: Record<string, string> = {
  "depop.com": "Depop",
  "www.depop.com": "Depop",
  "vinted.com": "Vinted",
  "www.vinted.com": "Vinted",
  "poshmark.com": "Poshmark",
  "www.poshmark.com": "Poshmark",
  "etsy.com": "Etsy",
  "www.etsy.com": "Etsy",
  "grailed.com": "Grailed",
  "www.grailed.com": "Grailed",
  "thredup.com": "ThredUp",
  "www.thredup.com": "ThredUp",
  "ebay.com": "eBay",
  "www.ebay.com": "eBay",
  "mercari.com": "Mercari",
  "www.mercari.com": "Mercari",
};

export function detectPlatform(hostname: string): string | null {
  return PLATFORM_BY_HOSTNAME[hostname.toLowerCase()] ?? null;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

export function decodeHtmlEntities(input: string): string {
  return input.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (match, entity: string) => {
    if (entity.startsWith("#x") || entity.startsWith("#X")) {
      const code = parseInt(entity.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    if (entity.startsWith("#")) {
      const code = parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[entity] ?? match;
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function cleanText(raw: string | null): string | null {
  if (!raw) return null;
  const cleaned = decodeHtmlEntities(raw).replace(/\s+/g, " ").trim();
  return cleaned || null;
}

// Strips embedded HTML (some platforms put simple markup like <br> in
// description content) on top of the generic text cleanup.
export function cleanDescription(raw: string | null): string | null {
  if (!raw) return null;
  return cleanText(raw.replace(/<[^>]*>/g, " "));
}

// Many sites append their own name to the page title
// ("Vintage Levi's Jacket | Depop") — strip a trailing platform suffix so
// the stored title is just the product name.
export function cleanTitle(raw: string | null, platform: string | null): string | null {
  const cleaned = cleanText(raw);
  if (!cleaned) return null;
  if (!platform) return cleaned;

  const suffixPattern = new RegExp(`\\s*[|\\-–—]\\s*${escapeRegExp(platform)}\\s*$`, "i");
  const withoutSuffix = cleaned.replace(suffixPattern, "").trim();
  return withoutSuffix || cleaned;
}

// "$35 USD" / "US $45.99" / "35,00 €" -> 35 / 45.99 / 35.
export function parsePrice(raw: string | null): number | null {
  if (!raw) return null;
  const match = raw.replace(/,/g, "").match(/\d+(\.\d+)?/);
  if (!match) return null;
  const value = parseFloat(match[0]);
  return Number.isFinite(value) ? value : null;
}

export function resolveUrl(raw: string | null, base: URL): string | null {
  if (!raw) return null;
  try {
    return new URL(raw, base).toString();
  } catch {
    return null;
  }
}

export interface NormalizeContext {
  pageUrl: URL;
  platform: string | null;
}

export function normalizeListing(
  raw: RawExtraction,
  { pageUrl, platform }: NormalizeContext,
): ExtractedListing {
  const fallbackTitle = platform
    ? `${platform} listing (untitled)`
    : "Imported listing (untitled)";

  const normalizedImages = normalizeImages(raw.images, pageUrl);
  // Defensive fallback: if the multi-image collection came up empty but the
  // older single-image field found something (e.g. a platform where the DOM
  // heuristic found an image the gallery scan didn't), don't lose it.
  const singleImageFallback = resolveUrl(raw.imageUrl, pageUrl);
  const images =
    normalizedImages.length > 0
      ? normalizedImages
      : singleImageFallback
        ? [singleImageFallback]
        : [];

  return {
    title: cleanTitle(raw.title, platform) ?? fallbackTitle,
    description: cleanDescription(raw.description),
    price: parsePrice(raw.price),
    image_url: images[0] ?? null,
    images,
    product_url: resolveUrl(raw.canonicalUrl, pageUrl) ?? pageUrl.toString(),
    platform,
    brand: cleanText(raw.brand),
    category: cleanText(raw.category),
    size: cleanText(raw.size),
    color: cleanText(raw.color),
    aesthetic_tags: [],
    source_likes_count: raw.sourceLikesCount,
    source_views_count: raw.sourceViewsCount,
    source_comments_count: raw.sourceCommentsCount,
    removal_signal: describeUnavailabilitySignal(raw.unavailabilitySignal),
  };
}
