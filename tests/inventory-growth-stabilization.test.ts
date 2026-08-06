// Final Inventory Growth stabilization pass — covers everything NOT
// already exercised by the earlier, narrower fix's own test files
// (inventory-growth-worker.test.ts, inventory-growth-zero-progress-*.test.ts):
// job-scoped queue ownership, the 'canceled' status + Cancel control,
// auto-detecting a healthy worker to disable Vercel's embedded path
// without requiring an env var, the shared inventory-count helper, and
// the admin UI always loading the server-authoritative active job.
//
// Source-level assertions, same convention as every other Inventory
// Growth test file in this repo — real Postgres/worker-timing is needed
// to exercise this end to end, which this project avoids depending on in
// an automated test. See this task's own final report for the live
// 30-minute proof.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const urlQueueSource = readFileSync(join(__dirname, "..", "src", "lib", "inventory", "url-queue.ts"), "utf-8");
const scraperJobsSource = readFileSync(join(__dirname, "..", "src", "lib", "scraper-jobs.ts"), "utf-8");
const batchUnitSource = readFileSync(join(__dirname, "..", "src", "lib", "inventory", "batch-unit.ts"), "utf-8");
const adminScraperSource = readFileSync(join(__dirname, "..", "src", "lib", "admin-scraper.ts"), "utf-8");
const processBatchRouteSource = readFileSync(
  join(__dirname, "..", "src", "app", "api", "admin-scraper", "large-scale", "process-batch", "route.ts"),
  "utf-8",
);
const largeScaleRouteSource = readFileSync(
  join(__dirname, "..", "src", "app", "api", "admin-scraper", "large-scale", "route.ts"),
  "utf-8",
);
const cancelRouteSource = readFileSync(
  join(__dirname, "..", "src", "app", "api", "admin-scraper", "large-scale", "cancel", "route.ts"),
  "utf-8",
);
const inventoryCountSource = readFileSync(join(__dirname, "..", "src", "lib", "inventory", "inventory-count.ts"), "utf-8");
const viewSource = readFileSync(join(__dirname, "..", "src", "components", "admin", "ImportListingView.tsx"), "utf-8");
const adminActionsSource = readFileSync(join(__dirname, "..", "src", "app", "actions", "admin-scraper.ts"), "utf-8");
const scraperJobsTypesSource = readFileSync(join(__dirname, "..", "src", "lib", "supabase", "scraper-jobs.types.ts"), "utf-8");

function slice(source: string, marker: string, length = 2000): string {
  const start = source.indexOf(marker);
  assert.ok(start > -1, `expected to find marker: ${marker}`);
  return source.slice(start, start + length);
}

// --- Job-scoped queue -------------------------------------------------------

test("job-scoped queue: claimNextUrls scopes both the SELECT and the claim to job_id when passed, with a missing-column fallback to the original global behavior", () => {
  const fnBody = slice(urlQueueSource, "export async function claimNextUrls", 1600);
  assert.match(fnBody, /if \(withJobId && jobId\) query = query\.eq\("job_id", jobId\);/);
  assert.match(fnBody, /isMissingJobIdColumnError\(selectError\)/);
});

test("job-scoped queue: enqueueUrls stamps job_id on first insert only — a URL re-discovered by a different job while already queued is left alone (ignoreDuplicates)", () => {
  const fnBody = slice(urlQueueSource, "export async function enqueueUrls", 1200);
  assert.match(fnBody, /\.\.\.\(withJobId && jobId \? \{ job_id: jobId \} : \{\}\)/);
  assert.match(fnBody, /ignoreDuplicates: true/);
});

test("job-scoped queue: getUrlQueueStats scopes every status count to job_id when passed, and falls back to the global view if the column is missing", () => {
  const fnBody = slice(urlQueueSource, "export async function getUrlQueueStats", 1400);
  assert.match(fnBody, /if \(withJobId && jobId\) query = query\.eq\("job_id", jobId\);/);
  assert.match(fnBody, /isMissingJobIdColumnError/);
});

