// Covers the P0 launch-readiness fix for browser-concurrency.ts: the
// discovery reuse pool (acquirePooledBrowser/releasePooledBrowser) used to
// gate new launches on its OWN `pooledBrowsers.length < MAX_ACTIVE_BROWSERS`
// check, entirely independent from the per-URL fallback pool's
// reservedSlots/acquireBrowserSlot — up to 2x MAX_ACTIVE_BROWSERS real
// Chromium instances could be alive at once. Source-level assertions
// (not a behavioral test): this module launches real Chromium processes
// via Playwright, which this project's automated suite deliberately
// avoids depending on (slow, environment-dependent, not what this fix is
// actually about — the fix is which counter gates a launch).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(join(__dirname, "..", "src", "lib", "browser-concurrency.ts"), "utf-8");

test("a NEW pooled-browser launch reserves a slot from the shared acquireBrowserSlot gate, not an independent pool-size check", () => {
  const acquirePooledFn = source.slice(
    source.indexOf("export async function acquirePooledBrowser"),
    source.indexOf("export function releasePooledBrowser"),
  );
  assert.match(acquirePooledFn, /await acquireBrowserSlot\(\)/);
  assert.doesNotMatch(acquirePooledFn, /pooledBrowsers\.length\s*<\s*MAX_ACTIVE_BROWSERS/);
});

test("a failed pooled-browser launch releases the slot it reserved", () => {
  const acquirePooledFn = source.slice(
    source.indexOf("export async function acquirePooledBrowser"),
    source.indexOf("export function releasePooledBrowser"),
  );
  assert.match(acquirePooledFn, /catch \(error\)[\s\S]*releaseSlotAndAdvanceQueue\(\)[\s\S]*throw error/);
});

test("a disconnected/crashed pooled browser releases its slot on discard, both while idle and on release", () => {
  const acquirePooledFn = source.slice(
    source.indexOf("export async function acquirePooledBrowser"),
    source.indexOf("export function releasePooledBrowser"),
  );
  const releasePooledFn = source.slice(
    source.indexOf("export function releasePooledBrowser"),
    source.indexOf("async function forceClosePooledBrowsers"),
  );
  assert.match(acquirePooledFn, /dropFromPool\(candidate\);\s*releaseSlotAndAdvanceQueue\(\);/);
  assert.match(releasePooledFn, /dropFromPool\(browser\);\s*releaseSlotAndAdvanceQueue\(\);/);
});

test("force-closing pooled browsers releases one slot per browser closed", () => {
  const forceCloseFn = source.slice(source.indexOf("async function forceClosePooledBrowsers"));
  assert.match(forceCloseFn, /releaseSlotAndAdvanceQueue\(\)/);
});

test("the old independent pooledBrowserWaiters mechanism is gone — one shared wait queue now, not two", () => {
  assert.doesNotMatch(source, /pooledBrowserWaiters/);
});
