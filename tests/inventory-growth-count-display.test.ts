// Covers the "Inventory now at 0 / 5" dashboard bug — the Inventory
// Growth "done" card was displaying largeScaleJob.inserted_count (how
// many NEW listings THIS SPECIFIC run inserted since it started) under a
// label ("Inventory now at X / target") that reads as if X were the
// marketplace's real total listing count. Confirmed against real
// production data: inserted_count has always been small (tens, on every
// historical run) while the real listings table holds thousands — this
// was never a query/schema/RLS/env bug, purely a misleading label paired
// with the wrong number. Source-level assertions, same convention as
// scraper-jobs-completed-at.test.ts — this component needs a real
// Supabase-backed browser session to render end-to-end.
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

test("ROOT CAUSE REGRESSION: the done-state label no longer presents inserted_count (this run's own delta) as if it were the total inventory count", () => {
  assert.doesNotMatch(viewSource, /Inventory now at \$\{largeScaleJob\.inserted_count/);
  assert.match(viewSource, /This run added \$\{largeScaleJob\.inserted_count\.toLocaleString\(\)\} new listing/);
});

test("the done-state card shows the real current total inventory (inventoryStats.totalInventory), not just this run's delta", () => {
  const doneBlock = viewSource.slice(
    viewSource.indexOf('largeScalePhase === "done" && largeScaleJob'),
    viewSource.indexOf('largeScalePhase === "done" && largeScaleJob') + 2200,
  );
  assert.match(doneBlock, /inventoryStats\.totalInventory\.toLocaleString\(\)/);
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
  const fnBody = inventoryDashboardSource.slice(
    inventoryDashboardSource.indexOf("export async function getInventoryIntelligenceStats"),
  );
  assert.match(fnBody, /adminSupabase\.from\("listings"\)\.select\("id", \{ count: "exact", head: true \}\)\.in\("status", \["active", "flagged"\]\)/);
});