test("job-scoped queue: current-job metrics are scoped, not lifetime-global — the dashboard's own metrics route passes jobId through", () => {
  const metricsSource = readFileSync(
    join(__dirname, "..", "src", "app", "api", "admin-scraper", "large-scale", "metrics", "route.ts"),
    "utf-8",
  );
  assert.match(metricsSource, /getUrlQueueStats\(jobId\)/);
});

test("job-scoped queue: batch-unit.ts threads this job's own id into every discovery/extraction call it makes", () => {
  assert.match(batchUnitSource, /jobId,\s*\n\s*\};/);
  assert.match(adminScraperSource, /jobId\?: string;/);
});

test("job-scoped queue: the migration is additive and never deletes/reassigns historical rows", () => {
  const migration = readFileSync(
    join(__dirname, "..", "supabase", "migrations", "20260806000000_add_scraper_url_queue_job_id.sql"),
    "utf-8",
  );
  assert.match(migration, /add column if not exists job_id uuid;/);
  assert.doesNotMatch(migration, /delete from/i);
  assert.doesNotMatch(migration, /update public\.scraper_url_queue/i);
});

// --- Canceled status / Cancel control ---------------------------------------

test("cancelScraperJob tries the real 'canceled' status first, falling back to 'failed' with a distinguishable prefix only on a check-constraint violation", () => {
  const fnBody = slice(scraperJobsSource, "export async function cancelScraperJob", 2600);
  assert.match(fnBody, /status: "canceled" as ScraperJobStatus/);
  assert.match(fnBody, /isCheckConstraintViolation\(error\)/);
  assert.match(fnBody, /CANCELED_BY_ADMIN_PREFIX/);
});

test("cancelScraperJob clears the lease and releases only THIS job's own claimed queue rows — never touches listings or a different job's rows", () => {
  const fnBody = slice(scraperJobsSource, "export async function cancelScraperJob", 3200);
  assert.match(fnBody, /batch_lease_id: null/);
  assert.match(fnBody, /batch_lease_expires_at: null/);
  assert.match(fnBody, /\.eq\("job_id", jobId\)\s*\n\s*\.eq\("status", "claimed"\)/);
  assert.doesNotMatch(fnBody, /from\("listings"\)/);
});

test("cancelScraperJob only acts on a non-terminal job — refuses an already-terminal one instead of silently no-oping", () => {
  const fnBody = slice(scraperJobsSource, "export async function cancelScraperJob", 900);
  assert.match(fnBody, /\.in\("status", \["pending", "queued", "running", "paused"\]\)/);
});

test("the cancel route is admin-gated and requires jobId", () => {
  assert.match(cancelRouteSource, /isCurrentUserAdmin/);
  assert.match(cancelRouteSource, /cancelScraperJob\(jobId\)/);
  assert.match(cancelRouteSource, /MISSING_JOB_ID/);
});

test("the 'canceled' status is a real member of ScraperJobStatus, and the schema migration widens (never narrows) the existing CHECK constraint", () => {
  assert.match(scraperJobsTypesSource, /"canceled"/);
  const migration = readFileSync(
    join(__dirname, "..", "supabase", "migrations", "20260806000100_add_scraper_jobs_canceled_status.sql"),
    "utf-8",
  );
  assert.match(migration, /check \(status in \('pending', 'queued', 'running', 'paused', 'completed', 'failed', 'canceled'\)\);/);
});

test("the admin UI distinguishes a canceled run from a genuine failure, both for the real status and the pre-migration fallback", () => {
  const fnBody = slice(viewSource, "function isLargeScaleJobCanceled", 300);
  assert.match(fnBody, /job\.status === "canceled"/);
  assert.match(fnBody, /startsWith\("Canceled by admin:"\)/);
});

test("the admin UI has a Cancel run control available while running AND while paused", () => {
  assert.match(viewSource, /handleCancelLargeScale/);
  const occurrences = viewSource.split("Cancel run").length - 1;
  assert.ok(occurrences >= 2, `expected at least 2 "Cancel run" UI occurrences (running + paused), found ${occurrences}`);
});

// --- Auto-detect a healthy worker (no env var required) ---------------------

test("process-batch/route.ts auto-defers to a healthy worker even without INVENTORY_WORKER_MODE=external — root-cause fix for a real, deployed worker sitting permanently idle", () => {
  const fnBody = slice(processBatchRouteSource, "const workerHealth = await getWorkerHealthSummary();", 400);
  assert.match(fnBody, /INVENTORY_WORKER_MODE === "external" \|\| workerHealth\.classification === "online"/);
});

