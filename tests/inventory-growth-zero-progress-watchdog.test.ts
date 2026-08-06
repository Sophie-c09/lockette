// Covers the Inventory Growth "doing no useful work" investigation.
//
// ROOT CAUSE, confirmed live against real production data: a real page
// visit averages ~6.5-7s; COMBINATIONS_PER_CALL (60) and
// QUEUE_EXTRACTION_ROUND_MAX_WAIT_MS (90s) were both sized for a
// standalone, not-request-bounded run — but every large-scale batch now
// ONLY ever runs inside process-batch/route.ts's single bounded call
// (SINGLE_BATCH_CALL_TIMEOUT_MS). A real discovery+extraction round
// therefore could not complete before the outer watchdog fired,
// discarding all of that round's real (in-memory) progress every single
// time. Separately, runLargeScaleAdminScraper sets batchesRun the moment
// it decides to ATTEMPT a batch, before that attempt's own result is
// known — so a batch whose only attempt times out still counts as "one
// batch done" with no error ever recorded, letting current_round grind
// toward maxBatches (100) on zero credited work. Live evidence: a real
// job (b54cbdc5-...) advanced to current_round 24 with
// queries_completed/pages_searched/unique_urls_discovered stuck at 0 the
// entire time.
//
// Source-level assertions, same convention as scraper-jobs-completed-at.test.ts
// — this needs a real Supabase table + real Playwright/browser execution
// to exercise end-to-end, which this project avoids depending on in an
// automated test. See this task's own final report for the live proof run
// (46 scraped, 15 genuinely inserted into listings, confirmed in the
// database).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const adminScraperSource = readFileSync(join(__dirname, "..", "src", "lib", "admin-scraper.ts"), "utf-8");
const scaledDiscoverySource = readFileSync(join(__dirname, "..", "src", "lib", "inventory", "scaled-discovery.ts"), "utf-8");
const urlQueueSource = readFileSync(join(__dirname, "..", "src", "lib", "inventory", "url-queue.ts"), "utf-8");
const processBatchRouteSource = readFileSync(
  join(__dirname, "..", "src", "app", "api", "admin-scraper", "large-scale", "process-batch", "route.ts"),
  "utf-8",
);
// Render-worker migration — the zero-progress-watchdog logic itself
// (thisCallMadeZeroProgress, the consecutive streak, and the failure it
// triggers) was extracted out of process-batch/route.ts into this shared
// module (see batch-unit.ts's own header comment).
const batchUnitSource = readFileSync(join(__dirname, "..", "src", "lib", "inventory", "batch-unit.ts"), "utf-8");
const scraperConfigSource = readFileSync(join(__dirname, "..", "src", "lib", "scraper-config.ts"), "utf-8");
const scraperJobsSource = readFileSync(join(__dirname, "..", "src", "lib", "scraper-jobs.ts"), "utf-8");

function slice(source: string, marker: string, length = 3000): string {
  const start = source.indexOf(marker);
  assert.ok(start > -1, `expected to find marker: ${marker}`);
  return source.slice(start, start + length);
}

test("ROOT CAUSE REGRESSION: COMBINATIONS_PER_CALL is small enough to fit a bounded call's real time budget, not the old standalone-run value", () => {
  assert.match(scaledDiscoverySource, /const COMBINATIONS_PER_CALL = 15;/);
  assert.doesNotMatch(scaledDiscoverySource, /const COMBINATIONS_PER_CALL = 60;/);
});

test("ROOT CAUSE REGRESSION: the per-call batch watchdog leaves real margin under the route's own maxDuration", () => {
  assert.match(scraperConfigSource, /export const SINGLE_BATCH_CALL_TIMEOUT_MS = 50 \* 1000;/);
});

test("ROOT CAUSE REGRESSION: the extraction round's own drain cap fits inside the outer batch watchdog, not far beyond it", () => {
  assert.match(adminScraperSource, /const QUEUE_EXTRACTION_ROUND_MAX_WAIT_MS = 30_000;/);
  assert.doesNotMatch(adminScraperSource, /const QUEUE_EXTRACTION_ROUND_MAX_WAIT_MS = 90_000;/);
});

test("ZERO-PROGRESS WATCHDOG: a batch that produced zero queries/pages/URLs/extraction/valid/duplicate/rejected outcomes is detected as zero-progress", () => {
  const body = slice(batchUnitSource, "const thisCallMadeZeroProgress =", 600);
  for (const field of [
    "result.totalQueriesCompleted === 0",
    "result.totalPagesSearched === 0",
    "result.totalUniqueUrlsDiscovered === 0",
    "result.totalExtractedSuccessfully === 0",
    "result.totalImported === 0",
    "result.totalDuplicates === 0",
    "result.totalRejected === 0",
  ]) {
    assert.ok(body.includes(field), `expected zero-progress check to include: ${field}`);
  }
});

