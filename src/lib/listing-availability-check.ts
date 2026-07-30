// Sold-signal detection for the check-listing-status cron
// (src/app/api/cron/check-listing-status/route.ts). Deliberately
// fetch-only — no headless-browser fallback: this project has already hit
// real Cloudflare-style bot-challenge blocks fetching both eBay and Depop
// (see html-extractor.ts's BROWSER_HEADERS spoofing), so a blocked/
// inconclusive fetch is treated as "leave status alone, try again later"
// (the failsafe below), which is exactly what a fetch-only approach
// naturally produces — escalating to Playwright wouldn't reliably help
// against a real bot-challenge anyway, and running it on a timer inside a
// scheduled serverless function is meaningfully heavier infrastructure
// than this failure-handling rule actually calls for.
import { fetchHtml } from "@/lib/extraction/html-extractor";

export type AvailabilitySignal =
  | { kind: "unavailable"; source: "json-ld"; detail: string }
  | { kind: "unavailable"; source: "phrase"; detail: string }
  | { kind: "inconclusive" };

// schema.org Offer.availability values that mean "you can't buy this
// anymore" — https://schema.org/ItemAvailability. `Discontinued` is
// included even though it more literally means "no longer made" — on a
// secondhand one-of-one listing there's no meaningful difference from
// "sold," since either way this exact item can't be bought here again.
const UNAVAILABLE_JSON_LD_VALUES = ["outofstock", "discontinued", "soldout"];

// Deliberately conservative, multi-word phrases only — never a bare
// "sold" substring match, which would false-positive on ordinary seller
// stats ("50 sold") or shop attribution ("Sold by Jane's Closet") that
// appear on plenty of still-active listings.
const UNAVAILABLE_PHRASES = [
  "no longer available",
  "item unavailable",
  "this item has sold",
  "this listing has sold",
];

function normalizeAvailability(value: string): string {
  // schema.org values are usually a full URL (https://schema.org/OutOfStock)
  // but plenty of real-world pages just publish the bare token — matching
  // against whichever trailing word is present handles both.
  const trailing = value.split("/").pop() ?? value;
  return trailing.trim().toLowerCase();
}

/**
 * Inspects one fetched HTML page for a sold/removed signal. Never throws.
 * Returns `{ kind: "inconclusive" }` — never a guess — when neither the
 * JSON-LD availability field nor a conservative phrase match fires; the
 * caller (the cron route) treats that identically to a failed fetch: only
 * last_checked_at is stamped, status is left untouched.
 */
export function detectUnavailabilitySignal(html: string): AvailabilitySignal {
  const jsonLd = parseJsonLdProductAvailability(html);
  if (jsonLd) {
    return { kind: "unavailable", source: "json-ld", detail: jsonLd };
  }

  const lowerHtml = html.toLowerCase();
  const matchedPhrase = UNAVAILABLE_PHRASES.find((phrase) => lowerHtml.includes(phrase));
  if (matchedPhrase) {
    return { kind: "unavailable", source: "phrase", detail: matchedPhrase };
  }

  return { kind: "inconclusive" };
}

// parseJsonLdProduct (html-extractor.ts) doesn't surface `offers.availability`
// today — it's only used for hot-score engagement counts and price/name/
// image fields — so this re-parses the same JSON-LD Product node
// specifically for that field, rather than changing that shared function's
// return shape for every other caller over one new field only this module
// needs.
function parseJsonLdProductAvailability(html: string): string | null {
  const scriptPattern =
    /<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

  let match: RegExpExecArray | null;
  while ((match = scriptPattern.exec(html))) {
    const raw = match[1].trim();
    if (!raw) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }

    const availability = findOfferAvailability(parsed);
    if (availability) {
      const normalized = normalizeAvailability(availability);
      if (UNAVAILABLE_JSON_LD_VALUES.includes(normalized)) {
        return normalized;
      }
      // A recognized-but-still-available value (InStock, etc.) is a
      // confident "no" — stop looking, rather than let a later, malformed
      // <script> block on the same page produce a false positive.
      return null;
    }
  }

  return null;
}

function findOfferAvailability(node: unknown): string | null {
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findOfferAvailability(item);
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
      : Array.isArray(type) && type.some((t) => typeof t === "string" && t.toLowerCase() === "product");

  if (isProduct) {
    return extractAvailability(record.offers);
  }

  if ("@graph" in record) return findOfferAvailability(record["@graph"]);

  return null;
}

function extractAvailability(offers: unknown): string | null {
  if (Array.isArray(offers)) {
    for (const offer of offers) {
      const found = extractAvailability(offer);
      if (found) return found;
    }
    return null;
  }

  if (typeof offers === "object" && offers !== null) {
    const record = offers as Record<string, unknown>;
    if (typeof record.availability === "string") return record.availability;
    return null;
  }

  return null;
}

export type CheckResult =
  | { outcome: "unavailable"; signalSource: "json-ld" | "phrase"; detail: string }
  | { outcome: "inconclusive" };

/**
 * Fetches `url` and runs sold-signal detection against it — the single
 * entry point the cron route calls per listing. Never throws: a failed
 * fetch (blocked, timed out, non-HTML response, network error — see
 * fetchHtml's own doc comment) is reported the same way as a page that
 * fetched fine but had no recognizable signal — `{ outcome: "inconclusive" }`
 * — so the caller's failsafe (stamp last_checked_at, leave status alone,
 * retry later) is the same single code path either way, matching the
 * spec's own "if the request fails, don't guess — just retry later" rule.
 */
export async function checkListingAvailability(url: string): Promise<CheckResult> {
  const html = await fetchHtml(url);
  if (!html) return { outcome: "inconclusive" };

  const signal = detectUnavailabilitySignal(html);
  if (signal.kind === "unavailable") {
    return { outcome: "unavailable", signalSource: signal.source, detail: signal.detail };
  }

  return { outcome: "inconclusive" };
}