// --- Shared inventory-count helper ------------------------------------------

test("getCurrentInventoryCount is the ONE definition of current inventory (active + flagged), and both job-start validation and the worker's own target-reached check use it", () => {
  assert.match(inventoryCountSource, /\.in\("status", \["active", "flagged"\]\)/);
  assert.match(largeScaleRouteSource, /getCurrentInventoryCount/);
  assert.match(adminScraperSource, /getCurrentInventoryCount\(\)/);
});

test("large-scale/route.ts no longer has its own, DIFFERENT (no-status-filter) inventory count query", () => {
  assert.doesNotMatch(largeScaleRouteSource, /\.from\("listings"\)\.select\("id", \{ count: "exact", head: true \}\)\)/);
});

// --- Always-visible active job (server-authoritative, not localStorage) ----

test("getActiveLargeScaleJobStatus is a real admin-gated server action reused by the dashboard's mount effect, independent of localStorage", () => {
  assert.match(adminActionsSource, /export async function getActiveLargeScaleJobStatus/);
  assert.match(adminActionsSource, /getMostRecentNonTerminalLargeScaleJob/);
  const fnBody = slice(viewSource, "async function bootstrapActiveJob", 900);
  assert.match(fnBody, /getActiveLargeScaleJobStatus\(\)/);
  assert.match(fnBody, /window\.localStorage\.setItem\(LARGE_SCALE_JOB_STORAGE_KEY, job\.id\)/);
});

test("getMostRecentNonTerminalLargeScaleJob includes 'paused' (for UI visibility) but is a SEPARATE function from getActiveLargeScaleJob (which must keep excluding 'paused' for the Start-route concurrency guard)", () => {
  const visibilityFn = slice(scraperJobsSource, "export async function getMostRecentNonTerminalLargeScaleJob", 700);
  assert.match(visibilityFn, /\.in\("status", \["pending", "running", "paused"\]\)/);
  const guardFn = slice(scraperJobsSource, "export async function getActiveLargeScaleJob", 700);
  assert.match(guardFn, /\.in\("status", \["pending", "running"\]\)/);
  assert.doesNotMatch(guardFn, /"paused"\]\)/);
});

// --- lastProductiveProgressAt live-proof fix --------------------------------

test("live-proof-confirmed fix: an interim (mid-attempt) progress write also refreshes lastProductiveProgressAt/currentStage when it shows real progress, not only the final per-unit write", () => {
  // Confirmed live: a real attempt's insert phase completed AFTER its own
  // watchdog's final-write comparison point, committing 60 real inserts
  // via an interim write that left lastProductiveProgressAt stuck at its
  // stale pre-attempt value for 10+ minutes — because
  // updateLargeScaleScraperJobProgress only writes the checkpoint column
  // (where lastProductiveProgressAt lives) when seenUrls is present, and
  // interim calls previously never included it.
  const fnBody = slice(batchUnitSource, "function buildInterimProgressPayload", 3300);
  assert.match(fnBody, /const madeProgressSoFarThisAttempt =/);
  assert.match(fnBody, /progress\.insertedCount > 0/);
  assert.match(fnBody, /seenUrls: \(baseJob\.checkpoint as \{ seenUrls\?: string\[\] \} \| null\)\?\.seenUrls \?\? \[\]/);
  assert.match(fnBody, /lastProductiveProgressAt: new Date\(\)\.toISOString\(\)/);
});

// --- No duplicate active jobs / stale lease safety (regression guards) -----

test("stale-job auto-recovery (recoverStaleLargeScaleJob) still runs on every getScraperJobStatus poll, unaffected by this pass", () => {
  assert.match(adminActionsSource, /recoverStaleLargeScaleJob/);
});

test("no new watchdog implementation duplicates the shared one — batch-unit.ts remains the single source for stall detection", () => {
  assert.match(batchUnitSource, /export async function runBatchUnit/);
  const occurrences = (batchUnitSource.match(/const isStalled =/g) ?? []).length;
  assert.equal(occurrences, 1);
});
