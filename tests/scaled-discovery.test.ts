import { test } from "node:test";
import assert from "node:assert/strict";
import { collectDiscoveredUrls } from "@/lib/inventory/scaled-discovery";
import type { DiscoveredCandidate } from "@/lib/marketplace-discovery";

function buildSharedFound(count: number): Map<string, DiscoveredCandidate> {
  const map = new Map<string, DiscoveredCandidate>();
  for (let i = 0; i < count; i++) {
    const url = `https://www.vinted.com/items/${i}-test-listing`;
    map.set(url, { url, priceHint: null, platform: "Vinted" });
  }
  return map;
}

test("collectDiscoveredUrls returns every discovered URL, not just targetCount worth", () => {
  // Regression for the discovery -> extraction handoff bug: discovery
  // found 500 candidates this call, targetCount (the discovery STOPPING
  // signal, checked elsewhere in crawlPlatform) was only 50 — every one
  // of the 500 must still survive into extraction. The old
  // `.slice(0, targetCount)` behavior would have returned only 50 here.
  const sharedFound = buildSharedFound(500);
  const urls = collectDiscoveredUrls(sharedFound);

  assert.equal(urls.length, 500, "all 500 discovered URLs must survive, none silently dropped");
  assert.deepEqual(new Set(urls), new Set(sharedFound.keys()), "returned URLs must exactly match what was discovered");
});

test("collectDiscoveredUrls takes no targetCount parameter — it structurally cannot truncate on it", () => {
  // The fix isn't "pass a bigger targetCount" — it's that this function's
  // signature has no truncation knob at all. targetCount only ever
  // controls when crawlPlatform's own discovery loop stops looking for
  // more (a separate, already-existing check), never how many of what it
  // found make it back to the caller.
  assert.equal(collectDiscoveredUrls.length, 1, "collectDiscoveredUrls should only take the discovered-candidates map");
});

test("collectDiscoveredUrls is stable across repeated calls (read-only, no mutation)", () => {
  const sharedFound = buildSharedFound(10);
  const first = collectDiscoveredUrls(sharedFound);
  const second = collectDiscoveredUrls(sharedFound);
  assert.deepEqual(first, second);
  assert.equal(sharedFound.size, 10, "collectDiscoveredUrls must not mutate its input");
});
