// Lightweight extraction: fetch a page's raw HTML and read whatever Open
// Graph tags / JSON-LD Product schema / commerce meta tags it publishes.
// No browser, no JS execution — this is the fast first attempt, and its
// HTML-string parsing (extractFromHtml) is reused by browser-extractor.ts
// against a fully-rendered page when this alone isn't enough.
//
// Parsing uses cheerio (a real HTML parser) rather than hand-rolled regex —
// more resilient to the malformed/irregular markup real marketplace pages
// serve (attributes in unexpected order, unquoted values, nested quotes)
// than a `<meta\b[^>]*>`-style pattern can reliably handle.
import * as cheerio from "cheerio";
import { detectUnavailabilitySignal, type AvailabilitySignal } from "./availability-signal";

// Raw, pre-normalization signal from either extractor — normalize-listing.ts
// turns this into the final ExtractedListing shape. Values may still be
// relative URLs, currency-prefixed price strings, HTML-escaped text, etc.
export interface RawExtraction {
  title: string | null;
  description: string | null;
  price: string | null;
  imageUrl: string | null;
  // All candidate gallery images found, in priority order (JSON-LD, then
  // Open Graph) — not yet deduplicated/resolved (normalize-images.ts does
  // that once the caller's page URL is known). imageUrl above is kept
  // as-is for backward compatibility; normalizeListing derives the final
  // image_url from images[0] once normalized, falling back to imageUrl.
  images: string[];
  canonicalUrl: string | null;
  brand: string | null;
  category: string | null;
  size: string | null;
  color: string | null;
  // Engagement on the ORIGINAL marketplace listing (see hot-score.ts) —
  // only ever populated when the source page's JSON-LD publishes a
  // schema.org `interactionStatistic` block (see parseInteractionCount
  // below). No marketplace is known to reliably do this — Depop/Vinted's
  // like/view counts live in client-side app state, not SEO metadata — so
  // these will realistically come back null for almost every real import.
  // That's the expected, correct outcome, not a bug: null here means
  // "not published," and the import route/normalizeListing pass that
  // through unchanged rather than inventing a 0.
  sourceLikesCount: number | null;
  sourceViewsCount: number | null;
  sourceCommentsCount: number | null;
  // Sold/removed signal read off THIS extraction's own HTML — computed here
  // (not as a separate pass) so both html-extractor.ts's fast path and
  // browser-extractor.ts's rendered-page fallback get it for free via their
  // shared extractFromHtml() call below, and so an already-dead listing can
  // be flagged at IMPORT time (see listing-flagging.ts), not just caught
  // later by the check-listing-status cron.
  unavailabilitySignal: AvailabilitySignal;
}

function debugLog(message: string): void {
  console.warn(`[listing-extraction] ${message}`);
}

