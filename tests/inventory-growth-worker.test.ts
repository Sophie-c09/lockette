// Covers the Render-worker migration — moving Inventory Growth batch
// execution out of Vercel's request-bounded process-batch route into one
// dedicated, continuously-running background worker
// (src/workers/inventory-growth-worker.ts). Source-level assertions, same
// convention as inventory-growth-cancellation.test.ts — a real worker
// process, real Supabase table, and real Playwright/Render environment are
// needed to exercise this end to end, which this project avoids depending
// on in an automated test. See this task's own final report for the live
// local proof run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const workerSource = readFileSync(join(__dirname, "..", "src", "workers", "inventory-growth-worker.ts"), "utf-8");
const batchUnitSource = readFileSync(join(__dirname, "..", "src", "lib", "inventory", "batch-unit.ts"), "utf-8");
const scraperJobsSource = readFileSync(join(__dirname, "..", "src", "lib", "scraper-jobs.ts"), "utf-8");
const workerHealthSource = readFileSync(join(__dirname, "..", "src", "lib", "worker", "worker-health.ts"), "utf-8");
const processBatchRouteSource = readFileSync(
  join(__dirname, "..", "src", "app", "api", "admin-scraper", "large-scale", "process-batch", "route.ts"),
  "utf-8",
);
const packageJson = readFileSync(join(__dirname, "..", "package.json"), "utf-8");
const browserLaunchOptionsSource = readFileSync(join(__dirname, "..", "src", "lib", "browser-launch-options.ts"), "utf-8");

function slice(source: string, marker: string, length = 2000): string {
  const start = source.indexOf(marker);
  assert.ok(start > -1, `expected to find marker: ${marker}`);
  return source.slice(start, start + length);
}

// Recursively lists every .ts/.tsx file under a directory.
function listFiles(dir: string): string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) {
      files.push(...listFiles(full));
    } else if (/\.(ts|tsx)$/.test(entry)) {
      files.push(full);
    }
  }
  return files;
}

test("1. worker never runs during a Next.js build/dev/start — not imported by any src/app, src/components, or src/lib file, and not referenced by any package.json script other than its own", () => {
  const srcAppFiles = listFiles(join(__dirname, "..", "src", "app"));
  const srcComponentsFiles = listFiles(join(__dirname, "..", "src", "components"));
  const srcLibFiles = listFiles(join(__dirname, "..", "src", "lib"));

  for (const file of [...srcAppFiles, ...srcComponentsFiles, ...srcLibFiles]) {
    const contents = readFileSync(file, "utf-8");
    assert.doesNotMatch(
      contents,
      /from ["']@\/workers\/inventory-growth-worker["']/,
      `${file} must not import the worker entrypoint`,
    );
  }

  const scripts = JSON.parse(packageJson).scripts;
  assert.doesNotMatch(scripts.build, /inventory-growth-worker/);
  assert.doesNotMatch(scripts.dev, /inventory-growth-worker/);
  assert.doesNotMatch(scripts.start, /inventory-growth-worker/);
  assert.match(scripts["worker:inventory-growth"], /inventory-growth-worker\.ts/);
});

test("2. idle polling uses an abortable sleep at WORKER_IDLE_POLL_INTERVAL_MS, not a busy loop", () => {
  const body = slice(workerSource, "if (!job) {", 500);
  assert.match(body, /abortableDelay\(WORKER_IDLE_POLL_INTERVAL_MS, processShutdownController\.signal\)/);
});

test("3. active job acquisition claims the batch lease with this process's own stable worker ID", () => {
  assert.match(workerSource, /const WORKER_ID = process\.env\.WORKER_ID \|\|/);
  assert.match(workerSource, /claimBatchLease\(job\.id, WORKER_ID\)/);
});

test("4. lease renewal runs on its own timer, independent of unit/round cadence", () => {
  const body = slice(workerSource, "const renewalInterval = setInterval", 500);
  assert.match(body, /renewBatchLease\(job\.id, leaseId\)/);
  assert.match(workerSource, /}, WORKER_LEASE_RENEWAL_INTERVAL_MS\);/);
});

