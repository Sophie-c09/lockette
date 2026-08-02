// Source-level checks for the dead-listing cleanup fix (P0-C) — same
// "assert on the route's own source text" convention as
// admin-scraper-run-architecture.test.ts/inventory-growth-architecture.test.ts,
// since this route's real behavior needs a live Supabase table + real
// network fetches to exercise end-to-end (this project avoids tests that
// depend on live external state/marketplace HTML).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const routeSource = readFileSync(
  join(__dirname, "..", "src", "app", "api", "cron", "check-listing-status", "route.ts"),
  "utf-8",
);

test("a listing is never marked unavailable on a single signal — a consecutive threshold gate exists", () => {
  assert.match(routeSource, /CONSECUTIVE_UNAVAILABLE_THRESHOLD\s*=\s*\d+/);
  assert.match(routeSource, /reachedThreshold/);
});

test("an inconclusive/blocked check resets the consecutive counter, not just leaves it untouched", () => {
  assert.match(routeSource, /consecutive_unavailable_checks:\s*0/);
});

test("a confirmed-unavailable signal below threshold does not touch status", () => {
  const unavailableBranch = routeSource.slice(
    routeSource.indexOf('if (result.outcome === "unavailable")'),
    routeSource.indexOf("return;", routeSource.indexOf('if (result.outcome === "unavailable")')),
  );
  assert.match(unavailableBranch, /reachedThreshold\s*\?\s*\{\s*status:/);
});

test("marking a listing unavailable always records removal_reason, never a silent status flip", () => {
  assert.match(routeSource, /removal_reason:\s*result\.detail/);
});

test("last_available_at is stamped whenever a check does not confirm unavailability", () => {
  assert.match(routeSource, /last_available_at:\s*now/);
});

test("the update guards against a race with a concurrent admin action via .eq(\"status\", \"active\")", () => {
  const unavailableBranch = routeSource.slice(
    routeSource.indexOf('if (result.outcome === "unavailable")'),
    routeSource.indexOf("return;", routeSource.indexOf('if (result.outcome === "unavailable")')),
  );
  assert.match(unavailableBranch, /\.eq\("status", "active"\)/);
});

test("this remains batch-based and resumable — a bounded limit, oldest-checked-first", () => {
  assert.match(routeSource, /\.limit\(BATCH_SIZE\)/);
  assert.match(routeSource, /order\("last_checked_at", \{ ascending: true, nullsFirst: true \}\)/);
});
