// Covers listing-flagging.ts's flagListing() — the one insert-time safety
// net all three ingestion paths (single import, bulk import, admin
// scraper) share (see each call site's own comment). Focused on the P0
// launch-readiness additions (URL/platform/removal-signal checks) plus
// the pre-existing hard-failure checks this function is the sole gate for.
import { test } from "node:test";
import assert from "node:assert/strict";
import { flagListing, type FlaggableListing } from "@/lib/inventory/listing-flagging";

function baseListing(overrides: Partial<FlaggableListing> = {}): FlaggableListing {
  return {
    title: "Vintage Levi's Jacket",
    description: "Great condition, barely worn.",
    images: ["https://images1.vinted.net/photo.jpg"],
    price: 25,
    category: "outerwear",
    productUrl: "https://www.vinted.com/items/12345",
    platform: "Vinted",
    removalSignal: null,
    ...overrides,
  };
}

test("a normal, complete listing is safe", () => {
  const result = flagListing(baseListing());
  assert.equal(result.isSafe, true);
  assert.equal(result.reasons, undefined);
});

test("a cheap, terse-but-real listing is still safe (never flagged for being cheap or terse)", () => {
  const result = flagListing(baseListing({ title: "Nike Shirt", price: 1 }));
  assert.equal(result.isSafe, true);
});

test("missing title is flagged", () => {
  const result = flagListing(baseListing({ title: "" }));
  assert.equal(result.isSafe, false);
  assert.ok(result.reasons?.some((r) => r.includes("title")));
});

test("zero or negative price is flagged, not silently accepted", () => {
  const zero = flagListing(baseListing({ price: 0 }));
  assert.equal(zero.isSafe, false);
  assert.ok(zero.reasons?.some((r) => r.includes("price")));

  const negative = flagListing(baseListing({ price: -5 }));
  assert.equal(negative.isSafe, false);
  assert.ok(negative.reasons?.some((r) => r.includes("price")));
});

test("no images at all is flagged", () => {
  const result = flagListing(baseListing({ images: [] }));
  assert.equal(result.isSafe, false);
  assert.ok(result.reasons?.some((r) => r.includes("no images")));
});

test("a placeholder/broken image URL is flagged", () => {
  const result = flagListing(baseListing({ images: ["https://cdn.example.com/no-image-placeholder.png"] }));
  assert.equal(result.isSafe, false);
  assert.ok(result.reasons?.some((r) => r.includes("broken image")));
});

test("an invalid or missing marketplace URL is flagged", () => {
  const missing = flagListing(baseListing({ productUrl: null }));
  assert.equal(missing.isSafe, false);
  assert.ok(missing.reasons?.some((r) => r.includes("invalid or missing marketplace URL")));

  const malformed = flagListing(baseListing({ productUrl: "not-a-url" }));
  assert.equal(malformed.isSafe, false);
  assert.ok(malformed.reasons?.some((r) => r.includes("invalid or missing marketplace URL")));
});

test("a valid marketplace URL never gets flagged for that check", () => {
  const result = flagListing(baseListing({ productUrl: "https://www.depop.com/products/abc-123" }));
  assert.equal(result.isSafe, true);
});

test("an unrecognized source platform (explicitly checked, found null) is flagged", () => {
  const result = flagListing(baseListing({ platform: null }));
  assert.equal(result.isSafe, false);
  assert.ok(result.reasons?.some((r) => r.includes("unrecognized source platform")));
});

test("omitting platform entirely (caller didn't check) is NOT flagged — only an explicit null is", () => {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructured only to omit platform from the spread below
  const { platform, ...withoutPlatform } = baseListing();
  const result = flagListing(withoutPlatform);
  assert.equal(result.isSafe, true);
});

test("a source-page removal signal is flagged with the specific reason surfaced", () => {
  const result = flagListing(
    baseListing({ removalSignal: 'source page says "this listing has sold"' }),
  );
  assert.equal(result.isSafe, false);
  assert.ok(result.reasons?.some((r) => r.includes("sold/removed")));
  assert.ok(result.reasons?.some((r) => r.includes("this listing has sold")));
});

test("a banned keyword (e.g. replica) is flagged", () => {
  const result = flagListing(baseListing({ title: "Replica Gucci Belt" }));
  assert.equal(result.isSafe, false);
  assert.ok(result.reasons?.some((r) => r.includes("banned keyword")));
});

test("a likely non-clothing item is flagged", () => {
  const result = flagListing(baseListing({ title: "iPhone 13 Pro Max", category: "electronics" }));
  assert.equal(result.isSafe, false);
  assert.ok(result.reasons?.some((r) => r.includes("non-clothing")));
});

test("multiple simultaneous failures all surface as separate reasons, not just the first", () => {
  const result = flagListing(
    baseListing({ title: "", price: 0, images: [], platform: null, productUrl: null }),
  );
  assert.equal(result.isSafe, false);
  assert.ok((result.reasons?.length ?? 0) >= 4);
});
