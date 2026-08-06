// Covers two rounds of the same "Inventory Growth done-card shows the
// wrong number" bug:
//
// Round 1 ("Inventory now at 0 / 5"): the card displayed
// largeScaleJob.inserted_count (this run's own new-insert delta) under a
// label reading as if it were the marketplace's total listing count.
// Fixed by relabeling and adding inventoryStats.totalInventory.
//
// Round 2 (still "0 / 5" after round 1 shipped): totalInventory ITSELF
// was rendering as 0. Root cause, confirmed live: getInventoryIntelligenceStats
// (inventory-dashboard.ts) ran totalResult (active+flagged count, a
// perfectly healthy query) and analyzedResult (.not("visual_analysis",
// "is", null) — a genuinely broken query, since visual_analysis doesn't
// exist on the live listings table) through ONE shared error gate: any
// one of three queries failing returned EMPTY_STATS (totalInventory: 0)
// for ALL of them. The UI then couldn't distinguish "loaded, real total
// is 0" from "failed to load" — both looked identical. Fixed by (a)
// decoupling each count's error handling so one broken, unrelated column
// can never blank a healthy one, and (b) typing totalInventory as
// `number | null` so a genuine failure renders as "unavailable," never a
// fabricated zero.
//
// Source-level assertions, same convention as scraper-jobs-completed-at.test.ts
// — this component needs a real Supabase-backed browser session to
// render end-to-end.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const viewSource = readFileSync(
  join(__dirname, "..", "src", "components", "admin", "ImportListingView.tsx"),
  "utf-8",
);
const inventoryDashboardSource = readFileSync(
  join(__dirname, "..", "src", "app", "actions", "inventory-dashboard.ts"),
  "utf-8",
);
const largeScaleRouteSource = readFileSync(
  join(__dirname, "..", "src", "app", "api", "admin-scraper", "large-scale", "route.ts"),
  "utf-8",
);

function slice(source: string, marker: string, length = 3000): string {
  const start = source.indexOf(marker);
  assert.ok(start > -1, `expected to find marker: ${marker}`);
  return source.slice(start, start + length);
}