// Extraction-pipeline tracing (Depop/Vinted/Poshmark 0%-success
// investigation) — content-based detection to catch the case a bare
// status code can't: a platform returning 200 OK with a CAPTCHA/login/
// "verify you're human" interstitial instead of the real page. Cheap
// substring/regex sniff, not exhaustive — good enough to flag the
// pattern in logs, not a load-bearing block/allow decision.
export function detectBlockedPageContent(html: string): { looksLikeCaptcha: boolean; looksLikeLogin: boolean } {
  return {
    looksLikeCaptcha: /captcha|cloudflare|checking your browser|just a moment|access denied|are you human/i.test(html),
    looksLikeLogin: /log ?in to (continue|view)|sign ?in to (continue|view)|please log ?in|session expired/i.test(html),
  };
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

const FETCH_TIMEOUT_MS = 15_000;

// HTTP statuses that mean "the site is actively blocking/rate-limiting
// this request," not "the page genuinely doesn't exist" — logged clearly
// and treated as a normal, expected outcome (never a hang, never a thrown
// error the caller has to guess the cause of). Same list as
// browser-extractor.ts's own BLOCKED_STATUS_CODES.
const BLOCKED_STATUS_CODES = new Set([403, 429, 503]);

// Several thrift platforms serve a stripped-down page (or trigger bot
// detection) for non-browser clients, so this asks for HTML as a normal
// browser would rather than with a default Node/undici user agent.
const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

const BROWSER_HEADERS: HeadersInit = {
  "User-Agent": BROWSER_USER_AGENT,
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
};

// Never throws — a failed fetch (network error, timeout, blocked request,
// redirect to a login/CAPTCHA wall, etc.) is a normal, expected outcome,
// not a bug. Callers fall back to browser extraction (or a placeholder
// listing) when this returns null.
export async function fetchHtml(url: string): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: BROWSER_HEADERS,
    });

    // Extraction-pipeline tracing — read the body regardless of status so
    // a blocked/CAPTCHA response's actual content is visible in logs, not
    // just its status code. `response.url` is the URL AFTER any redirects
    // fetch() followed (`redirect: "follow"` above) — often the clearest
    // single signal that something's wrong (e.g. redirected to a /login
    // or /captcha path the caller never requested).
    const bodyText = await response.text();
    const { looksLikeCaptcha, looksLikeLogin } = detectBlockedPageContent(bodyText);
    console.log("[extraction] fetch result", {
      requestedUrl: url,
      finalUrl: response.url,
      redirected: response.redirected,
      status: response.status,
      contentType: response.headers.get("content-type") ?? null,
      htmlLength: bodyText.length,
      looksLikeCaptcha,
      looksLikeLogin,
      htmlSnippet: bodyText.slice(0, 500),
    });

    if (!response.ok) {
      if (BLOCKED_STATUS_CODES.has(response.status)) {
        const hostname = (() => {
          try {
            return new URL(url).hostname;
          } catch {
            return url;
          }
        })();
        debugLog(`${hostname} blocked request (status ${response.status}): skipping`);
      } else {
        debugLog(`Fetch failed with status ${response.status} for ${url}`);
      }
      return null;
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().includes("html")) {
      debugLog(`Unexpected content-type "${contentType}" for ${url}`);
      return null;
    }

    if (looksLikeCaptcha || looksLikeLogin) {
      debugLog(
        `${url} returned HTTP ${response.status} (not blocked by status code) but content looks like a ` +
          `${looksLikeCaptcha ? "CAPTCHA/bot-check" : "login"} page — extraction will likely find nothing real.`,
      );
    }

    return bodyText;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    debugLog(`Fetch threw for ${url}: ${reason}`);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// HTML parsing — via cheerio (see the file header). We only ever need two
// shapes out of the document: <meta> tags, and <script type="application/
// ld+json"> bodies. (browser-extractor.ts is where a real browser — for
// pages that only populate this client-side — earns its own separate cost.)
// ---------------------------------------------------------------------------

export function parseMetaTags(html: string): Record<string, string> {
  const $ = cheerio.load(html);
  const result: Record<string, string> = {};

  $("meta").each((_, element) => {
    const property = $(element).attr("property") ?? $(element).attr("name");
    const content = $(element).attr("content");
    if (property === undefined || content === undefined) return;

    const key = property.toLowerCase();
    if (!(key in result)) {
      // First occurrence wins — some pages repeat a tag with a stripped
      // fallback version further down the document.
      result[key] = content;
    }
  });

  return result;
}

// A page can legitimately repeat "og:image" once per gallery photo — unlike
// parseMetaTags (which only keeps the first value per key, for fields where
// that's correct), this keeps every occurrence, in document order.
function parseAllMetaValues(html: string, property: string): string[] {
  const $ = cheerio.load(html);
  const values: string[] = [];

  $("meta").each((_, element) => {
    const key = ($(element).attr("property") ?? $(element).attr("name"))?.toLowerCase();
    if (key !== property) return;

    const content = $(element).attr("content");
    if (content) values.push(content);
  });

  return values;
}

