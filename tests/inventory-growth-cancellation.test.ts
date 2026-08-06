// Covers the Inventory Growth concurrency/cancellation fix — the
// confirmed blocker: a process-batch request could hit its outer watchdog
// timeout, return, and release its batch lease while the underlying
// discovery/extraction promise kept executing in the background. That
// leaked execution later wrote job progress using a stale snapshot,
// racing with (and sometimes clobbering) newer state — confirmed live in
// the prior task: inserted_count/scraped_count kept climbing and
// current_round reverted from 1 back to 0 minutes after the HTTP response
// had already returned.
//
// Source-level assertions, same convention as scraper-jobs-completed-at.test.ts
// and inventory-growth-zero-progress-watchdog.test.ts — real cancellation
// timing and real concurrent requests need a live Playwright/Supabase
// environment to exercise end-to-end, which this project avoids depending
// on in an automated test. See this task's own final report for the live
// proof run (before/response/2-minutes-after snapshots).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const adminScraperSource = readFileSync(join(__dirname, "..", "src", "lib", "admin-scraper.ts"), "utf-8");
const scaledDiscoverySource = readFileSync(join(__dirname, "..", "src", "lib", "inventory", "scaled-discovery.ts"), "utf-8");
const urlQueueSource = readFileSync(join(__dirname, "..", "src", "lib", "inventory", "url-queue.ts"), "utf-8");
const scraperJobsSource = readFileSync(join(__dirname, "..", "src", "lib", "scraper-jobs.ts"), "utf-8");
const processBatchRouteSource = readFileSync(
  join(__dirname, "..", "src", "app", "api", "admin-scraper", "large-scale", "process-batch", "route.ts"),
  "utf-8",
);
// Render-worker migration — the one-bounded-batch pipeline itself (totals,
// current_round, zero-progress detection, the lease-guarded progress
// write, buildInterimProgressPayload, the final status/response shape)
// was extracted out of process-batch/route.ts into this shared module so
// both that route AND src/workers/inventory-growth-worker.ts invoke the
// exact same implementation (see batch-unit.ts's own header comment) —
// every assertion below that used to read processBatchRouteSource for
// this logic now reads batchUnitSource instead.
const batchUnitSource = readFileSync(join(__dirname, "..", "src", "lib", "inventory", "batch-unit.ts"), "utf-8");
const concurrencySource = readFileSync(join(__dirname, "..", "src", "lib", "concurrency.ts"), "utf-8");
const listingExtractionSource = readFileSync(join(__dirname, "..", "src", "lib", "listing-extraction.ts"), "utf-8");
const htmlExtractorSource = readFileSync(join(__dirname, "..", "src", "lib", "extraction", "html-extractor.ts"), "utf-8");
const browserExtractorSource = readFileSync(join(__dirname, "..", "src", "lib", "extraction", "browser-extractor.ts"), "utf-8");

function slice(source: string, marker: string, length = 3000): string {
  const start = source.indexOf(marker);
  assert.ok(start > -1, `expected to find marker: ${marker}`);
  return source.slice(start, start + length);
}

// --- 1. Abort signal reaches discovery -------------------------------------

test("abort signal reaches discovery: discoverListingUrlsAtScale threads signal into every crawlPlatform call", () => {
  const fnBody = slice(scaledDiscoverySource, "export async function discoverListingUrlsAtScale", 2200);
  assert.match(fnBody, /signal\?: AbortSignal/);
  assert.match(fnBody, /crawlPlatform\(source, excludeUrls, sharedFound, targetCount, maxPagesPerQuery, concurrencyOverride, onUrlsFound, signal\)/);
});

test("abort signal reaches discovery: crawlPlatform stops launching new attempts and never acquires a new browser after abort", () => {
  const fnBody = slice(scaledDiscoverySource, "async function crawlPlatform", 3500);
  assert.match(fnBody, /if \(signal\?\.aborted\) return;/);
  const acquireBody = slice(scaledDiscoverySource, "aborted before acquiring a browser", 200);
  assert.ok(acquireBody.length > 0);
});

