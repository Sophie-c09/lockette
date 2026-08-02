// Covers the pure, dependency-free pieces of the unified duplicate-
// detection strategy shared by all three ingestion paths (single import,
// bulk import, admin scraper) — see duplicate-detection.ts's own header
// comment for the full 4-tier cascade (URL -> marketplace ID -> image hash
// -> conservative title+brand+price+platform+category fallback).
// checkForDuplicate/computeImageHash themselves need a live Supabase table
// and network fetches respectively, so they're exercised only indirectly
// here (via these pure helpers) rather than mocked — this project's own
// convention is to avoid tests that depend on live external state.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractMarketplaceId,
  titleSimilarity,
  fallbackFingerprintKey,
} from "@/lib/inventory/duplicate-detection";
import { normalizeTitleForDedup } from "@/lib/admin-scraper";

test("extractMarketplaceId ignores tracking parameters", () => {
  const withTracking = extractMarketplaceId("https://www.depop.com/products/abc-123?utm_source=share&ref=xyz");
  assert.deepEqual(withTracking, { source: "depop", externalId: "abc-123" });
});

test("extractMarketplaceId ignores a trailing slash", () => {
  const result = extractMarketplaceId("https://www.depop.com/products/abc-123/");
  assert.deepEqual(result, { source: "depop", externalId: "abc-123" });
});

test("extractMarketplaceId matches the same item across mobile and desktop hostnames", () => {
  const desktop = extractMarketplaceId("https://www.vinted.com/items/456789");
  const mobile = extractMarketplaceId("https://m.vinted.com/items/456789");
  assert.deepEqual(desktop, mobile);
  assert.equal(desktop?.externalId, "456789");
});

test("extractMarketplaceId returns null for an unrecognized host rather than guessing", () => {
  const result = extractMarketplaceId("https://example.com/some-random-page");
  assert.equal(result, null);
});

test("extractMarketplaceId returns null for a null URL", () => {
  assert.equal(extractMarketplaceId(null), null);
});

test("extractMarketplaceId distinguishes different eBay item IDs", () => {
  const a = extractMarketplaceId("https://www.ebay.com/itm/123456789012");
  const b = extractMarketplaceId("https://www.ebay.com/itm/987654321098");
  assert.notEqual(a?.externalId, b?.externalId);
});

test("normalizeTitleForDedup collapses case/punctuation/whitespace differences", () => {
  assert.equal(normalizeTitleForDedup("Vintage  Levi's - Jacket!!"), normalizeTitleForDedup("vintage levis jacket"));
});

test("normalizeTitleForDedup does NOT collapse genuinely different titles", () => {
  assert.notEqual(normalizeTitleForDedup("Vintage Levi's Jacket"), normalizeTitleForDedup("Nike Air Max Sneakers"));
});

test("titleSimilarity is high for near-identical titles and low for unrelated ones", () => {
  const high = titleSimilarity("Vintage Levi 501 Jeans", "Levis Vintage 501 Denim Jeans");
  const low = titleSimilarity("Vintage Levi 501 Jeans", "Nike Air Max Sneakers");
  assert.ok(high > 0.4, `expected high similarity, got ${high}`);
  assert.ok(low < 0.2, `expected low similarity, got ${low}`);
});

test("fallbackFingerprintKey: two listings with the same title but genuinely different price/brand/platform never collide", () => {
  const a = fallbackFingerprintKey({
    title: "item · other",
    product_url: null,
    image_url: null,
    price: 12,
    brand: "Nike",
    platform: "Depop",
    category: "tops",
  });
  const b = fallbackFingerprintKey({
    title: "item · other",
    product_url: null,
    image_url: null,
    price: 45,
    brand: "Zara",
    platform: "Vinted",
    category: "dresses",
  });
  assert.notEqual(a, b);
});

test("fallbackFingerprintKey: same listing re-extracted twice (identical fields) produces the same key", () => {
  const candidate = {
    title: "Vintage Levi's Jacket",
    product_url: "https://www.depop.com/products/abc-123",
    image_url: "https://images1.vinted.net/photo.jpg",
    price: 25,
    brand: "Levi's",
    platform: "Depop",
    category: "outerwear",
  };
  assert.equal(fallbackFingerprintKey(candidate), fallbackFingerprintKey({ ...candidate }));
});

test("fallbackFingerprintKey ignores product_url/image_url — those are handled by earlier, stronger tiers", () => {
  const a = fallbackFingerprintKey({
    title: "Vintage Levi's Jacket",
    product_url: "https://www.depop.com/products/abc-123",
    image_url: "https://images1.vinted.net/photo-a.jpg",
    price: 25,
    brand: "Levi's",
    platform: "Depop",
    category: "outerwear",
  });
  const b = fallbackFingerprintKey({
    title: "Vintage Levi's Jacket",
    product_url: "https://www.vinted.com/items/999",
    image_url: "https://images1.vinted.net/photo-b.jpg",
    price: 25,
    brand: "Levi's",
    platform: "Depop",
    category: "outerwear",
  });
  assert.equal(a, b);
});