interface JsonLdProduct {
  name: string | null;
  description: string | null;
  image: string | null;
  // Every image URL schema.org's `image` field resolves to (it may be a
  // single string, an array of strings, an array of ImageObjects, or a mix)
  // — image above is just images[0], kept for backward compatibility.
  images: string[];
  price: string | null;
  brand: string | null;
  category: string | null;
  color: string | null;
  size: string | null;
  likesCount: number | null;
  viewsCount: number | null;
  commentsCount: number | null;
}

export function parseJsonLdProduct(html: string): JsonLdProduct | null {
  const $ = cheerio.load(html);
  const scripts = $('script[type="application/ld+json"]').toArray();

  for (const element of scripts) {
    // .html() on a raw-text element (script/style) returns its literal
    // source text, undecoded — exactly what JSON.parse needs, and matches
    // how a <script> body is actually treated per the HTML spec (entities
    // aren't processed inside it).
    const raw = $(element).html()?.trim();
    if (!raw) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue; // malformed JSON-LD is common in the wild — skip and keep looking
    }

    const product = findProductNode(parsed);
    if (product) return normalizeJsonLdProduct(product);
  }

  return null;
}

function findProductNode(node: unknown): Record<string, unknown> | null {
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findProductNode(item);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== "object" || node === null) return null;

  const record = node as Record<string, unknown>;
  const type = record["@type"];
  const isProduct =
    typeof type === "string"
      ? type.toLowerCase() === "product"
      : Array.isArray(type) &&
        type.some((t) => typeof t === "string" && t.toLowerCase() === "product");

  if (isProduct) return record;
  if ("@graph" in record) return findProductNode(record["@graph"]);

  return null;
}

// Schema.org fields are frequently a string, an array, or a nested object
// ({ name }, { url }, { value }) depending on the site — this walks down to
// whichever plain string is actually there.
function firstString(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;

  if (Array.isArray(value)) {
    for (const item of value) {
      const result = firstString(item);
      if (result) return result;
    }
    return null;
  }

  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return firstString(record.name ?? record.url ?? record.value ?? record["@value"]);
  }

  if (typeof value === "number") return String(value);

  return null;
}

// Like firstString, but collects every resolvable string rather than
// stopping at the first — used for schema.org `image`, which can be a
// single URL, an array of URLs, an array of ImageObjects, or a mix.
function allStrings(value: unknown): string[] {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) => allStrings(item));
  }

  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return allStrings(record.url ?? record.contentUrl ?? record.name ?? record.value ?? record["@value"]);
  }

  if (typeof value === "number") return [String(value)];

  return [];
}

function extractOfferPrice(offers: unknown): string | null {
  if (Array.isArray(offers)) {
    for (const offer of offers) {
      const result = extractOfferPrice(offer);
      if (result) return result;
    }
    return null;
  }

  if (typeof offers === "object" && offers !== null) {
    const record = offers as Record<string, unknown>;
    if (typeof record.price === "string" || typeof record.price === "number") {
      return String(record.price);
    }
    if (record.priceSpecification) return extractOfferPrice(record.priceSpecification);
    return null;
  }

  if (typeof offers === "string" || typeof offers === "number") return String(offers);

  return null;
}

// Size isn't a standalone schema.org Product field — sites that publish it
// tend to nest it in `additionalProperty: [{ name: "Size", value: "M" }]`.
function extractAdditionalProperty(
  record: Record<string, unknown>,
  namePattern: RegExp,
): string | null {
  const props = record.additionalProperty;
  if (!Array.isArray(props)) return null;

  for (const prop of props) {
    if (typeof prop !== "object" || prop === null) continue;
    const entry = prop as Record<string, unknown>;
    if (typeof entry.name === "string" && namePattern.test(entry.name)) {
      return firstString(entry.value);
    }
  }

  return null;
}