test("abort signal reaches discovery: an in-flight page/context is closed immediately via an abort listener, not left to finish on its own", () => {
  const fnBody = slice(scaledDiscoverySource, "const onAbort = () => {", 300);
  assert.match(fnBody, /pageHandle\?\.close\(\)/);
  assert.match(fnBody, /context\?\.close\(\)/);
  assert.match(fnBody, /signal\?\.addEventListener\("abort", onAbort/);
});

// --- 2. Abort signal reaches extraction -------------------------------------

test("abort signal reaches extraction: extractWithTimeout threads signal into extractListingFromUrl", () => {
  const fnBody = slice(adminScraperSource, "async function extractWithTimeout", 600);
  assert.match(fnBody, /signal\?: AbortSignal/);
  assert.match(fnBody, /extractListingFromUrl\(url, signal\)/);
});

test("abort signal reaches extraction: extractListingFromUrl short-circuits with a classified BatchAbortedError when already aborted", () => {
  const fnBody = slice(listingExtractionSource, "export async function extractListingFromUrl", 1200);
  assert.match(fnBody, /signal\?: AbortSignal/);
  assert.match(fnBody, /if \(signal\?\.aborted\) \{\s*throw new BatchAbortedError/);
});

test("abort signal reaches extraction: runBrowserExtraction closes its page/context on abort via a listener, not by waiting for page.goto to finish", () => {
  const fnBody = slice(browserExtractorSource, "export async function runBrowserExtraction", 1400);
  assert.match(fnBody, /const onAbort = \(\) => \{/);
  assert.match(fnBody, /page\?\.close\(\)/);
  assert.match(fnBody, /context\?\.close\(\)/);
});

test("abort signal reaches extraction: fetchHtml composes the caller's signal with its own internal timeout via AbortSignal.any", () => {
  const fnBody = slice(htmlExtractorSource, "export async function fetchHtml", 800);
  assert.match(fnBody, /signal\?: AbortSignal/);
  assert.match(fnBody, /AbortSignal\.any\(\[timeoutController\.signal, signal\]\)/);
});

// --- 3. Abortable delay exits early ------------------------------------------

test("abortable delay exits early: abortableDelay rejects immediately (or already-aborted) rather than always waiting out the full ms", () => {
  const fnBody = slice(concurrencySource, "export function abortableDelay", 700);
  assert.match(fnBody, /if \(signal\?\.aborted\) \{\s*reject\(/);
  assert.match(fnBody, /signal\?\.addEventListener\(\s*"abort"/);
});

test("abortable delay exits early: waitForRateLimit and the crawlPlatform recovery backoff both use abortableDelay, not a bare setTimeout", () => {
  const rateLimitBody = slice(scaledDiscoverySource, "async function waitForRateLimit", 500);
  assert.match(rateLimitBody, /abortableDelay\(wait, signal\)/);
  const recoveryBody = slice(scaledDiscoverySource, "RECOVERY_WAIT_MS, signal", 100);
  assert.ok(recoveryBody.length > 0);
});

test("abortable delay exits early: drainQueue's empty-claim poll delay is abortable, so it doesn't wait out a full second after abort", () => {
  const fnBody = slice(adminScraperSource, "export async function drainQueue", 2000);
  assert.match(fnBody, /abortableDelay\(opts\.pollDelayMs \?\? 1_000, opts\.signal\)/);
});

// --- 4. No new work starts after abort ---------------------------------------

test("no new work starts after abort: the round loop in runAdminScraper stops BEFORE starting a new round, not mid-round", () => {
  const fnBody = slice(adminScraperSource, "while (totalImported < options.limit)", 700);
  assert.match(fnBody, /if \(signal\?\.aborted\) \{/);
  assert.match(fnBody, /stopReason = "aborted";/);
});

test("no new work starts after abort: drainQueue never claims a new batch once aborted", () => {
  const fnBody = slice(adminScraperSource, "export async function drainQueue", 900);
  assert.match(fnBody, /if \(opts\.signal\?\.aborted\) \{\s*console\.log\("\[admin-scraper\] drainQueue — aborted, no further claims\."\);\s*break;/);
});

// --- 5. Claimed rows released safely on abort --------------------------------

test("claimed rows released safely on abort: releaseClaimedUrl exists, scoped to the exact row id AND status = 'claimed'", () => {
  const fnBody = slice(urlQueueSource, "export async function releaseClaimedUrl", 500);
  assert.match(fnBody, /\.update\(\{ status: "pending" \}\)/);
  assert.match(fnBody, /\.eq\("id", id\)/);
  assert.match(fnBody, /\.eq\("status", "claimed"\)/);
});

test("claimed rows released safely on abort: drainQueue calls onAborted (not onFailure) for an item skipped or interrupted by abort", () => {
  const fnBody = slice(adminScraperSource, "export async function drainQueue", 2500);
  assert.match(fnBody, /await opts\.onAborted\?\.\(item\);\s*throw new BatchAbortedError\("Skipped/);
  assert.match(fnBody, /if \(error instanceof BatchAbortedError \|\| opts\.signal\?\.aborted\) \{\s*await opts\.onAborted\?\.\(item\);/);
});

test("claimed rows released safely on abort: runQueueDrivenExtraction wires onAborted to releaseClaimedUrl, not markUrlFailed", () => {
  const fnBody = slice(adminScraperSource, "onAborted: (row) => {", 300);
  assert.match(fnBody, /releaseClaimedUrl\(row\.id\)/);
});

// --- 6. Abort does not increment permanent-failure attempts ------------------

test("abort does not increment permanent-failure attempts: an aborted discovery attempt skips recordDiscoveryRun and recordDiscoveryAttempt entirely", () => {
  const fnBody = slice(scaledDiscoverySource, "wasAborted = abortedThisAttempt", 2500);
  assert.match(fnBody, /wasAborted = abortedThisAttempt \|\| error instanceof BatchAbortedError \|\| Boolean\(signal\?\.aborted\);/);
  assert.match(fnBody, /if \(!wasAborted\) \{\s*pagesSearched\+\+;/);
});

test("abort does not increment permanent-failure attempts: releaseClaimedUrl never touches attempt_count, unlike markUrlFailed", () => {
  const fnBody = slice(urlQueueSource, "export async function releaseClaimedUrl", 500);
  assert.doesNotMatch(fnBody, /attempt_count/);
});

// --- 7. Stale lease cannot write progress / cannot release current owner ----

test("stale lease cannot write progress: updateLargeScaleScraperJobProgress chains batch_lease_id and reports applied:false on a zero-row match", () => {
  const fnBody = slice(scraperJobsSource, "export async function updateLargeScaleScraperJobProgress", 6000);
  assert.match(fnBody, /if \(leaseId\) query = query\.eq\("batch_lease_id", leaseId\);/);
  assert.match(fnBody, /stale = true;/);
  assert.match(fnBody, /return \{ applied: false \};/);
});

test("stale lease cannot write progress: completeScraperJob and failScraperJob both accept an optional leaseId and guard their update the same way", () => {
  const completeBody = slice(scraperJobsSource, "export async function completeScraperJob", 2000);
  assert.match(completeBody, /leaseId\?: string/);
  assert.match(completeBody, /if \(leaseId\) query1 = query1\.eq\("batch_lease_id", leaseId\);/);

  const failBody = slice(scraperJobsSource, "export async function failScraperJob", 2000);
  assert.match(failBody, /leaseId\?: string/);
  assert.match(failBody, /if \(leaseId\) query1 = query1\.eq\("batch_lease_id", leaseId\);/);
});

test("stale lease cannot release current owner's lease: releaseBatchLease is (and remains) guarded by leaseId, not just jobId", () => {
  const fnBody = slice(scraperJobsSource, "export async function releaseBatchLease", 500);
  assert.match(fnBody, /\.eq\("batch_lease_id", leaseId\)/);
});

test("non-batch callers (run/route.ts's Style-Aware Scraper) keep working unguarded — leaseId is optional, omitting it preserves old behavior", () => {
  const runRouteSource = readFileSync(
    join(__dirname, "..", "src", "app", "api", "admin-scraper", "run", "route.ts"),
    "utf-8",
  );
  assert.doesNotMatch(runRouteSource, /leaseId/);
});

// --- 8. Monotonic counters / stale checkpoint cannot overwrite newer --------

test("monotonic counters: batch-unit.ts always computes new totals as job.X + thisCall'sDelta (additive), never overwriting with a smaller absolute value", () => {
  const fnBody = slice(batchUnitSource, "const insertedCount = job.inserted_count", 1400);
  assert.match(fnBody, /const insertedCount = job\.inserted_count \+ result\.totalImported;/);
  assert.match(fnBody, /const queriesCompleted = \(job\.queries_completed \?\? 0\) \+ result\.totalQueriesCompleted;/);
});

test("monotonic counters: current_round only advances when this attempt's cancellation is confirmed — an unconfirmed attempt cannot move it at all", () => {
  const fnBody = slice(batchUnitSource, "const currentRound =", 200);
  assert.match(fnBody, /result\.cancellationConfirmed \? result\.batchesRun : 0/);
});

test("stale checkpoint cannot overwrite newer: the lease guard covers the SAME update as current_round/checkpoint — one guarded write, not a separate unguarded checkpoint path", () => {
  const fnBody = slice(batchUnitSource, "const progressWrite = await updateLargeScaleScraperJobProgress(", 1200);
  assert.match(fnBody, /leaseId,/);
  assert.match(fnBody, /if \(!progressWrite\.applied\) \{/);
});

// --- 9. Timed-out batch does not increment current_round / advance status ---

test("timed-out batch does not increment current_round: zero-progress detection itself requires cancellationConfirmed", () => {
  const fnBody = slice(batchUnitSource, "const thisCallMadeZeroProgress =", 500);
  assert.match(fnBody, /result\.cancellationConfirmed &&/);
});

test("timed-out batch does not advance status: an unconfirmed cancellation never reaches the completed/failed/paused status transitions", () => {
  const fnBody = slice(batchUnitSource, "if (result.cancellationConfirmed) {", 700);
  assert.match(fnBody, /if \(result\.stopReason === "paused"\)/);
  assert.match(fnBody, /completeScraperJob\(jobId, insertedCount, leaseId\)/);
});

test("timed-out batch response is truthfully labeled — not silently reported as ordinary 'running' progress", () => {
  const fnBody = slice(batchUnitSource, "return {\n    jobId,\n    status,", 1200);
  assert.match(fnBody, /warning:/);
  assert.match(fnBody, /cancellation could not be confirmed/);
});

// --- 10. Partial committed work remains counted ------------------------------

test("partial committed work remains counted: the interim onProgress write persists insertedCount/scrapedCount mid-attempt, independent of whether the attempt later times out", () => {
  const fnBody = slice(batchUnitSource, "onProgress: async (progress) => {", 700);
  assert.match(fnBody, /buildInterimProgressPayload\(job, progress\)/);
  assert.match(fnBody, /leaseId,/);
});

test("partial committed work remains counted: buildInterimProgressPayload is purely additive against the fixed pre-attempt job snapshot", () => {
  const fnBody = slice(batchUnitSource, "function buildInterimProgressPayload", 900);
  assert.match(fnBody, /insertedCount: baseJob\.inserted_count \+ progress\.insertedCount/);
});

// --- 11. Second batch cannot overlap a leaked first execution ---------------

test("second batch cannot overlap a leaked first execution: claimBatchLease only succeeds when there is no lease or the existing one is expired", () => {
  const fnBody = slice(scraperJobsSource, "export async function claimBatchLease", 1200);
  assert.match(fnBody, /batch_lease_id\.is\.null,batch_lease_expires_at\.lt\.\$\{nowIso\}/);
});

test("second batch cannot overlap a leaked first execution: an unconfirmed cancellation holds the lease instead of releasing it, so claimBatchLease keeps rejecting new calls until natural expiry", () => {
  const fnBody = slice(processBatchRouteSource, "let releaseLease = true;", 700);
  assert.match(fnBody, /shouldReleaseLease/);
  assert.match(fnBody, /if \(releaseLease\) \{/);
});

// --- 12. Browsers/slots are released -----------------------------------------

test("browsers/slots are released: crawlPlatform's finally block always releases the discovery slot and closes page/context regardless of abort", () => {
  const fnBody = slice(scaledDiscoverySource, '} finally {\n        signal?.removeEventListener("abort", onAbort);', 1200);
  assert.match(fnBody, /releaseDiscoverySlot\(\);/);
  assert.match(fnBody, /if \(pageHandle\) \{/);
  assert.match(fnBody, /if \(context\) await context\.close\(\);/);
});

test("browsers/slots are released: runBrowserExtraction's finally always closes the browser and removes the abort listener", () => {
  const fnBody = slice(browserExtractorSource, "} finally {", 400);
  assert.match(fnBody, /signal\?\.removeEventListener\("abort", onAbort\);/);
});

test("browsers/slots are released: the watchdog force-closes all tracked browsers only when cancellation could not be confirmed within the grace period", () => {
  const fnBody = slice(adminScraperSource, "async function withBatchWatchdog", 5000);
  assert.match(fnBody, /await forceCloseAllTrackedBrowsers\(/);
});

// --- 13. Abort is surfaced, not swallowed ------------------------------------

test("abort is surfaced, not swallowed: withBatchWatchdog returns cancellationConfirmed distinctly from a normal result, and logs which case occurred", () => {
  const fnBody = slice(adminScraperSource, "async function withBatchWatchdog", 6000);
  assert.match(fnBody, /cancellationConfirmed: true/);
  assert.match(fnBody, /cancellationConfirmed: false/);
  assert.match(fnBody, /abort did NOT take effect within/);
});

test("abort is surfaced, not swallowed: fetchHtml logs an aborted fetch distinctly from a genuine fetch failure", () => {
  const fnBody = slice(htmlExtractorSource, "} catch (error) {", 700);
  assert.match(fnBody, /Fetch cancelled for \$\{url\} \(batch aborted\)/);
  assert.doesNotMatch(fnBody, /^\s*debugLog\(`Fetch threw for \$\{url\}: \$\{reason\}`\);\s*return null;\s*\}\s*finally/);
});

test("abort is surfaced, not swallowed: runBrowserExtraction logs a cancelled attempt distinctly from a genuine Playwright failure", () => {
  const fnBody = slice(browserExtractorSource, "} catch (error) {", 700);
  assert.match(fnBody, /Browser extraction cancelled for \$\{url\} \(batch aborted\)/);
});

// --- 14. Process-batch finally cleanup always runs --------------------------

test("process-batch finally cleanup always runs: the outer POST handler's try/finally always evaluates lease release, success or failure", () => {
  const fnBody = slice(processBatchRouteSource, "let releaseLease = true;", 700);
  assert.match(fnBody, /\} finally \{\s*if \(releaseLease\) \{/);
});
