// Run with: npm test (tests/**/*.test.ts)
//
// Covers the Discover sort-dropdown rework: a "Default" option (value "",
// label "Default") added at the top, meaning "don't override the
// algorithm's own personalized ranking (highest matchPercent first)" —
// distinct from "no sorting at all." sortDiscoverListings/
// parseDiscoverSortOption/DEFAULT_DISCOVER_SORT are pure and exported
// from discover-feed.ts (thin adapters over discover-sort.ts's shared
// applyDiscoverSort — see that file's own header comment for why the
// actual logic lives there instead: DiscoverView.tsx, a client component,
// needs the exact same logic to re-sort client-side). DiscoverView.tsx's
// href builders/state aren't extractable pure functions, so the
// URL-preservation, "no full reload," and dropdown-contents requirements
// are verified with the same source-level regression-guard pattern
// tests/homepage-bottom-cta.test.ts already establishes for this project
// (no React-rendering test harness).
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

function makeEntry(overrides: Partial<Listing> & { id: string; matchPercent?: number }): DiscoverSortEntry {
  const { matchPercent = 50, ...listingOverrides } = overrides;
  return { listing: makeListing(listingOverrides), matchPercent, stylePoints: 0, fashionQualityScore: 100 };
}

test("Default (\"\") is the default sort", () => {
  assert.equal(DEFAULT_DISCOVER_SORT, "");
  assert.equal(parseDiscoverSortOption(undefined), "");
  assert.equal(parseDiscoverSortOption(null), "");
  assert.equal(parseDiscoverSortOption(""), "");
});

test("an empty or missing ?sort= parameter resolves to Default", () => {
  assert.equal(parseDiscoverSortOption(""), "");
  assert.equal(parseDiscoverSortOption(null), "");
  assert.equal(parseDiscoverSortOption(undefined), "");
});

test("an unrecognized or old ?sort= value (including the removed 'match'/'points') falls back to Default", () => {
  assert.equal(parseDiscoverSortOption("match"), "");
  assert.equal(parseDiscoverSortOption("points"), "");
  assert.equal(parseDiscoverSortOption("bogus"), "");
});

test("recognizes exactly the three real non-default values", () => {
  assert.equal(parseDiscoverSortOption("recent"), "recent");
  assert.equal(parseDiscoverSortOption("price_asc"), "price_asc");
  assert.equal(parseDiscoverSortOption("price_desc"), "price_desc");
});

test("Default preserves the personalized order — highest matchPercent first", () => {
  const low = makeEntry({ id: "low", matchPercent: 20, created_at: "2026-03-01T00:00:00.000Z" });
  const high = makeEntry({ id: "high", matchPercent: 90, created_at: "2026-01-01T00:00:00.000Z" });
  const mid = makeEntry({ id: "mid", matchPercent: 55, created_at: "2026-02-01T00:00:00.000Z" });

  // Fed in an order that matches NEITHER matchPercent nor created_at, so
  // a passthrough (no real sort) would fail this assertion by coincidence.
  const sorted = sortDiscoverListings([low, mid, high], "");

  assert.deepEqual(
    sorted.map((entry) => entry.listing.id),
    ["high", "mid", "low"],
  );
});

test("switching to Most Recent changes the ordering from Default", () => {
  // Deliberately inverted: the highest-matchPercent item is the OLDEST,
  // so Default and "recent" must disagree.
  const oldestBestMatch = makeEntry({ id: "a", matchPercent: 90, created_at: "2026-01-01T00:00:00.000Z" });
  const newestWorstMatch = makeEntry({ id: "b", matchPercent: 20, created_at: "2026-03-01T00:00:00.000Z" });
  const middle = makeEntry({ id: "c", matchPercent: 55, created_at: "2026-02-01T00:00:00.000Z" });

  const defaultOrder = sortDiscoverListings([oldestBestMatch, newestWorstMatch, middle], "").map((e) => e.listing.id);
  const recentOrder = sortDiscoverListings([oldestBestMatch, newestWorstMatch, middle], "recent").map((e) => e.listing.id);

  assert.deepEqual(defaultOrder, ["a", "c", "b"]); // matchPercent descending
  assert.deepEqual(recentOrder, ["b", "c", "a"]); // created_at descending
  assert.notDeepEqual(defaultOrder, recentOrder);
});