// Engagement counts aren't a standalone schema.org Product field either —
// sites that publish them use the generic `interactionStatistic` field
// (an array of InteractionCounter objects, each naming an interactionType
// like "LikeAction"/"CommentAction" and a userInteractionCount). No
// standard schema.org action exists specifically for "view count" — sites
// that publish one tend to reuse WatchAction or an informal ViewAction, so
// both are matched here. Real-world coverage is expected to be sparse
// (most marketplaces don't expose this in SEO metadata at all), which is
// fine: absence is a null, not a 0 — see the RawExtraction comment.
function parseInteractionCount(record: Record<string, unknown>, actionNames: string[]): number | null {
  const stats = record.interactionStatistic;
  const list = Array.isArray(stats) ? stats : stats ? [stats] : [];

  for (const stat of list) {
    if (typeof stat !== "object" || stat === null) continue;
    const entry = stat as Record<string, unknown>;

    const type = entry.interactionType;
    const typeName =
      typeof type === "string"
        ? (type.split("/").pop() ?? type)
        : typeof type === "object" && type !== null
          ? String((type as Record<string, unknown>)["@type"] ?? "")
          : "";
    if (!actionNames.some((name) => typeName.toLowerCase() === name.toLowerCase())) continue;

    const count = entry.userInteractionCount;
    const numeric = typeof count === "number" ? count : typeof count === "string" ? Number(count) : NaN;
    if (Number.isFinite(numeric)) return numeric;
  }

  return null;
}

function normalizeJsonLdProduct(record: Record<string, unknown>): JsonLdProduct {
  const images = allStrings(record.image);
  return {
    name: firstString(record.name),
    description: firstString(record.description),
    image: images[0] ?? null,
    images,
    price: extractOfferPrice(record.offers),
    brand: firstString(record.brand),
    category: firstString(record.category),
    color: firstString(record.color),
    size: extractAdditionalProperty(record, /size/i),
    likesCount: parseInteractionCount(record, ["LikeAction"]),
    viewsCount: parseInteractionCount(record, ["WatchAction", "ViewAction"]),
    commentsCount: parseInteractionCount(record, ["CommentAction"]),
  };
}

// ---------------------------------------------------------------------------
// Combined extraction
// ---------------------------------------------------------------------------

// Parses an HTML string (from either a raw fetch or a rendered browser
// page) into RawExtraction. Pure — does no fetching and no URL resolution
// (relative image/canonical URLs are resolved later, in normalize-listing,
// once the caller's page URL is known).
export function extractFromHtml(html: string): RawExtraction {
  const meta = parseMetaTags(html);
  const jsonLd = parseJsonLdProduct(html);

  // Priority order: JSON-LD Product images first, then every og:image tag
  // the page publishes (a gallery is often expressed as repeated og:image
  // tags, one per photo) — normalize-images.ts dedupes/resolves/filters
  // this combined list later, once the page URL is known.
  const images = [...(jsonLd?.images ?? []), ...parseAllMetaValues(html, "og:image")];

  return {
    title: jsonLd?.name ?? meta["og:title"] ?? meta["twitter:title"] ?? null,
    description: jsonLd?.description ?? meta["og:description"] ?? meta["description"] ?? null,
    price: jsonLd?.price ?? meta["product:price:amount"] ?? meta["og:price:amount"] ?? null,
    imageUrl: jsonLd?.image ?? meta["og:image:secure_url"] ?? meta["og:image"] ?? null,
    images,
    canonicalUrl: meta["og:url"] ?? null,
    brand: jsonLd?.brand ?? null,
    category: jsonLd?.category ?? meta["product:category"] ?? null,
    size: jsonLd?.size ?? null,
    color: jsonLd?.color ?? meta["product:color"] ?? null,
    sourceLikesCount: jsonLd?.likesCount ?? null,
    sourceViewsCount: jsonLd?.viewsCount ?? null,
    sourceCommentsCount: jsonLd?.commentsCount ?? null,
    unavailabilitySignal: detectUnavailabilitySignal(html),
  };
}

// Fetch + parse in one call — the "first attempt" of the pipeline.
// Never throws; returns null if the page couldn't be fetched at all.
export async function runHtmlExtraction(url: string): Promise<RawExtraction | null> {
  const html = await fetchHtml(url);
  if (!html) return null;
  return extractFromHtml(html);
}
