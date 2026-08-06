// Covers the false-zero-progress-failure fix — a real, confirmed-live
// incident: job c7ee9dcd-5a0a-4ad9-b357-a35739b38d25 committed
// valid_count 25 / duplicate_count 1 / rejected_count 324 (real listings
// genuinely inserted) but was still failed with "3 consecutive batches
// produced no discovery/extraction progress." Root cause: batch-unit.ts's
// old predicate trusted ONLY the per-call in-memory result.totalX values,
// but admin-scraper.ts's withBatchWatchdog can return a hardcoded
// zeroResult() (every total forced to 0) even after this SAME attempt's
// own interim onProgress callback already committed real progress to the
// database — so a unit that had already inserted real listings could
// still be misclassified as "zero progress."
//
// Source-level assertions, same convention as the other Inventory Growth
// test files — real Postgres/Playwright/watchdog-timing is needed to
// exercise this end to end, which this project avoids depending on in an
// automated test. See this task's own final report for the live recovery
// + re-run proof against the real failed job.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const batchUnitSource = readFileSync(join(__dirname, "..", "src", "lib", "inventory", "batch-unit.ts"), "utf-8");
const scraperJobsSource = readFileSync(join(__dirname, "..", "src", "lib", "scraper-jobs.ts"), "utf-8");
const recoverRouteSource = readFileSync(
  join(__dirname, "..", "src", "app", "api", "admin-scraper", "large-scale", "recover-zero-progress", "route.ts"),
  "utf-8",
);
const adminScraperSource = readFileSync(join(__dirname, "..", "src", "lib", "admin-scraper.ts"), "utf-8");
const scraperConfigSource = readFileSync(join(__dirname, "..", "src", "lib", "scraper-config.ts"), "utf-8");

function slice(source: string, marker: string, length = 2000): string {
  const start = source.indexOf(marker);
  assert.ok(start > -1, `expected to find marker: ${marker}`);
  return source.slice(start, start + length);
}

