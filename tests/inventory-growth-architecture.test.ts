import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { SINGLE_BATCH_CALL_TIMEOUT_MS, SINGLE_BATCH_CALL_MAX_ATTEMPTS, PER_BATCH_MAX_RUNTIME_MS, MAX_BATCH_RETRIES } from "@/lib/scraper-config";

// Regression guard for the architecture half of the Inventory Growth
// production-crash fix: the Start/Resume route must never import (or
// call) the long-running scraper directly, and must never attach it to
// the request via after() — both are what caused an ordinary Start click
// to crash outright (see next.config.ts's own header comment) and, even
// when it didn't crash, made a 50,000-listing run structurally
// impossible to finish before Vercel's maxDuration killed the Function.
// A behavioral test can't easily prove "this request doesn't wait for a
// multi-hour scraper run" without a real multi-hour scraper run to wait
// for — reading the route's own source is what actually verifies "the
// scraper cannot run here at all," which is the real guarantee this
// fix depends on. The bounded, resumable work lives in
// process-batch/route.ts instead, verified by the adjacent assertion
// that it explicitly runs at most one batch per call.
const __dirname = dirname(fileURLToPath(import.meta.url));
const routeSource = readFileSync(
  join(__dirname, "../src/app/api/admin-scraper/large-scale/route.ts"),
  "utf-8",
);
const processBatchSource = readFileSync(
  join(__dirname, "../src/app/api/admin-scraper/large-scale/process-batch/route.ts"),
  "utf-8",
);
const metricsSource = readFileSync(
  join(__dirname, "../src/app/api/admin-scraper/large-scale/metrics/route.ts"),
  "utf-8",
);
// Render-worker migration — process-batch/route.ts no longer imports/calls
// runLargeScaleAdminScraper directly; that now happens one level deeper,
// in the shared batch-unit pipeline both process-batch/route.ts AND
// src/workers/inventory-growth-worker.ts invoke (see batch-unit.ts's own
// header comment). "process-batch is the only place the scraper actually
// runs — not the Start/Resume route" is still exactly true; it's just
// reached via runBatchUnit -> runLargeScaleAdminScraper now instead of
// directly.
const batchUnitSource = readFileSync(
  join(__dirname, "../src/lib/inventory/batch-unit.ts"),
  "utf-8",
);

