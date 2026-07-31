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
