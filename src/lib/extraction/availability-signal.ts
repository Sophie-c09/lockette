// Sold/removed-signal detection over a fetched or rendered HTML page —
// shared by two callers that must never see different results for the same
// HTML: html-extractor.ts/browser-extractor.ts (via extractFromHtml, run at
// IMPORT time, so an already-dead listing can be flagged before it's ever
// inserted) and listing-availability-check.ts (the check-listing-status
// cron, run on a schedule AFTER import to catch a listing that sold later).
// Extracted into its own dependency-free module rather than defined in
// either of those so html-extractor.ts (which listing-availability-check.ts
// already imports fetchHtml from) can also depend on it without a cycle.
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

// Deliberately conservative, multi-word phrases only — never a bare "sold"
// substring match, which would false-positive on ordinary seller stats ("50
// sold") or shop attribution ("Sold by Jane's Closet") that appear on
// plenty of still-active listings.
const UNAVAILABLE_PHRASES = [
  "no longer available",
  "item unavailable",
  "this item has sold",
  "this listing has sold",
  "this item is no longer available",
  "listing has been removed",
  "this listing has been deleted",
  "item has expired",
];

function normalizeAvailability(value: string): string {
  // schema.org values are usually a full URL (https://schema.org/OutOfStock)
  // but plenty of real-world pages just publish the bare token — matching
  // against whichever trailing word is present handles both.
  const trailing = value.split("/").pop() ?? value;
  return trailing.trim().toLowerCase();
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

// parseJsonLdProduct (html-extractor.ts) doesn't surface `offers.availability`
// today — it's only used for hot-score engagement counts and price/name/
// image fields — so this re-parses the same JSON-LD Product node
// specifically for that field, rather than changing that shared function's
// return shape for every other caller over one new field only this module
// needs.
type JsonLdAvailability = { found: true; unavailable: boolean; value: string } | { found: false };

function parseJsonLdProductAvailability(html: string): JsonLdAvailability {
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
      return { found: true, unavailable: UNAVAILABLE_JSON_LD_VALUES.includes(normalized), value: normalized };
    }
  }

  return { found: false };
}

/**
 * Inspects one fetched/rendered HTML page for a sold/removed signal. Never
 * throws. Returns `{ kind: "inconclusive" }` — never a guess — when neither
 * the JSON-LD availability field nor a conservative phrase match fires.
 *
 * A recognized, still-available JSON-LD value (InStock, etc.) is a
 * confident "no" that short-circuits straight to inconclusive WITHOUT
 * falling through to the phrase scan below — a real bug this fixed:
 * ordinary seller text mentioning "this item has sold before" (common,
 * harmless copy) would otherwise still trip the phrase match and mark a
 * confirmed-in-stock listing unavailable.
 */
export function detectUnavailabilitySignal(html: string): AvailabilitySignal {
  const jsonLd = parseJsonLdProductAvailability(html);
  if (jsonLd.found) {
    return jsonLd.unavailable
      ? { kind: "unavailable", source: "json-ld", detail: jsonLd.value }
      : { kind: "inconclusive" };
  }

  const lowerHtml = html.toLowerCase();
  const matchedPhrase = UNAVAILABLE_PHRASES.find((phrase) => lowerHtml.includes(phrase));
  if (matchedPhrase) {
    return { kind: "unavailable", source: "phrase", detail: matchedPhrase };
  }

  return { kind: "inconclusive" };
}
