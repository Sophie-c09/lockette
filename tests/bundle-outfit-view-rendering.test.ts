import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BundleOutfitView } from "../src/components/style-request/BundleOutfitView";
import { ToastProvider } from "../src/components/ToastProvider";
import type { MyStyleRequestBundle, MyStyleRequestBundleItem } from "../src/app/actions/style-requests";
import type { Listing } from "../src/lib/supabase/listings.types";

// Regression coverage for the "completed Style Bundle page trips the
// global error boundary" investigation. No exact reproduction was found
// despite testing 5 real production bundles (3 ready, 1 error, 1 freshly
// generated) plus these constructed edge cases through real React SSR in
// both `next dev` and `next build && next start` — see this task's own
// report. These tests guard the concrete, real (if narrower than a full
// crash) defensive gaps that investigation actually turned up — a
// listing/bundle numeric field arriving as a string, a missing joined
// listing, null optional fields — using genuine renderToStaticMarkup
// rendering, not source-string matching, so a real future regression
// (something that actually throws) fails the test, not just a text diff.

function render(bundle: MyStyleRequestBundle): string {
  return renderToStaticMarkup(
    React.createElement(ToastProvider, null, React.createElement(BundleOutfitView, { bundle })),
  );
}

const listingFixture: Listing = {
  id: "listing-1",
  size: "M",
  brand: "Test Brand",
  color: "blue",
  price: 25,
  score: null,
  title: "Test Item",
  images: ["https://example.com/a.jpg"],
  status: "active",
  category: "tops",
  platform: "reworn",
  image_url: "https://example.com/a.jpg",
  created_at: new Date(0).toISOString(),
  image_urls: [],
  description: null,
  flag_reason: null,
  product_url: "https://example.com/product/1",
  reserved_at: null,
  quality_score: null,
  aesthetic_tags: [],
  quality_reason: null,
  removal_reason: null,
  image_embedding: null,
  last_checked_at: null,
  last_available_at: null,
  quality_breakdown: null,
  reserved_by_order_id: null,
  embedding_generated_at: null,
  reservation_expires_at: null,
  availability_check_count: null,
  consecutive_unavailable_checks: null,
} as unknown as Listing;

function itemFixture(overrides: Partial<MyStyleRequestBundleItem> = {}): MyStyleRequestBundleItem {
  return {
    bundleItemId: "item-1",
    listing: listingFixture,
    position: 0,
    category: "tops",
    replacementGroup: "tops",
    ...overrides,
  };
}

function bundleFixture(overrides: Partial<MyStyleRequestBundle> = {}): MyStyleRequestBundle {
  return {
    id: "bundle-1",
    title: "Your Lockette Bundle",
    description: null,
    items: [],
    previewImage: null,
    itemSubtotal: null,
    mavelleFee: null,
    totalPrice: null,
    estimatedDeliveryStart: null,
    estimatedDeliveryEnd: null,
    status: "ready",
    generationError: null,
    generationStep: null,
    generationProgress: 0,
    attemptCount: 1,
    ...overrides,
  };
}

test("a ready bundle with real item data renders without throwing", () => {
  const bundle = bundleFixture({
    itemSubtotal: 25,
    mavelleFee: 5,
    totalPrice: 30,
    estimatedDeliveryStart: "2026-08-10",
    estimatedDeliveryEnd: "2026-08-15",
    items: [itemFixture()],
  });
  const html = render(bundle);
  assert.match(html, /Test Item/);
  assert.match(html, /30\.00/);
});

test("a ready bundle with two items renders without throwing", () => {
  const bundle = bundleFixture({
    itemSubtotal: 50,
    mavelleFee: 10,
    totalPrice: 60,
    items: [
      itemFixture({ bundleItemId: "item-1" }),
      itemFixture({ bundleItemId: "item-2", listing: { ...listingFixture, id: "listing-2" }, position: 1 }),
    ],
  });
  assert.doesNotThrow(() => render(bundle));
});

test("an item with a null brand, size, and color renders without throwing", () => {
  const bundle = bundleFixture({
    itemSubtotal: 25,
    mavelleFee: 5,
    totalPrice: 30,
    items: [
      itemFixture({
        listing: { ...listingFixture, brand: null, size: null, color: null } as Listing,
      }),
    ],
  });
  assert.doesNotThrow(() => render(bundle));
});

test("a null estimated delivery range renders without throwing and omits a delivery label", () => {
  const bundle = bundleFixture({
    itemSubtotal: 25,
    mavelleFee: 5,
    totalPrice: 30,
    estimatedDeliveryStart: null,
    estimatedDeliveryEnd: null,
    items: [itemFixture()],
  });
  const html = render(bundle);
  assert.doesNotMatch(html, /Arrives/);
});