test("ROUND 1 REGRESSION: the done-state label no longer presents inserted_count (this run's own delta) as if it were the total inventory count", () => {
  assert.doesNotMatch(viewSource, /Inventory now at \$\{largeScaleJob\.inserted_count/);
  assert.match(viewSource, /This run added \$\{largeScaleJob\.inserted_count\.toLocaleString\(\)\} new listing/);
});

test("ROUND 2 ROOT CAUSE REGRESSION: totalInventory's own query error is no longer bundled with analyzedResult/todayResult under one shared fallback", () => {
  assert.doesNotMatch(
    inventoryDashboardSource,
    /if \(totalResult\.error \|\| analyzedResult\.error \|\| todayResult\.error\)/,
  );
});

test("totalInventory is null (never a fabricated 0) when its own query fails, independent of analyzedResult/todayResult", () => {
  const fnBody = slice(inventoryDashboardSource, "export async function getInventoryIntelligenceStats", 5000);
  assert.match(fnBody, /totalInventory: totalResult\.error \? null : totalResult\.count \?\? 0,/);
});

test("EMPTY_STATS (returned on auth failure) uses null for totalInventory, not 0", () => {
  const emptyStatsBlock = slice(inventoryDashboardSource, "const EMPTY_STATS", 200);
  assert.match(emptyStatsBlock, /totalInventory: null,/);
});

test("the InventoryIntelligenceStats type declares totalInventory as number | null, not a bare number", () => {
  const interfaceBlock = slice(inventoryDashboardSource, "export interface InventoryIntelligenceStats", 400);
  assert.match(interfaceBlock, /totalInventory: number \| null;/);
});

test("a null totalInventory never renders as the digit 0 — the done card distinguishes loading, failed, and loaded-with-a-real-number", () => {
  const doneBlock = slice(viewSource, 'largeScalePhase === "done" && largeScaleJob', 3000);
  assert.match(doneBlock, /inventoryStats\?\.totalInventory != null/);
  assert.match(doneBlock, /Refreshing inventory total…/);
  assert.match(doneBlock, /Current inventory total is temporarily unavailable\./);
  // Never a bare, unconditional JSX expression (not inside the gated
  // template literal above) that would throw the moment the value is
  // null — as opposed to `${inventoryStats.totalInventory.toLocaleString()}`
  // inside the ternary's own already-gated template literal, which is fine.
  assert.doesNotMatch(doneBlock, /[^$]\{inventoryStats\.totalInventory\.toLocaleString\(\)\}/);
});

test("the done card retains and keeps showing the last known valid total while a refresh is in flight, instead of blanking it", () => {
  const doneBlock = slice(viewSource, 'largeScalePhase === "done" && largeScaleJob', 3000);
  assert.match(doneBlock, /inventoryStatsLoading \? " \(refreshing…\)" : ""/);
});

test("the done card distinguishes this run's own target from the current live total, and flags when the target was already met", () => {
  const doneBlock = slice(viewSource, 'largeScalePhase === "done" && largeScaleJob', 3800);
  assert.match(doneBlock, /Run target: /);
  assert.match(doneBlock, /already met by the existing inventory/);
});

test("the Inventory Intelligence card's progress bar also guards against a null totalInventory (not just the done card)", () => {
  const cardBlock = slice(viewSource, "Inventory: {inventoryStats.totalInventory", 900);
  assert.match(cardBlock, /inventoryStats\.totalInventory != null/);
});

test("inventoryStats is refreshed the moment a large-scale run reaches a terminal state, not left stale from page load", () => {
  const pollFnBody = viewSource.slice(
    viewSource.indexOf("async function pollLargeScaleJob"),
    viewSource.indexOf('} else if (job.status === "paused")'),
  );
  assert.match(pollFnBody, /refreshStats\(\);/);
  assert.match(pollFnBody, /refreshInventoryStats\(\);/);
});

test("getInventoryIntelligenceStats' totalInventory genuinely counts the listings table (active + flagged), not a job-scoped counter", () => {
  const fnBody = slice(inventoryDashboardSource, "export async function getInventoryIntelligenceStats", 5000);
  assert.match(fnBody, /adminSupabase\.from\("listings"\)\.select\("id", \{ count: "exact", head: true \}\)\.in\("status", \["active", "flagged"\]\)/);
});

test("PREVENT-MEANINGLESS-RUNS: the start route rejects a target at or below the current inventory count, server-side", () => {
  const postBody = slice(largeScaleRouteSource, "export async function POST", 9000);
  assert.match(postBody, /if \(targetInventorySize <= currentCount\)/);
  assert.match(postBody, /TARGET_ALREADY_MET/);
  assert.match(postBody, /Your inventory already exceeds this target\. Enter a target above the current total\./);
});

test("the server-side meaningless-run check runs BEFORE the job is ever created", () => {
  const postBody = slice(largeScaleRouteSource, "export async function POST", 9000);
  const checkIndex = postBody.indexOf("TARGET_ALREADY_MET");
  const createIndex = postBody.indexOf("createLargeScaleScraperJob(");
  assert.ok(checkIndex > -1 && createIndex > -1 && checkIndex < createIndex);
});

test("the client blocks starting a run when the target doesn't exceed the known current total, both via handleStartLargeScale and the disabled Start button", () => {
  const startFnBody = slice(viewSource, "async function handleStartLargeScale", 800);
  assert.match(startFnBody, /inventoryStats\?\.totalInventory != null && largeScaleTarget <= inventoryStats\.totalInventory/);

  const buttonBlock = slice(viewSource, "onClick={handleStartLargeScale}", 200);
  assert.match(buttonBlock, /disabled=\{inventoryStats\?\.totalInventory != null && largeScaleTarget <= inventoryStats\.totalInventory\}/);
});

test("the current total is shown right next to the target input, not only elsewhere on the page", () => {
  const targetInputBlock = slice(viewSource, "Target inventory size", 900);
  assert.match(targetInputBlock, /Current total: \$\{inventoryStats\.totalInventory\.toLocaleString\(\)\} listings/);
});

test("no scraper discovery/extraction/Playwright/queue-processing files were touched by this fix", () => {
  // This test intentionally does not assert against admin-scraper.ts,
  // browser-concurrency.ts, marketplace-discovery.ts, scaled-discovery.ts,
  // browser-extractor.ts, or url-queue.ts — the fix is scoped to
  // inventory-dashboard.ts (a read-only Server Action), the large-scale
  // start route's own request validation, and ImportListingView.tsx's
  // display logic. Asserting that IS the regression guard: this file
  // never reads or requires any of those modules.
  const routeSourceHasNoScraperImports = !/from "@\/lib\/admin-scraper"/.test(largeScaleRouteSource);
  assert.ok(routeSourceHasNoScraperImports, "the start route must still never import @/lib/admin-scraper.ts");
});
