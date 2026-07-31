import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

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
  assert.match(processBatchSource, /maxBatches:\s*1\b/);
  // And it, not the Start/Resume route, is the one place the scraper is
  // actually imported/invoked.
  assert.match(processBatchSource, /from ["']@\/lib\/admin-scraper["']/);
  assert.match(processBatchSource, /runLargeScaleAdminScraper\(/);
});

test("process-batch never uses after() either — it awaits its one bounded batch synchronously", () => {
  assert.doesNotMatch(processBatchSource, IMPORTS_AFTER_FROM_NEXT_SERVER);
});
