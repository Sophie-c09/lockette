// Covers the P0 launch-readiness fix for scraper_url_queue's stale-claim
// race (see url-queue.ts's claimNextUrls, its own comment, and this
// project's audit finding: staleness was measured against `created_at`
// — enqueue time, not claim time — and the claim itself was a SELECT then
// an unconditional UPDATE by id, with no re-check for a concurrent winner).
// Source-level assertions, same convention as admin-scraper-queue.test.ts's
// sibling architecture tests — claimNextUrls needs a real Supabase table
// with genuinely concurrent requests to exercise the actual race.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(join(__dirname, "..", "src", "lib", "inventory", "url-queue.ts"), "utf-8");

test("staleness is measured against claimed_at (claim time), not created_at (enqueue time)", () => {
  assert.match(source, /claimed_at\.lt\.\$\{staleCutoff\}/);
  assert.doesNotMatch(source, /created_at\.lt\.\$\{staleCutoff\}/);
});

test("claimed_at is stamped fresh at the moment of claim, not inherited from row creation", () => {
  const claimFn = source.slice(source.indexOf("export async function claimNextUrls"));
  assert.match(claimFn, /const claimedAt = new Date\(\)\.toISOString\(\)/);
  assert.match(claimFn, /status: "claimed", claimed_at: claimedAt/);
});

test("the claim UPDATE re-applies the pending/stale-claimed filter, not just the ids collected by the earlier SELECT", () => {
  const claimFn = source.slice(source.indexOf("export async function claimNextUrls"));
  // Both the initial SELECT and the actual claiming UPDATE must use the
  // exact same filter string (claimableFilter) — a literal reference, not
  // a second hand-written copy that could silently drift out of sync.
  const orCount = (claimFn.match(/\.or\(claimableFilter\)/g) ?? []).length;
  assert.equal(orCount, 2, "expected claimableFilter to be applied on both the SELECT and the UPDATE");
});

test("only rows the UPDATE actually won (via .select()) are returned to the caller — not the original SELECT's candidates", () => {
  const claimFn = source.slice(source.indexOf("export async function claimNextUrls"));
  assert.match(claimFn, /const \{ data: won, error: updateError \}/);
  assert.match(claimFn, /return wonRows\.map/);
  assert.doesNotMatch(claimFn, /return candidates\.map/);
});