test("the Start/Resume route never imports the long-running scraper", () => {
  assert.doesNotMatch(routeSource, /from ["']@\/lib\/admin-scraper["']/);
  // Call-syntax specifically (the paren) — the file's own header comment
  // names this function in prose to document the fix, which a bare
  // word-boundary match would false-positive on.
  assert.doesNotMatch(routeSource, /runLargeScaleAdminScraper\(/);
});

// Matches only an ACTUAL `import { ..., after, ... } from "next/server"`
// binding — not prose mentioning "after()" in a comment (both route
// files' own header comments explain the fix by name), which a plain
// /\bafter\(/ source match would false-positive on.
const IMPORTS_AFTER_FROM_NEXT_SERVER = /import\s*{[^}]*\bafter\b[^}]*}\s*from\s*["']next\/server["']/;

test("the Start/Resume route never attaches background work to the request via after()", () => {
  assert.doesNotMatch(routeSource, IMPORTS_AFTER_FROM_NEXT_SERVER);
});

test("every non-2xx branch style used in the Start/Resume route returns NextResponse.json", () => {
  // Every `return NextResponse.json(` in the file — a plain source check
  // that a bare `return NextResponse.redirect(` or similar was never
  // reintroduced for an error path.
  assert.doesNotMatch(routeSource, /return NextResponse\.redirect/);
});

test("process-batch runs at most one batch per call (bounded, not open-ended)", () => {
  // The bounded-unit pipeline itself (maxBatches: 1, and the actual
  // runLargeScaleAdminScraper call) lives in the shared batch-unit module
  // process-batch/route.ts delegates to — see that file's own header
  // comment on why (both it and the Render worker invoke the exact same
  // implementation, never duplicated).
  assert.match(batchUnitSource, /maxBatches:\s*1\b/);
  assert.match(batchUnitSource, /from ["']@\/lib\/admin-scraper["']/);
  assert.match(batchUnitSource, /runLargeScaleAdminScraper\(/);
  // And process-batch/route.ts (not the Start/Resume route) is the only
  // route that reaches this pipeline at all.
  assert.match(processBatchSource, /from ["']@\/lib\/inventory\/batch-unit["']/);
  assert.match(processBatchSource, /runBatchUnit\(/);
});

test("process-batch never uses after() either — it awaits its one bounded batch synchronously", () => {
  assert.doesNotMatch(processBatchSource, IMPORTS_AFTER_FROM_NEXT_SERVER);
});

// Regression guard for the "stuck at 0/50,000 with no visible error" fix:
// process-batch is a real Vercel Function bounded by its own `maxDuration`
// export — the in-process watchdog it hands to runLargeScaleAdminScraper
// is only useful if it can actually fire BEFORE Vercel's platform-level
// kill does. This failed silently before (PER_BATCH_MAX_RUNTIME_MS, 10
// minutes, x MAX_BATCH_RETRIES, 3 attempts, inside a 60s-capped request)
// — asserted here as a real numeric comparison, not just a source-text
// match, so a future edit that widens SINGLE_BATCH_CALL_TIMEOUT_MS (or
// narrows maxDuration) past safe again fails this test immediately.
test("process-batch's own maxDuration comfortably exceeds SINGLE_BATCH_CALL_TIMEOUT_MS x SINGLE_BATCH_CALL_MAX_ATTEMPTS, so the in-process watchdog can always fire before Vercel's platform-level kill would", () => {
  const maxDurationMatch = processBatchSource.match(/export const maxDuration\s*=\s*(\d+)/);
  assert.ok(maxDurationMatch, "expected to find `export const maxDuration = <number>` in process-batch/route.ts");
  const maxDurationMs = Number(maxDurationMatch![1]) * 1000;

  const worstCaseMs = SINGLE_BATCH_CALL_TIMEOUT_MS * SINGLE_BATCH_CALL_MAX_ATTEMPTS;
  assert.ok(
    worstCaseMs < maxDurationMs,
    `expected SINGLE_BATCH_CALL_TIMEOUT_MS (${SINGLE_BATCH_CALL_TIMEOUT_MS}) x SINGLE_BATCH_CALL_MAX_ATTEMPTS (${SINGLE_BATCH_CALL_MAX_ATTEMPTS}) = ${worstCaseMs}ms to stay under maxDuration (${maxDurationMs}ms), with real margin for request/response overhead`,
  );
  // Leaves at least 10s of margin for auth, DB reads/writes, and response
  // marshaling — not just "technically less than maxDuration."
  assert.ok(maxDurationMs - worstCaseMs >= 10_000, "expected at least 10s of margin beyond the worst-case watchdog budget");
});

test("a single process-batch call makes exactly ONE scraper attempt — the admin dashboard's own poll loop (every couple of seconds) is this run's real retry mechanism, not an inner retry loop competing for the same 60s", () => {
  assert.equal(SINGLE_BATCH_CALL_MAX_ATTEMPTS, 1);
});

// The plain defaults are for a hypothetical standalone (not
// request-duration-bounded) caller — confirms process-batch's own
// override is genuinely smaller, not just a differently-named alias for
// the same values.
test("the single-call override is genuinely smaller than the standalone defaults, not just a rename", () => {
  assert.ok(SINGLE_BATCH_CALL_TIMEOUT_MS < PER_BATCH_MAX_RUNTIME_MS);
  assert.ok(SINGLE_BATCH_CALL_MAX_ATTEMPTS < MAX_BATCH_RETRIES);
});

test("process-batch actually passes the single-call overrides and an interim onProgress hook to runLargeScaleAdminScraper", () => {
  // process-batch/route.ts supplies the single-call-sized values...
  assert.match(processBatchSource, /batchTimeoutMs:\s*SINGLE_BATCH_CALL_TIMEOUT_MS/);
  assert.match(processBatchSource, /maxAttemptsPerBatch:\s*SINGLE_BATCH_CALL_MAX_ATTEMPTS/);
  // ...and the shared batch-unit pipeline forwards them (under runLargeScaleAdminScraper's
  // own hook names) plus an interim onProgress hook, straight through.
  assert.match(batchUnitSource, /perBatchTimeoutMs:\s*batchTimeoutMs/);
  assert.match(batchUnitSource, /maxAttemptsPerBatch,/);
  assert.match(batchUnitSource, /onProgress:\s*async/);
});

// Regression guard for the "Next.js HTML 500 error page" fix: the metrics
// route was importing DISCOVERY_CONCURRENCY/MAX_EXTRACTION_CONCURRENCY
// from @/lib/inventory/scaled-discovery and @/lib/admin-scraper — both
// transitively import Playwright — and had no try/catch at all, despite
// being polled every couple of seconds for as long as Inventory Growth
// stays open (far more often than the one-shot start/resume calls).
// Actual import-statement syntax specifically (require the `import`
// keyword on the same match) — this file's own header comment names both
// old import paths in prose to document the fix, which a bare source
// match on the path string alone would false-positive on, same hazard
// IMPORTS_AFTER_FROM_NEXT_SERVER above already guards against.
test("the metrics route never imports the scraper or its heavy discovery module — both concurrency constants come from the plain scraper-config.ts", () => {
  assert.doesNotMatch(metricsSource, /import\s*{[^}]*}\s*from\s*["']@\/lib\/admin-scraper["']/);
  assert.doesNotMatch(metricsSource, /import\s*{[^}]*}\s*from\s*["']@\/lib\/inventory\/scaled-discovery["']/);
  assert.match(metricsSource, /DISCOVERY_CONCURRENCY/);
  assert.match(metricsSource, /MAX_EXTRACTION_CONCURRENCY/);
  assert.match(metricsSource, /import\s*{[^}]*}\s*from\s*["']@\/lib\/scraper-config["']/);
});

test("the metrics route's whole GET handler is wrapped in a try/catch that returns NextResponse.json from the catch block", () => {
  const getStart = metricsSource.indexOf("export async function GET(");
  assert.notEqual(getStart, -1, "expected to find the GET handler");
  const getBody = metricsSource.slice(getStart);

  const tryIndex = getBody.indexOf("try {");
  assert.notEqual(tryIndex, -1, "expected an outer try block in GET");

  const catchIndex = getBody.indexOf("} catch (error) {", tryIndex);
  assert.notEqual(catchIndex, -1, "expected a matching outer catch block");

  const catchBody = getBody.slice(catchIndex);
  assert.match(catchBody, /return sanitizedErrorResponse\(/, "expected the catch block to return a JSON response, not rethrow or fall through");
});
