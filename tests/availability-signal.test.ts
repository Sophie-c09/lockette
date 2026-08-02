// Covers availability-signal.ts's detectUnavailabilitySignal() — shared by
// the check-listing-status cron (post-import re-checks) AND the extraction
// pipeline (html-extractor.ts/browser-extractor.ts, which now runs this at
// IMPORT time so an already-dead listing can be flagged before insert; see
// listing-flagging.test.ts for the flagging side of that).
import { test } from "node:test";
import assert from "node:assert/strict";
import { detectUnavailabilitySignal } from "@/lib/extraction/availability-signal";

test("a page with no sold/removed signal is inconclusive, never a false positive", () => {
  const html = "<html><body><h1>Vintage Jacket</h1><p>50 sold this week</p></body></html>";
  const result = detectUnavailabilitySignal(html);
  assert.equal(result.kind, "inconclusive");
});

test("ordinary seller stats ('50 sold') never false-positive as a bare 'sold' match", () => {
  const html = "<p>Sold by Jane's Closet — 200 sold, 4.9 stars</p>";
  const result = detectUnavailabilitySignal(html);
  assert.equal(result.kind, "inconclusive");
});

test("a conservative multi-word phrase match is detected", () => {
  const html = "<div class='banner'>This item has sold</div>";
  const result = detectUnavailabilitySignal(html);
  assert.equal(result.kind, "unavailable");
  if (result.kind === "unavailable") {
    assert.equal(result.source, "phrase");
    assert.equal(result.detail, "this item has sold");
  }
});

test("JSON-LD Product availability OutOfStock is detected and takes priority over phrases", () => {
  const html = `
    <script type="application/ld+json">
      {"@type": "Product", "name": "Item", "offers": {"@type": "Offer", "availability": "https://schema.org/OutOfStock"}}
    </script>
    <p>50 sold this week</p>
  `;
  const result = detectUnavailabilitySignal(html);
  assert.equal(result.kind, "unavailable");
  if (result.kind === "unavailable") {
    assert.equal(result.source, "json-ld");
    assert.equal(result.detail, "outofstock");
  }
});

test("JSON-LD Product availability InStock is a confident 'available', not a phrase-scan fallback", () => {
  const html = `
    <script type="application/ld+json">
      {"@type": "Product", "name": "Item", "offers": {"@type": "Offer", "availability": "https://schema.org/InStock"}}
    </script>
    <p>this item has sold before, but is back now</p>
  `;
  const result = detectUnavailabilitySignal(html);
  assert.equal(result.kind, "inconclusive");
});

test("malformed JSON-LD never throws — falls through to phrase scan", () => {
  const html = `
    <script type="application/ld+json">{not valid json</script>
    <p>item unavailable</p>
  `;
  assert.doesNotThrow(() => detectUnavailabilitySignal(html));
  const result = detectUnavailabilitySignal(html);
  assert.equal(result.kind, "unavailable");
});
