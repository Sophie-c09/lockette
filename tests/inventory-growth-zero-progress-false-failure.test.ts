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

test("a still-unwinding (cancellation NOT confirmed) unit neither increments nor resets the streak", () => {
  const body = slice(batchUnitSource, "const zeroProgressStreak = !result.cancellationConfirmed", 300);
  assert.match(body, /\? previousZeroProgressStreak\s*\n\s*: progressedThisUnit/);
});

test("a settled unit with real committed progress resets the streak to 0, even if result.totalX itself was zeroed by a late watchdog settle", () => {
  const body = slice(batchUnitSource, "const zeroProgressStreak = !result.cancellationConfirmed", 300);
  assert.match(body, /progressedThisUnit\s*\n\s*\? 0/);
});

test("a truly settled zero-work unit still increments the streak (real failure detection is preserved)", () => {
  const body = slice(batchUnitSource, "const zeroProgressStreak = !result.cancellationConfirmed", 300);
  assert.match(body, /: previousZeroProgressStreak \+ 1;/);
  // thisCallMadeZeroProgress still requires a genuinely settled attempt
  // that made no progress AND stopped via max_batches_reached (not
  // paused/target_reached/consecutive_failures, which are handled by
  // their own distinct status transitions).
  const predicateBody = slice(batchUnitSource, "const thisCallMadeZeroProgress =", 300);
  assert.match(predicateBody, /result\.cancellationConfirmed && result\.stopReason === "max_batches_reached" && !progressedThisUnit/);
});

test("three genuine zero-work units still fail the job (the watchdog is not disabled)", () => {
  assert.match(batchUnitSource, /const ZERO_PROGRESS_BATCH_THRESHOLD = 3;/);
  const body = slice(batchUnitSource, "if (zeroProgressStreak >= ZERO_PROGRESS_BATCH_THRESHOLD)", 800);
  assert.match(body, /await failScraperJob\(jobId, reason, leaseId\)/);
});

test("the final progress write (including the zero-progress streak) remains lease-guarded", () => {
  const body = slice(batchUnitSource, "const progressWrite = await updateLargeScaleScraperJobProgress(", 700);
  assert.match(body, /leaseId,/);
  assert.match(body, /consecutiveZeroProgressBatches: zeroProgressStreak/);
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