test("switching back to Default restores the original personalized order exactly", () => {
  const oldestBestMatch = makeEntry({ id: "a", matchPercent: 90, created_at: "2026-01-01T00:00:00.000Z" });
  const newestWorstMatch = makeEntry({ id: "b", matchPercent: 20, created_at: "2026-03-01T00:00:00.000Z" });
  const middle = makeEntry({ id: "c", matchPercent: 55, created_at: "2026-02-01T00:00:00.000Z" });

  const original = [oldestBestMatch, newestWorstMatch, middle];
  const personalizedOrder = sortDiscoverListings(original, "").map((e) => e.listing.id);

  // Re-sort by every other option first, THEN back to Default each time —
  // applyDiscoverSort always recomputes the personalized ranking fresh
  // from matchPercent, so it must land on the exact same order regardless
  // of what order the array happened to be in beforehand.
  for (const detour of ["recent", "price_asc", "price_desc"] as const) {
    const detoured = sortDiscoverListings(original, detour);
    const restored = sortDiscoverListings(detoured, "").map((e) => e.listing.id);
    assert.deepEqual(restored, personalizedOrder, `expected Default to restore the personalized order after a detour through '${detour}'`);
  }
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

// Source-level regression guards — DiscoverView.tsx's state/href builders
// aren't exported pure functions (they close over component state), so
// these confirm the structural property directly against the component
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

test("the sort dropdown contains exactly Default, Most Recent, Price: Low to High, Price: High to Low — no Best Match/Best Style Match/Highest Style Points", () => {
  const sortOptionsStart = discoverViewSource.indexOf("const SORT_OPTIONS");
  const sortOptionsEnd = discoverViewSource.indexOf("];", sortOptionsStart);
  const sortOptionsBlock = discoverViewSource.slice(sortOptionsStart, sortOptionsEnd);

  assert.ok(!/best\s*(style\s*)?match/i.test(sortOptionsBlock), "expected no 'Best Match'/'Best Style Match' label in SORT_OPTIONS");
  assert.ok(!/highest style points/i.test(sortOptionsBlock), "expected no 'Highest Style Points' label in SORT_OPTIONS");
  assert.ok(!sortOptionsBlock.includes('"match"'), 'expected no "match" value in SORT_OPTIONS');
  assert.ok(!sortOptionsBlock.includes('"points"'), 'expected no "points" value in SORT_OPTIONS');

  assert.ok(sortOptionsBlock.includes('value: "", label: "Default"'), "expected a blank Default option at value \"\"");
  assert.ok(sortOptionsBlock.includes('"recent"') && sortOptionsBlock.includes("Most Recent"));
  assert.ok(sortOptionsBlock.includes('"price_asc"') && sortOptionsBlock.includes("Price: Low to High"));
  assert.ok(sortOptionsBlock.includes('"price_desc"') && sortOptionsBlock.includes("Price: High to Low"));

  // Default must be the FIRST option, per this feature's own spec.
  assert.ok(
    sortOptionsBlock.indexOf('value: ""') < sortOptionsBlock.indexOf('value: "recent"'),
    "expected Default to appear before Most Recent in the dropdown",
  );
});

test("the sort state initializes from the server-provided prop, defaulting to \"\" (Default)", () => {
  assert.ok(
    discoverViewSource.includes('sortOption: initialSortOption = ""'),
    "expected DiscoverView's sortOption prop to default to \"\" (Default)",
  );
  assert.ok(
    discoverViewSource.includes("useState<DiscoverSortOption>(initialSortOption)"),
    "expected sortOption to be initialized as component state from the initial prop",
  );
});

test("switching sort does not navigate/reload — it updates state and the URL via history.replaceState, not router.push/replace", () => {
  const handlerStart = discoverViewSource.indexOf("function handleSortChange(");
  assert.notEqual(handlerStart, -1, "expected to find handleSortChange in DiscoverView.tsx");
  const handlerEnd = discoverViewSource.indexOf("\n  }", handlerStart);
  const handlerBody = discoverViewSource.slice(handlerStart, handlerEnd);

  assert.ok(handlerBody.includes("setSortOption("), "expected handleSortChange to update sortOption state directly");
  assert.ok(handlerBody.includes("history.replaceState"), "expected the URL to be updated via history.replaceState, not a navigation");
  assert.ok(!handlerBody.includes("router.push") && !handlerBody.includes("router.replace"), "expected no router navigation when switching sort");
});
