// Covers the P0 launch-readiness fix for two concurrent process-batch
// calls racing on the SAME job (see scraper-jobs.ts's claimBatchLease/
// releaseBatchLease and process-batch/route.ts's own comment). Source-
// level assertions, same convention as inventory-growth-architecture.test.ts
// — claimBatchLease needs a real Supabase table with real concurrent
// requests to exercise the actual race, which this project avoids
// depending on in an automated test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const scraperJobsSource = readFileSync(join(__dirname, "..", "src", "lib", "scraper-jobs.ts"), "utf-8");
const routeSource = readFileSync(
  join(__dirname, "..", "src", "app", "api", "admin-scraper", "large-scale", "process-batch", "route.ts"),
  "utf-8",
);

test("claimBatchLease only succeeds when there is no lease or the existing one has expired", () => {
  assert.match(scraperJobsSource, /export async function claimBatchLease/);
  assert.match(scraperJobsSource, /batch_lease_id\.is\.null,batch_lease_expires_at\.lt\./);
});

test("claimBatchLease is scoped to pending/running jobs only", () => {
  const fnBody = scraperJobsSource.slice(
    scraperJobsSource.indexOf("export async function claimBatchLease"),
    scraperJobsSource.indexOf("export async function releaseBatchLease"),
  );
  assert.match(fnBody, /\.in\("status", \["pending", "running"\]\)/);
});

test("releaseBatchLease is guarded by leaseId, not just jobId — a reclaimed lease can never be cleared by its old owner", () => {
  const fnBody = scraperJobsSource.slice(scraperJobsSource.indexOf("export async function releaseBatchLease"));
  assert.match(fnBody, /\.eq\("batch_lease_id", leaseId\)/);
});

test("process-batch/route.ts claims the lease before running a batch", () => {
  assert.match(routeSource, /claimBatchLease\(jobId\)/);
});

test("process-batch/route.ts's lease release is CONDITIONAL on cancellation being confirmed (concurrency fix) — never an unconditional finally anymore", () => {
  // ROOT CAUSE REGRESSION GUARD: releasing unconditionally in a bare
  // `finally` (the original P0 shape) is exactly what let a leaked,
  // still-running background execution and a brand-new execution both
  // hold a valid lease at overlapping times — see the concurrency fix's
  // own header comment on shouldReleaseLease.
  assert.doesNotMatch(routeSource, /finally\s*\{\s*await releaseBatchLease\(jobId, leaseId\);\s*\}/);
  const finallyBlock = routeSource.slice(routeSource.indexOf("} finally {", routeSource.indexOf("runOneBatch(")));
  assert.match(finallyBlock, /if \(releaseLease\)/);
  assert.match(finallyBlock, /await releaseBatchLease\(jobId, leaseId\);/);
});

test("losing the batch-lease race is treated as 'nothing to do this tick', not an error", () => {
  const claimBlock = routeSource.slice(
    routeSource.indexOf("const { claimed, leaseId }"),
    routeSource.indexOf("let releaseLease = true;"),
  );
  assert.match(claimBlock, /if \(!claimed\)/);
  assert.match(claimBlock, /batchRan: false/);
  assert.doesNotMatch(claimBlock, /status.*500/);
});