test("ZERO-PROGRESS WATCHDOG: the consecutive-zero-progress streak is tracked in the job's own checkpoint, needing no migration", () => {
  assert.match(batchUnitSource, /previousZeroProgressStreak/);
  assert.match(batchUnitSource, /consecutiveZeroProgressBatches: zeroProgressStreak/);
  const checkpointField = slice(scraperJobsSource, "consecutiveZeroProgressBatches?: number", 100);
  assert.ok(checkpointField.length > 0);
});

test("ZERO-PROGRESS WATCHDOG: after a small consecutive threshold the job fails truthfully instead of continuing toward maxBatches", () => {
  assert.match(batchUnitSource, /const ZERO_PROGRESS_BATCH_THRESHOLD = 3;/);
  const body = slice(batchUnitSource, "if (zeroProgressStreak >= ZERO_PROGRESS_BATCH_THRESHOLD)", 800);
  assert.match(body, /await failScraperJob\(jobId, reason, leaseId\)/);
  assert.match(body, /status: "failed"/);
  assert.doesNotMatch(body, /status: "completed"/);
});

test("ZERO-PROGRESS WATCHDOG: a batch that DID make real progress resets the streak (does not fail a healthy run)", () => {
  const body = slice(batchUnitSource, "const zeroProgressStreak =", 200);
  assert.match(body, /thisCallMadeZeroProgress \? previousZeroProgressStreak \+ 1 : 0/);
});

test("DISCOVERY EXCEPTION SURFACING: the last batch attempt's own failure reason is threaded out through the result, not left only in a server log", () => {
  const resultInterface = slice(adminScraperSource, "export interface LargeScaleAdminScraperResult", 2400);
  assert.match(resultInterface, /lastBatchError: string \| null;/);

  assert.match(adminScraperSource, /lastBatchError = lastError \?\? "Unknown batch failure\.";/);
  assert.match(adminScraperSource, /lastBatchError = null;/);
  assert.match(adminScraperSource, /lastBatchError,\s*\n(.*\n)*?\s*\};/);
});

test("terminal 'failed' rows in scraper_url_queue are never re-claimed — claimableFilter only ever matches pending or stale-claimed", () => {
  const fnBody = slice(urlQueueSource, "export async function claimNextUrls");
  assert.match(fnBody, /status\.eq\.pending,and\(status\.eq\.claimed,claimed_at\.lt\.\$\{staleCutoff\}\)/);
  assert.doesNotMatch(fnBody, /status\.eq\.failed/);
});

test("stale claims (crashed extraction workers) are recovered by claimNextUrls using claimed_at, not created_at", () => {
  assert.match(urlQueueSource, /const STALE_CLAIM_THRESHOLD_MS = 10 \* 60 \* 1000;/);
  const fnBody = slice(urlQueueSource, "export async function claimNextUrls", 1200);
  assert.match(fnBody, /claimed_at\.lt\.\$\{staleCutoff\}/);
});

test("QUEUE METRICS LIMITATION (documented, not fixed this pass): scraper_url_queue has no per-job ownership — getUrlQueueStats and claimNextUrls are necessarily global, not job-scoped", () => {
  // This test documents a real, confirmed-live finding rather than a fix:
  // 974 of the queue's 'failed' rows are dated 2026-07-29/30, days before
  // the job the dashboard attributes them to. Adding job_id ownership
  // would need a migration this investigation's author has no way to
  // apply to production (see the Inventory Growth startup task's own
  // report) — deferred, not silently ignored.
  const fnBody = slice(urlQueueSource, "export async function getUrlQueueStats", 800);
  assert.doesNotMatch(fnBody, /job_id/);
});

test("PROCESS-BATCH LEASE: the lease is only released via finally when cancellation was confirmed (superseded by the concurrency/cancellation fix — see scraper-jobs-batch-lease.test.ts for the current, conditional-release contract)", () => {
  assert.match(processBatchRouteSource, /claimBatchLease\(jobId\)/);
  assert.match(processBatchRouteSource, /if \(releaseLease\) \{\s*await releaseBatchLease\(jobId, leaseId\);/);
});

test("discovery is invoked even when scraper_url_queue is currently empty — crawlPlatform's own picks check has no dependency on existing queue rows", () => {
  const fnBody = slice(scaledDiscoverySource, "async function crawlPlatform", 2200);
  assert.doesNotMatch(fnBody, /getUrlQueueStats\(/);
  assert.match(fnBody, /if \(picks\.length === 0\)/);
});

test("one URL's real path is wired end to end: discovery's onUrlsFound callback enqueues into scraper_url_queue, extraction claims from it", () => {
  assert.match(adminScraperSource, /await enqueueUrls\(/);
  assert.match(urlQueueSource, /export async function enqueueUrls/);
  assert.match(adminScraperSource, /claimNextUrls\(/);
});