test("root cause confirmed: withBatchWatchdog can return a hardcoded zeroResult() even for a genuinely-settled (cancellationConfirmed: true) attempt", () => {
  const body = slice(adminScraperSource, "if (settled) {", 700);
  assert.match(body, /return \{ \.\.\.zeroResult\(/);
  assert.match(body, /cancellationConfirmed: true/);
});

test("the productive-progress predicate re-reads the live job row instead of trusting result.totalX alone", () => {
  const body = slice(batchUnitSource, "const latestPersisted = await getScraperJobRow(jobId);", 600);
  assert.match(body, /function committed\(base: number, delta: number, latest: number \| null \| undefined\)/);
  assert.match(body, /Math\.max\(base \+ delta, latest \?\? 0\)/);
});

test("inserted delta means productive", () => {
  const body = slice(batchUnitSource, "const progressedThisUnit =", 700);
  assert.match(body, /insertedCount > job\.inserted_count/);
});

test("valid delta means productive", () => {
  const body = slice(batchUnitSource, "const progressedThisUnit =", 700);
  assert.match(body, /validCount > \(job\.valid_count \?\? 0\)/);
});

test("duplicate delta means productive", () => {
  const body = slice(batchUnitSource, "const progressedThisUnit =", 700);
  assert.match(body, /duplicateCount > \(job\.duplicate_count \?\? 0\)/);
});

test("rejected delta means productive", () => {
  const body = slice(batchUnitSource, "const progressedThisUnit =", 700);
  assert.match(body, /rejectedCount > \(job\.rejected_count \?\? 0\)/);
});

test("discovery-only delta (queries/pages/unique URLs, with zero inserts) means productive", () => {
  const body = slice(batchUnitSource, "const progressedThisUnit =", 700);
  for (const field of ["queriesCompleted > (job.queries_completed ?? 0)", "pagesSearched > (job.pages_searched ?? 0)", "uniqueUrlsDiscovered > (job.unique_urls_discovered ?? 0)"]) {
    assert.ok(body.includes(field), `expected productive-progress check to include: ${field}`);
  }
});

// Final Inventory Growth stabilization pass — the 3-consecutive-batch
// counter (thisCallMadeZeroProgress/zeroProgressStreak/
// ZERO_PROGRESS_BATCH_THRESHOLD) was itself REPLACED by a time-based
// stall model (isStalled/msSinceProductiveProgress/
// INVENTORY_STALL_THRESHOLD_MS) — see batch-unit.ts's own header comment
// on why "3 batch CALLS" stopped being a meaningful unit once a single
// worker unit can legitimately run for many minutes. The tests below
// cover the NEW model; still-relevant coverage from the old model
// (productive-progress delta detection, lease-guarding) is unchanged and
// covered separately above.

test("a still-unwinding (cancellation NOT confirmed) unit neither increments nor resets the diagnostic streak, and cannot be judged stalled yet", () => {
  const streakBody = slice(batchUnitSource, "const consecutiveZeroProgressBatches = !result.cancellationConfirmed", 300);
  assert.match(streakBody, /\? \(previousCheckpoint\.consecutiveZeroProgressBatches \?\? 0\)\s*\n\s*: progressedThisUnit/);
  const stalledBody = slice(batchUnitSource, "const isStalled =", 300);
  assert.match(stalledBody, /result\.cancellationConfirmed &&/);
});

test("a settled unit with real committed progress is never judged stalled, even if result.totalX itself was zeroed by a late watchdog settle", () => {
  const body = slice(batchUnitSource, "const isStalled =", 300);
  assert.match(body, /!progressedThisUnit &&/);
});

test("a truly settled zero-work unit only becomes stalled once no productive event has landed for INVENTORY_STALL_THRESHOLD_MS — not merely 3 calls (real failure detection is preserved, just time-based)", () => {
  const body = slice(batchUnitSource, "const isStalled =", 300);
  assert.match(body, /result\.cancellationConfirmed &&\s*\n\s*result\.stopReason === "max_batches_reached" &&\s*\n\s*!progressedThisUnit &&\s*\n\s*msSinceProductiveProgress >= INVENTORY_STALL_THRESHOLD_MS/);
});

test("three (or any number of) genuine zero-work units still eventually fail the job once the stall threshold elapses (the watchdog is not disabled, only re-timed)", () => {
  assert.match(scraperConfigSource, /export const INVENTORY_STALL_THRESHOLD_MS = Number\(process\.env\.INVENTORY_STALL_THRESHOLD_MS\) \|\| 25 \* 60 \* 1000;/);
  const body = slice(batchUnitSource, "if (isStalled) {\n    const queueStats", 800);
  assert.match(body, /await failScraperJob\(jobId, reason, leaseId\)/);
});

test("the final progress write persists both the diagnostic streak and lastProductiveProgressAt/currentStage, remains lease-guarded", () => {
  const body = slice(batchUnitSource, "const progressWrite = await updateLargeScaleScraperJobProgress(", 1100);
  assert.match(body, /leaseId,/);
  assert.match(body, /consecutiveZeroProgressBatches,/);
  assert.match(body, /lastProductiveProgressAt,/);
  assert.match(body, /currentStage:/);
});

test("a stale lease (superseded execution) cannot reset or fail the job — the write is refused entirely, not retried unguarded", () => {
  const body = slice(batchUnitSource, "if (!progressWrite.applied) {", 400);
  assert.match(body, /shouldReleaseLease: false/);
  assert.doesNotMatch(body, /failScraperJob/);
});

test("no separate/duplicate watchdog implementation exists for external worker mode — batch-unit.ts is the single shared predicate for both process-batch/route.ts and the worker", () => {
  const workerSource = readFileSync(join(__dirname, "..", "src", "workers", "inventory-growth-worker.ts"), "utf-8");
  assert.doesNotMatch(workerSource, /thisCallMadeZeroProgress/);
  assert.doesNotMatch(workerSource, /ZERO_PROGRESS_BATCH_THRESHOLD/);
  assert.match(workerSource, /runBatchUnit\(/);
});

test("resumeFalselyFailedZeroProgressJob only ever resumes a job whose error_message matches the exact zero-progress wording", () => {
  const fnBody = slice(scraperJobsSource, "export async function resumeFalselyFailedZeroProgressJob", 2600);
  assert.match(fnBody, /existing\.status !== "failed"/);
  assert.match(fnBody, /!existing\.error_message\.includes\(ZERO_PROGRESS_ERROR_SIGNATURE\)/);
  assert.match(fnBody, /\.eq\("status", "failed"\)/);
});

test("resumeFalselyFailedZeroProgressJob preserves prior counters and checkpoint seenUrls/options — never touches inserted_count/valid_count or already-inserted listings", () => {
  // "const richPayload = {" also appears in claimJobForResume above this
  // function — anchor on the ZERO_PROGRESS_ERROR_SIGNATURE constant just
  // above resumeFalselyFailedZeroProgressJob's own body to land on the
  // right one.
  const fnBody = slice(scraperJobsSource, "const ZERO_PROGRESS_ERROR_SIGNATURE =", 2200);
  assert.doesNotMatch(fnBody, /inserted_count/);
  assert.doesNotMatch(fnBody, /valid_count/);
  assert.match(fnBody, /seenUrls: existingCheckpoint\.seenUrls \?\? \[\]/);
  assert.match(fnBody, /consecutiveZeroProgressBatches: 0/);
});

test("resumeFalselyFailedZeroProgressJob clears the lease fields so the next claim acquires a genuinely fresh lease", () => {
  // "const richPayload = {" also appears in claimJobForResume above this
  // function — anchor on the ZERO_PROGRESS_ERROR_SIGNATURE constant just
  // above resumeFalselyFailedZeroProgressJob's own body to land on the
  // right one.
  const fnBody = slice(scraperJobsSource, "const ZERO_PROGRESS_ERROR_SIGNATURE =", 2200);
  assert.match(fnBody, /batch_lease_id: null/);
  assert.match(fnBody, /batch_lease_expires_at: null/);
});

test("the recovery route is admin-gated and refuses a job that doesn't match the false-failure signature", () => {
  assert.match(recoverRouteSource, /isCurrentUserAdmin/);
  assert.match(recoverRouteSource, /resumeFalselyFailedZeroProgressJob\(jobId\)/);
  assert.match(recoverRouteSource, /if \(!resumed\) \{/);
});
