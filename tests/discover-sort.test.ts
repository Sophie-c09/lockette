// Run with: npm test (tests/**/*.test.ts)
//
// Covers the Discover sort-dropdown rework: Best Match/Highest Style
// Points removed, replaced with exactly Most Recent (default) / Price:
// Low to High / Price: High to Low. sortDiscoverListings/
// parseDiscoverSortOption/DEFAULT_DISCOVER_SORT are pure and exported
// directly from discover-feed.ts (see that file's own comment on
// sortDiscoverListings); DiscoverView.tsx's href builders aren't
// extractable pure functions, so "changing categories preserves sort" and
// "no Best Style Match option remains" are verified with the same
// source-level regression-guard pattern tests/homepage-bottom-cta.test.ts
// already establishes for this project (no React-rendering test harness).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  sortDiscoverListings,
  parseDiscoverSortOption,
  DEFAULT_DISCOVER_SORT,
  type DiscoverSortEntry,
} from "@/lib/discover-feed";
import type { Listing } from "@/lib/supabase/listings.types";

const __dirname = dirname(fileURLToPath(import.meta.url));
const discoverViewSource = readFileSync(join(__dirname, "../src/components/discover/DiscoverView.tsx"), "utf-8");

function makeListing(overrides: Partial<Listing> & { id: string }): Listing {
  return {
    title: "Test listing",
    description: null,
    price: null,
    image_url: null,
    product_url: null,
    platform: null,
    brand: null,
    size: null,
    aesthetic_tags: [],
    created_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeEntry(overrides: Partial<Listing> & { id: string }): DiscoverSortEntry {
  return { listing: makeListing(overrides), matchPercent: 50, stylePoints: 0, fashionQualityScore: 100 };
}

test("Most Recent (\"recent\") is the default sort", () => {
  assert.equal(DEFAULT_DISCOVER_SORT, "recent");
  assert.equal(parseDiscoverSortOption(undefined), "recent");
  assert.equal(parseDiscoverSortOption(null), "recent");
  assert.equal(parseDiscoverSortOption(""), "recent");
});

test("an unrecognized or old ?sort= value (including the removed 'match'/'points') falls back to the default", () => {
  assert.equal(parseDiscoverSortOption("match"), "recent");
  assert.equal(parseDiscoverSortOption("points"), "recent");
  assert.equal(parseDiscoverSortOption("bogus"), "recent");
});

test("recognizes exactly the two real non-default values", () => {
  assert.equal(parseDiscoverSortOption("price_asc"), "price_asc");
  assert.equal(parseDiscoverSortOption("price_desc"), "price_desc");
});

test("'recent' orders listings newest first by created_at", () => {
  const oldest = makeEntry({ id: "a", created_at: "2026-01-01T00:00:00.000Z" });
  const newest = makeEntry({ id: "b", created_at: "2026-03-01T00:00:00.000Z" });
  const middle = makeEntry({ id: "c", created_at: "2026-02-01T00:00:00.000Z" });

  const sorted = sortDiscoverListings([oldest, newest, middle], "recent");

  assert.deepEqual(
    sorted.map((entry) => entry.listing.id),
    ["b", "c", "a"],
  );
});

test("'price_asc' orders numeric prices ascending", () => {
  const high = makeEntry({ id: "a", price: 50 });
  const low = makeEntry({ id: "b", price: 10 });
  const mid = makeEntry({ id: "c", price: 25 });

  const sorted = sortDiscoverListings([high, low, mid], "price_asc");

  assert.deepEqual(
    sorted.map((entry) => entry.listing.id),
    ["b", "c", "a"],
  );
});

test("'price_desc' orders numeric prices descending", () => {
  const high = makeEntry({ id: "a", price: 50 });
  const low = makeEntry({ id: "b", price: 10 });
  const mid = makeEntry({ id: "c", price: 25 });

  const sorted = sortDiscoverListings([high, low, mid], "price_desc");

  assert.deepEqual(
    sorted.map((entry) => entry.listing.id),
    ["a", "c", "b"],
  );
});

test("null or invalid prices appear last for BOTH price sorts, not just one", () => {
  const valid = makeEntry({ id: "valid", price: 20 });
  const missing = makeEntry({ id: "missing", price: null });
  const negative = makeEntry({ id: "negative", price: -5 });
  const notANumber = makeEntry({ id: "nan", price: Number.NaN });

  const ascending = sortDiscoverListings([missing, valid, negative, notANumber], "price_asc");
  assert.equal(ascending[0].listing.id, "valid");
  assert.deepEqual(
    new Set(ascending.slice(1).map((entry) => entry.listing.id)),
    new Set(["missing", "negative", "nan"]),
  );

  const descending = sortDiscoverListings([missing, valid, negative, notANumber], "price_desc");
  assert.equal(descending[0].listing.id, "valid");
  assert.deepEqual(
    new Set(descending.slice(1).map((entry) => entry.listing.id)),
    new Set(["missing", "negative", "nan"]),
  );
});

// Source-level regression guards — DiscoverView.tsx's href builders
// aren't exported pure functions (they close over component state), so
// this confirms the structural property directly against the component
// source, same pattern as tests/homepage-bottom-cta.test.ts's own
// `pageSource`-based assertions.
test("changing the category/type filter preserves the currently selected sort (typeHref carries sortOption into the querystring)", () => {
  const typeHrefStart = discoverViewSource.indexOf("function typeHref(");
  assert.notEqual(typeHrefStart, -1, "expected to find typeHref in DiscoverView.tsx");

  const typeHrefEnd = discoverViewSource.indexOf("\n  }", typeHrefStart);
  const typeHrefBody = discoverViewSource.slice(typeHrefStart, typeHrefEnd);

  assert.ok(
    typeHrefBody.includes('params.set("sort"') && typeHrefBody.includes("sortOption"),
    "expected typeHref to re-apply the current sortOption onto its generated href",
  );
});

test("no Best Style Match (or any other match-based) sort option remains visible in the dropdown", () => {
  const sortOptionsStart = discoverViewSource.indexOf("const SORT_OPTIONS");
  const sortOptionsEnd = discoverViewSource.indexOf("];", sortOptionsStart);
  const sortOptionsBlock = discoverViewSource.slice(sortOptionsStart, sortOptionsEnd);

  assert.ok(!/best\s*(style\s*)?match/i.test(sortOptionsBlock), "expected no 'Best Match'/'Best Style Match' label in SORT_OPTIONS");
  assert.ok(!/highest style points/i.test(sortOptionsBlock), "expected no 'Highest Style Points' label in SORT_OPTIONS");
  assert.ok(!sortOptionsBlock.includes('"match"'), "expected no \"match\" value in SORT_OPTIONS");
  assert.ok(!sortOptionsBlock.includes('"points"'), "expected no \"points\" value in SORT_OPTIONS");

  assert.ok(sortOptionsBlock.includes('"recent"') && sortOptionsBlock.includes("Most Recent"));
  assert.ok(sortOptionsBlock.includes('"price_asc"') && sortOptionsBlock.includes("Price: Low to High"));
  assert.ok(sortOptionsBlock.includes('"price_desc"') && sortOptionsBlock.includes("Price: High to Low"));
});