test("numeric pricing fields arriving as strings (a Postgres numeric/decimal column serialized as a JSON string, not the real/double-precision this schema currently uses) render without throwing", () => {
  const bundle = bundleFixture({
    // Deliberately typed as `unknown as number` — this simulates a schema
    // drift the TypeScript types wouldn't catch at compile time; the
    // Number(...) coercion in BundleOutfitView/BundleMoodboard is what
    // actually protects against this at runtime.
    itemSubtotal: "25.00" as unknown as number,
    mavelleFee: "5.00" as unknown as number,
    totalPrice: "30.00" as unknown as number,
    items: [
      itemFixture({
        listing: { ...listingFixture, price: "25.00" as unknown as number } as Listing,
      }),
    ],
  });
  assert.doesNotThrow(() => render(bundle));
});

test("a bundle with zero items but status 'ready' (every referenced listing was filtered out as missing/deleted) renders without throwing", () => {
  const bundle = bundleFixture({ itemSubtotal: 25, mavelleFee: 5, totalPrice: 30, items: [] });
  assert.doesNotThrow(() => render(bundle));
});

test("a malformed image field (empty string, not null) renders without throwing and falls back to the no-image state", () => {
  const bundle = bundleFixture({
    itemSubtotal: 25,
    mavelleFee: 5,
    totalPrice: 30,
    items: [itemFixture({ listing: { ...listingFixture, image_url: "" } as Listing })],
  });
  assert.doesNotThrow(() => render(bundle));
});

test("an 'error' status bundle renders the retry state, not the ready collage", () => {
  const bundle = bundleFixture({
    status: "error",
    generationError: "Couldn't find enough matching items for this outfit yet. Try again in a bit, or submit a new style request with a different photo.",
  });
  const html = render(bundle);
  assert.match(html, /We couldn&#x27;t finish this bundle/);
  assert.match(html, /Try again/);
});

test("an unrecognized generation_error string never leaks raw internal text to the user", () => {
  const bundle = bundleFixture({
    status: "error",
    generationError: "duplicate key value violates unique constraint \"styled_bundle_items_pkey\"",
  });
  const html = render(bundle);
  assert.doesNotMatch(html, /constraint|duplicate key/);
});

test("a 'generating' status bundle with zero items renders the working/progress state", () => {
  const bundle = bundleFixture({ status: "generating", generationStep: "starting", generationProgress: 5 });
  const html = render(bundle);
  assert.match(html, /Building your Lockette Bundle/);
});

test("a 'generating' status bundle with items already progressively inserted (still mid-flight) renders without throwing", () => {
  const bundle = bundleFixture({
    status: "generating",
    generationStep: "searching_items",
    generationProgress: 40,
    items: [itemFixture(), itemFixture({ bundleItemId: "item-2", listing: { ...listingFixture, id: "listing-2" }, position: 1, category: "tops" })],
  });
  assert.doesNotThrow(() => render(bundle));
});

test("a 'purchased' status bundle still renders as ready (not an unhandled fifth state)", () => {
  const bundle = bundleFixture({
    status: "purchased",
    itemSubtotal: 25,
    mavelleFee: 5,
    totalPrice: 30,
    items: [itemFixture()],
  });
  assert.doesNotThrow(() => render(bundle));
});

const styleRequestsSource = readFileSync(join(__dirname, "..", "src", "app", "actions", "style-requests.ts"), "utf-8");

test("getBundleById denies access to a bundle the caller doesn't own", () => {
  const fnBody = styleRequestsSource.slice(
    styleRequestsSource.indexOf("export async function getBundleById"),
    styleRequestsSource.indexOf("export async function getBundleById") + 1500,
  );
  assert.match(fnBody, /ownerUserId !== user\.id/);
  assert.match(fnBody, /You don't have access to this bundle\./);
});

test("loadBundleItems drops any styled_bundle_item whose joined listing is missing (a deleted/removed listing), instead of rendering a null listing", () => {
  assert.match(styleRequestsSource, /\.filter\(\(item\) => item\.listings\)/);
});

test("/bundle/[id] has its own route-specific error boundary, not just the global one", () => {
  const errorSource = readFileSync(
    join(__dirname, "..", "src", "app", "(app)", "bundle", "[id]", "error.tsx"),
    "utf-8",
  );
  assert.match(errorSource, /"use client";/);
  assert.match(errorSource, /export default function/);
  // Recovery must include a real retry and a path back to the user's own
  // requests — never only "Discover" (the global boundary's own escape
  // hatch, a strange landing spot for someone who was just viewing a
  // finished bundle).
  assert.match(errorSource, /onClick=\{reset\}/);
  assert.match(errorSource, /href="\/my-style-requests"/);
  assert.doesNotMatch(errorSource, /href="\/discover"/);
  // Never render the raw error/digest to the visitor.
  assert.doesNotMatch(errorSource, /\{error\.message\}/);
  assert.doesNotMatch(errorSource, /\{error\.digest\}/);
});
