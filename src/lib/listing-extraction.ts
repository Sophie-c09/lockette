// Orchestrator for the admin importer (/admin/import). Public contract
// (extractListingFromUrl / ExtractedListing) is unchanged — only the
// implementation is now split across src/lib/extraction/:
//
//   html-extractor.ts      fast path: fetch + parse OG/JSON-LD (no browser)
//   browser-extractor.ts   fallback: render with headless Chromium when the
//                           fast path comes back missing title/image/price
//   normalize-listing.ts   shared cleanup + the ExtractedListing type
//   clean-description.ts   strips seller-chatter from the description and
//                           pulls out brand/size/style-tag signal from it
//   generate-title.ts      builds the final "[Item Type] · [Brand]" title
//
// Flow: try html-extractor first; if title, image_url, or price is still
// missing, fall back to browser-extractor and fill in whatever it found;
// normalize, clean the description, then generate the final title — this is
// the "Clean description -> Generate clean title" stretch of the pipeline,
// which runs before classifyListing (see route.ts for where that runs
// next). Never throws past this point except for a genuinely invalid input
// URL — every downstream failure (fetch, browser launch, parsing) degrades
// to nulls/placeholders instead.
import {
  runHtmlExtraction,
  type RawExtraction,
} from "@/lib/extraction/html-extractor";
import { runBrowserExtraction } from "@/lib/extraction/browser-extractor";
import {
  detectPlatform,
  normalizeListing,
  type ExtractedListing,
} from "@/lib/extraction/normalize-listing";
import { cleanListingDescription } from "@/lib/extraction/clean-description";
import { generateCleanTitle } from "@/lib/extraction/generate-title";
import { inferAestheticTags } from "@/lib/extraction/infer-aesthetic-tags";
import { enrichWithRelatedStyles } from "@/lib/style-relationships";

export type { ExtractedListing };

function debugLog(message: string): void {
  console.warn(`[listing-extraction] ${message}`);
}

const EMPTY_RAW: RawExtraction = {
  title: null,
  description: null,
  price: null,
  imageUrl: null,
  images: [],
  canonicalUrl: null,
  brand: null,
  category: null,
  size: null,
  color: null,
  sourceLikesCount: null,
  sourceViewsCount: null,
  sourceCommentsCount: null,
};

// Below this many gallery images, it's worth paying for a full browser
// render even when title/price/image_url all already succeeded — verified
// live against a real Vinted listing: the cheap HTML fetch found title/
// price/image_url just fine (from a single og:image tag) and would have
// been judged "complete" under the old title/imageUrl/price-only check,
// silently saving only 1 of the listing's real 13 photos. Vinted doesn't
// publish a JSON-LD Product gallery at all (confirmed: 0 <script
// type="application/ld+json"> tags on a real listing page) — its full
// gallery only exists in the client-rendered DOM, which only
// browser-extractor.ts's page.evaluate() DOM scan can see. Depop, by
// contrast, DOES publish its whole gallery via JSON-LD (verified live: 3
// images from one <script type="application/ld+json"> tag) — so this
// check costs nothing extra for a platform whose fast path already got
// everything, and only pays for a browser render when there's real
// missing-photo risk.
const MIN_GALLERY_IMAGES_BEFORE_BROWSER_FALLBACK = 2;

// The fields requirement 2 calls out as "important" — if any is missing
// after the fast path, it's worth paying for a full browser render. Also
// triggers on a too-small gallery (see MIN_GALLERY_IMAGES_BEFORE_BROWSER_FALLBACK
// above) — "found A photo" and "found ALL the photos" are different
// outcomes that used to look identical to this check.
function isMissingImportantFields(raw: RawExtraction | null): boolean {
  if (!raw) return true;
  return !raw.title || !raw.imageUrl || !raw.price || raw.images.length < MIN_GALLERY_IMAGES_BEFORE_BROWSER_FALLBACK;
}