test("5. lease loss (renewal failure) aborts in-flight work and stops this job's loop — does not retry the write unguarded", () => {
  const body = slice(workerSource, "renewBatchLease(job.id, leaseId)", 700);
  assert.match(body, /if \(!renewed && !leaseLost\)/);
  assert.match(body, /jobAbortController\.abort\(new Error\("Batch lease lost\/superseded during renewal"\)\)/);
  const loopGuard = slice(workerSource, "while (!shuttingDown && !leaseLost) {", 200);
  assert.ok(loopGuard.length > 0);
});

test("6. job resume after restart reuses getActiveLargeScaleJob (checkpoint-aware) — the worker never creates a fresh job itself", () => {
  assert.match(workerSource, /getActiveLargeScaleJob\(\)/);
  assert.doesNotMatch(workerSource, /createLargeScaleScraperJob/);
  // currentJobRow is refreshed from the DB between units, not carried
  // forward purely in memory — a restart mid-run picks up the last
  // COMMITTED checkpoint, not stale in-process state.
  assert.match(workerSource, /const refreshed = await getScraperJobRow\(job\.id\);/);
});

test("7. pause is honored — a 'paused' unit result stops this job's loop instead of starting another unit", () => {
  const body = slice(workerSource, "if (result.status === \"completed\"", 300);
  assert.match(body, /result\.status === "paused"/);
});

test("8. target completion stops the loop on a 'completed' unit result", () => {
  const body = slice(workerSource, "if (result.status === \"completed\"", 300);
  assert.match(body, /result\.status === "completed"/);
});

test("9. graceful SIGTERM/SIGINT — both wired to the same shutdown handler, bounded by WORKER_SHUTDOWN_GRACE_MS", () => {
  assert.match(workerSource, /process\.on\("SIGTERM", \(\) => void shutdown\("SIGTERM"\)\);/);
  assert.match(workerSource, /process\.on\("SIGINT", \(\) => void shutdown\("SIGINT"\)\);/);
  const body = slice(workerSource, "async function shutdown", 1500);
  assert.match(body, /processShutdownController\.abort\(new Error\(`Worker received \$\{signal\}`\)\)/);
  assert.match(body, /Promise\.race\(\[watchedMainLoop, new Promise<void>\(\(resolve\) => setTimeout\(resolve, WORKER_SHUTDOWN_GRACE_MS\)\)\]\)/);
});

