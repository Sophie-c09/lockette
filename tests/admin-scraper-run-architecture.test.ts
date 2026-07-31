import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Regression guard for "Continuous Import returns HTML instead of JSON":
// /api/admin-scraper/run/route.ts had no outer try/catch, so any
// synchronous throw before the response was sent (auth check,
// isCurrentUserAdmin's own DB query, or createScraperJob's
// createAdminClient() throwing when SUPABASE_SERVICE_ROLE_KEY isn't
// loaded — a real, previously-documented failure mode) propagated as an
// uncaught exception, which Next.js/Vercel renders as a generic HTML
// error page instead of this route's own JSON — exactly what the
// frontend's `response.json()` call then throws
// "Unexpected token '<'..." on. A behavioral test can't easily force
// every one of those throw sites without mocking half the module graph;
// reading the route's own source (same convention as
// tests/inventory-growth-architecture.test.ts) is what actually verifies
// "this handler cannot exit without a Response" — the real guarantee the
// fix depends on.
const __dirname = dirname(fileURLToPath(import.meta.url));
const routeSource = readFileSync(join(__dirname, "../src/app/api/admin-scraper/run/route.ts"), "utf-8");
const importListingViewSource = readFileSync(join(__dirname, "../src/components/admin/ImportListingView.tsx"), "utf-8");

test("the whole POST handler body is wrapped in a single try/catch that returns NextResponse.json from the catch block", () => {
  const postStart = routeSource.indexOf("export async function POST(");
  assert.notEqual(postStart, -1, "expected to find the POST handler");
  const postBody = routeSource.slice(postStart);

  const tryIndex = postBody.indexOf("try {");
  assert.notEqual(tryIndex, -1, "expected an outer try block in POST");

  const catchIndex = postBody.indexOf("} catch (error) {", tryIndex);
  assert.notEqual(catchIndex, -1, "expected a matching outer catch block");

  const catchBody = postBody.slice(catchIndex);
  assert.match(catchBody, /return sanitizedErrorResponse\(/, "expected the catch block to return a JSON response, not rethrow or fall through");
});

test("every early-return in the route uses NextResponse.json, never a redirect or a bare Response", () => {
  assert.doesNotMatch(routeSource, /return NextResponse\.redirect/);
  // Every `return` inside the handler is either NextResponse.json(...) or
  // the sanitized-error helper (which itself returns NextResponse.json).
  const returns = [...routeSource.matchAll(/^\s*return (\w[\w.]*)\(/gm)].map((m) => m[1]);
  const disallowed = returns.filter((fn) => fn !== "NextResponse.json" && fn !== "sanitizedErrorResponse");
  assert.deepEqual(disallowed, [], `expected only NextResponse.json/sanitizedErrorResponse returns, found: ${disallowed.join(", ")}`);
});

test("the Style-Aware Scraper and Continuous Import handlers never call response.json() directly — both go through parseApiResponse", () => {
  const handlerNames = ["handleRunStyleAwareScrape", "handleRunContinuousImport"];
  for (const name of handlerNames) {
    const start = importListingViewSource.indexOf(`async function ${name}(`);
    assert.notEqual(start, -1, `expected to find ${name} in ImportListingView.tsx`);
    const end = importListingViewSource.indexOf("\n  }", start);
    const body = importListingViewSource.slice(start, end);

    assert.doesNotMatch(body, /await response\.json\(\)/, `expected ${name} not to call response.json() directly`);
    assert.match(body, /await parseApiResponse/, `expected ${name} to parse the response via parseApiResponse`);
  }
});

// Regression guard for "Continuous Import failed" displaying as
// "Inventory Growth failed" instead — a real, reported mismatch distinct
// from whatever caused the underlying failure. Each handler must pass ITS
// OWN feature name, not share one hardcoded label.
test("each admin-scraper handler passes its own feature label to parseApiResponse — no shared/hardcoded prefix", () => {
  const expectedLabels: Record<string, string> = {
    handleRunStyleAwareScrape: "Style-Aware Scraper",
    handleRunContinuousImport: "Continuous Import",
    handleStartLargeScale: "Inventory Growth",
    handleResumeLargeScale: "Inventory Growth",
  };

  for (const [name, label] of Object.entries(expectedLabels)) {
    const start = importListingViewSource.indexOf(`async function ${name}(`);
    assert.notEqual(start, -1, `expected to find ${name} in ImportListingView.tsx`);
    const end = importListingViewSource.indexOf("\n  }", start);
    const body = importListingViewSource.slice(start, end);

    assert.match(
      body,
      new RegExp(`parseApiResponse[^(]*\\([^)]*["']${label}["']`),
      `expected ${name} to pass "${label}" as parseApiResponse's featureLabel`,
    );
  }
});

// Regression guard for the second, deeper root cause: a try/catch INSIDE
// POST() cannot catch a failure in this file's own top-level `import`
// statements (those are evaluated when the module loads, before any of
// this function's code runs). "@/lib/admin-scraper" transitively imports
// Playwright (confirmed via `npx madge` against this exact route) — only
// a dynamic import, evaluated INSIDE the try block, gives this route's
// own error handling a chance to catch a failure to load that module at
// all, not just a failure once it's already loaded and running.
test("runContinuousAdminScraper is imported dynamically, inside the try block — never as a static top-level import", () => {
  assert.doesNotMatch(
    routeSource,
    /^import\s*{[^}]*runContinuousAdminScraper[^}]*}\s*from\s*["']@\/lib\/admin-scraper["']/m,
    "expected no static value import of runContinuousAdminScraper from @/lib/admin-scraper",
  );
  assert.match(
    routeSource,
    /const\s*{\s*runContinuousAdminScraper\s*}\s*=\s*await\s*import\(["']@\/lib\/admin-scraper["']\)/,
    "expected a dynamic import of runContinuousAdminScraper inside the handler",
  );

  const tryIndex = routeSource.indexOf("try {");
  // The specific, real code line (quoted import path and all) — not a
  // bare "await import(" substring match, which this file's own header
  // comment discussing the fix in prose (`await import(...)`, with a
  // literal ellipsis, no quoted path) would false-positive on, appearing
  // earlier in the file than the real try block.
  const dynamicImportIndex = routeSource.indexOf('await import("@/lib/admin-scraper")');
  assert.ok(tryIndex !== -1 && dynamicImportIndex > tryIndex, "expected the dynamic import to sit inside the outer try block");

  // The type (compile-time only, never a runtime import/require call) is
  // still fine as a plain static import — only the VALUE import needed to
  // move.
  assert.match(routeSource, /import type\s*{\s*AdminScraperOptions\s*}\s*from\s*["']@\/lib\/admin-scraper["']/);
});

test("a job created before the dynamic import throws is marked failed, not left orphaned at its initial status", () => {
  const postStart = routeSource.indexOf("export async function POST(");
  const postBody = routeSource.slice(postStart);

  assert.match(postBody, /let createdJobId: string \| null = null/, "expected createdJobId to be tracked");
  assert.match(postBody, /createdJobId = job\.id/, "expected createdJobId to be set once the job is created");

  const catchIndex = postBody.indexOf("} catch (error) {", postBody.indexOf("try {"));
  const catchBody = postBody.slice(catchIndex);
  assert.match(catchBody, /if \(createdJobId\)/, "expected the outer catch to check createdJobId");
  assert.match(catchBody, /failScraperJob\(createdJobId, message\)/, "expected the outer catch to mark the job failed");
});