// Prefers `primary` (the fast path) field by field, filling gaps from
// `fallback` (the browser pass) — so a browser render that only recovers
// the price, say, doesn't discard a title the fast path already found.
function mergeRaw(
  primary: RawExtraction | null,
  fallback: RawExtraction | null,
): RawExtraction {
  const base = primary ?? EMPTY_RAW;
  if (!fallback) return base;

  return {
    title: base.title ?? fallback.title,
    description: base.description ?? fallback.description,
    price: base.price ?? fallback.price,
    imageUrl: base.imageUrl ?? fallback.imageUrl,
    // Unlike the other fields, images are gathered from both sources rather
    // than one replacing the other — the fast path might find JSON-LD
    // images the browser's DOM scan misses (or vice versa). Deduplication
    // happens later in normalizeListing/normalizeImages.
    images: [...base.images, ...fallback.images],
    canonicalUrl: base.canonicalUrl ?? fallback.canonicalUrl,
    brand: base.brand ?? fallback.brand,
    category: base.category ?? fallback.category,
    size: base.size ?? fallback.size,
    color: base.color ?? fallback.color,
    sourceLikesCount: base.sourceLikesCount ?? fallback.sourceLikesCount,
    sourceViewsCount: base.sourceViewsCount ?? fallback.sourceViewsCount,
    sourceCommentsCount: base.sourceCommentsCount ?? fallback.sourceCommentsCount,
  };
}

/**
 * Extracts structured listing data from a thrift-platform product URL.
 *
 * See the file header for the two-stage pipeline. Limitations: this reads
 * published metadata and generic visible-DOM heuristics, not a
 * per-platform scraper — `size` and `aesthetic_tags` in particular are
 * rarely present anywhere and will commonly come back null/empty.
 */
export async function extractListingFromUrl(
  url: string,
): Promise<ExtractedListing> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("That doesn't look like a valid URL.");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("The URL must start with http:// or https://.");
  }

  const pageUrl = parsed.toString();
  const platform = detectPlatform(parsed.hostname);
  debugLog(`Processing URL: ${pageUrl} — platform detected: ${platform ?? "unknown"}`);

  const htmlResult = await runHtmlExtraction(pageUrl);
  const htmlIncomplete = isMissingImportantFields(htmlResult);
  debugLog(`HTML extraction: ${htmlResult ? (htmlIncomplete ? "incomplete" : "complete") : "failed"}`);

  let finalRaw = htmlResult;

  if (htmlIncomplete) {
    debugLog("Browser extraction: attempted");

    let browserResult: RawExtraction | null = null;
    try {
      browserResult = await runBrowserExtraction(pageUrl);
    } catch (error) {
      // runBrowserExtraction already catches internally and returns null on
      // failure — this is a second safety net in case Playwright itself
      // (e.g. launch()) throws before that try/catch is reached.
      const reason = error instanceof Error ? error.message : String(error);
      debugLog(`Browser extraction threw unexpectedly: ${reason}`);
    }

    debugLog(`Browser extraction: ${browserResult ? "success" : "failure"}`);
    finalRaw = mergeRaw(htmlResult, browserResult);
  }

  const normalized = normalizeListing(finalRaw ?? EMPTY_RAW, { pageUrl: parsed, platform });

  const cleaned = cleanListingDescription(normalized.description);
  const brand = normalized.brand ?? cleaned.brand;

  // Hashtag-derived tags aren't always available (many real listings use
  // none, or all of theirs get excluded as brand/promo/location noise) —
  // aesthetic_tags must never be empty, since match-scoring.ts/feed-scoring.ts
  // can only ever score a listing above 0 on style/likes if it has at
  // least one tag.
  const rawTags =
    cleaned.aestheticTags.length > 0
      ? cleaned.aestheticTags
      : inferAestheticTags({
          title: normalized.title,
          description: cleaned.description,
          category: normalized.category,
          brand,
        });

  // Broaden with inferred related styles (e.g. a literal "Y2K" tag also
  // implies Vintage/Coquette-adjacent) so a listing isn't only discoverable
  // via its exact literal tags.
  const aestheticTags = enrichWithRelatedStyles(rawTags);

  const withCleanedDescription: ExtractedListing = {
    ...normalized,
    description: cleaned.description,
    brand,
    size: normalized.size ?? cleaned.size,
    aesthetic_tags: aestheticTags,
  };

  const listing: ExtractedListing = {
    ...withCleanedDescription,
    title: generateCleanTitle(withCleanedDescription),
  };

  const missing = (Object.entries(listing) as [string, unknown][])
    .filter(([key, value]) => key !== "aesthetic_tags" && (value === null || value === ""))
    .map(([key]) => key);
  debugLog(`Missing fields: [${missing.join(", ")}]`);

  debugLog(
    `Data extracted — title: ${listing.title.length > 0 ? "yes" : "no"}, ` +
      `price: ${listing.price != null ? `$${listing.price}` : "none"}, ` +
      `images: ${listing.images.length}`,
  );

  return listing;
}