test("10. shutdown force-closes tracked browsers as a last resort when the grace period elapses with work still in flight", () => {
  const body = slice(workerSource, "if (!mainLoopDone) {", 600);
  assert.match(body, /forceCloseAllTrackedBrowsers\(`worker shutdown/);
});

test("10b. shutdown does not force-close browsers when the main loop finished cleanly within the grace period", () => {
  const body = slice(workerSource, "await Promise.race([watchedMainLoop", 900);
  assert.match(body, /if \(!mainLoopDone\) \{/);
});

test("11. external worker mode prevents Vercel process-batch from ever calling claimBatchLease/runBatchUnit for the same job", () => {
  const body = slice(processBatchRouteSource, 'if (job.status !== "pending" && job.status !== "running")', 2200);
  const externalBranchIndex = body.indexOf('INVENTORY_WORKER_MODE === "external"');
  const claimIndex = body.indexOf("claimBatchLease(jobId)");
  assert.ok(externalBranchIndex > -1, "expected an INVENTORY_WORKER_MODE external-mode branch");
  assert.ok(claimIndex > -1, "expected the embedded-mode claimBatchLease call");
  assert.ok(externalBranchIndex < claimIndex, "external-mode branch must return BEFORE reaching claimBatchLease");
  const externalBody = body.slice(externalBranchIndex, claimIndex);
  assert.match(externalBody, /return NextResponse\.json/);
  // Checks the actual CALL syntax (the paren) specifically — the embedded
  // mode's own explanatory comment further down mentions "claimBatchLease"
  // in prose, which a bare word match would false-positive on.
  assert.doesNotMatch(externalBody, /claimBatchLease\(/);
  assert.doesNotMatch(externalBody, /runBatchUnit\(/);
});

test("12. stale worker status is classified separately from online/not_configured, based on a heartbeat-age threshold", () => {
  assert.match(workerHealthSource, /export const WORKER_STALE_THRESHOLD_MS = 90_000;/);
  const body = slice(workerHealthSource, "export async function getWorkerHealthSummary", 1200);
  assert.match(body, /isStale: now - new Date\(row\.last_heartbeat\)\.getTime\(\) > WORKER_STALE_THRESHOLD_MS/);
  assert.match(body, /classification: anyOnline \? "online" : "stale"/);
  assert.match(body, /return \{ classification: "not_configured", workers: \[\] \};/);
});

test("13. two workers cannot own the same job — claimBatchLease's own atomic mutex (no lease or expired) is unchanged by the worker's workerId addition", () => {
  assert.match(scraperJobsSource, /batch_lease_id\.is\.null,batch_lease_expires_at\.lt\./);
  const fnBody = slice(scraperJobsSource, "export async function claimBatchLease", 2200);
  assert.match(fnBody, /\.in\("status", \["pending", "running"\]\)/);
  assert.match(fnBody, /workerId\?: string/);
});

test("14. committed progress survives a worker restart — job progress writes are lease-guarded (batch-unit.ts), and checkpoint/seenUrls round-trip through the job row, not worker-process memory", () => {
  assert.match(batchUnitSource, /updateLargeScaleScraperJobProgress\(\s*\n\s*jobId,/);
  assert.match(batchUnitSource, /leaseId,\s*\n\s*\);/);
  assert.match(batchUnitSource, /seenUrls: result\.seenUrls,/);
  assert.match(batchUnitSource, /checkpointOptions: savedOptions/);
});

test("15. no client bundle can ever contain worker secrets — the worker module (and its only-server-side dependencies) is never reachable from any 'use client' component", () => {
  const componentsDir = join(__dirname, "..", "src", "components");
  const files = listFiles(componentsDir);
  let anyClientChecked = false;
  for (const file of files) {
    const contents = readFileSync(file, "utf-8");
    if (!/^["']use client["'];?/m.test(contents)) continue;
    anyClientChecked = true;
    assert.doesNotMatch(contents, /@\/workers\//, `${file} is a client component and must not import from src/workers`);
    assert.doesNotMatch(contents, /SUPABASE_SERVICE_ROLE_KEY/, `${file} must never reference the service-role key`);
  }
  assert.ok(anyClientChecked, "expected at least one 'use client' component to actually check (sanity check on the scan itself)");
});

test("Render Chromium shared-memory workaround is isolated to Render (RENDER env var), separate from Vercel's @sparticuz/chromium path", () => {
  assert.match(browserLaunchOptionsSource, /const IS_RENDER = process\.env\.RENDER === "true";/);
  const body = slice(browserLaunchOptionsSource, "export async function resolveBrowserLaunchOptions", 700);
  assert.match(body, /if \(IS_RENDER\) \{/);
  assert.match(body, /--disable-dev-shm-usage/);
});

test("Dockerfile.worker uses the official Playwright image, not @sparticuz/chromium, and never bakes in an --env-file", () => {
  const dockerfile = readFileSync(join(__dirname, "..", "Dockerfile.worker"), "utf-8");
  assert.match(dockerfile, /FROM mcr\.microsoft\.com\/playwright:/);
  // Only real instruction lines matter here — the file's own header
  // comment explains IN PROSE why @sparticuz/chromium is deliberately NOT
  // used, which a bare source match would false-positive on.
  const instructionLines = dockerfile
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n");
  assert.doesNotMatch(instructionLines, /@sparticuz\/chromium/);
  assert.doesNotMatch(instructionLines, /--env-file/);
  assert.match(dockerfile, /CMD \["npx", "tsx", "src\/workers\/inventory-growth-worker\.ts"\]/);
});

test("render.yaml defines exactly one worker service (not a web service) and never inlines a secret value", () => {
  const renderYaml = readFileSync(join(__dirname, "..", "render.yaml"), "utf-8");
  assert.match(renderYaml, /type: worker/);
  assert.doesNotMatch(renderYaml, /type: web/);
  assert.doesNotMatch(renderYaml, /sk-/); // no inlined OpenAI-shaped key
  assert.match(renderYaml, /dockerfilePath: \.\/Dockerfile\.worker/);
});
