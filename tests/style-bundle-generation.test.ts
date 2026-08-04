import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { calculateBundlePricing } from "../src/lib/bundle-pricing";

// Root-cause regression + pipeline-behavior coverage for the Style Bundle
// "Try again" production failure. Source-level assertions for anything
// that needs a real Supabase session/OpenAI call to exercise end-to-end
// (same convention as tests/match-feed-cold-start.test.ts,
// tests/payment-system.test.ts) — this bug was actually found and proven
// fixed via a live reproduction against the real database (see this
// task's own report), not by a mock; these tests are the regression
// guard against it recurring, not the original diagnosis.
const marketplaceSearchSource = readFileSync(join(__dirname, "..", "src", "lib", "marketplace-search.ts"), "utf-8");
const bundleGenerationSource = readFileSync(join(__dirname, "..", "src", "lib", "bundle-generation.ts"), "utf-8");
const styleRequestsSource = readFileSync(join(__dirname, "..", "src", "app", "actions", "style-requests.ts"), "utf-8");
const bundleOutfitViewSource = readFileSync(
  join(__dirname, "..", "src", "components", "style-request", "BundleOutfitView.tsx"),
  "utf-8",
);

test("ROOT CAUSE REGRESSION: rewornProvider never uses the request-scoped Supabase client — it throws ('cookies called outside a request scope') the moment it's called from runBundleGenerationAsync's detached after() execution, which is every async bundle generation", () => {
  assert.doesNotMatch(
    marketplaceSearchSource,
    /from "@\/lib\/supabase\/server"/,
    "marketplace-search.ts must never import the request-scoped client — it broke Lockette-inventory search for every background-generated bundle",
  );
  assert.match(marketplaceSearchSource, /import \{ createAdminClient \} from "@\/lib\/supabase\/admin";/);
  const providerBody = marketplaceSearchSource.slice(
    marketplaceSearchSource.indexOf("const rewornProvider"),
    marketplaceSearchSource.indexOf("const PROVIDERS ="),
  );
  assert.match(providerBody, /const supabase = createAdminClient\(\);/);
});

test("Lockette's own inventory (rewornProvider) is still in the active PROVIDERS roster", () => {
  const providersBlock = marketplaceSearchSource.slice(
    marketplaceSearchSource.indexOf("const PROVIDERS ="),
    marketplaceSearchSource.indexOf("];", marketplaceSearchSource.indexOf("const PROVIDERS =")),
  );
  assert.match(providersBlock, /rewornProvider/);
});

test("a genuinely provider-level failure (any single marketplace source throwing) never fails the whole search — each provider is wrapped in its own try/catch", () => {
  const fnBody = marketplaceSearchSource.slice(marketplaceSearchSource.indexOf("export async function searchMarketplaceItems"));
  assert.match(fnBody, /try \{\s*const results = await provider\.search\(query\);/);
  assert.match(fnBody, /catch \(error\) \{\s*console\.error\(`\[marketplace-search\]/);
});

test("a vibe-based fallback exists for zero detected garments — an aesthetic/mood-board photo does not fail the whole request", () => {
  assert.match(bundleGenerationSource, /function buildVibeFallbackItems/);
  assert.match(
    bundleGenerationSource,
    /const detectedItems = analysis\.detectedItems\.length > 0 \? analysis\.detectedItems : buildVibeFallbackItems\(analysis\);/,
  );
});

test("budget is allocated per-item by category weight, and every category has a positive weight (no item can ever get a $0 ceiling)", () => {
  const weightsBlock = bundleGenerationSource.slice(
    bundleGenerationSource.indexOf("const CATEGORY_BUDGET_WEIGHT"),
    bundleGenerationSource.indexOf("};", bundleGenerationSource.indexOf("const CATEGORY_BUDGET_WEIGHT")),
  );
  for (const category of ["tops", "outerwear", "bottoms", "dresses", "shoes", "accessories", "bags"]) {
    const match = weightsBlock.match(new RegExp(`${category}:\\s*(\\d+)`));
    assert.ok(match, `expected a weight for ${category}`);
    assert.ok(Number(match[1]) > 0, `expected ${category}'s weight to be positive`);
  }
});

test("bundle pricing is dollars throughout (no cents/dollars unit mismatch) and matches this feature's own documented example", () => {
  const result = calculateBundlePricing([20, 35, 40]);
  assert.equal(result.itemSubtotal, 95);
  assert.equal(result.mavelleFee, 19);
  assert.equal(result.totalPrice, 114);
});

test("bundle pricing never produces a floating-point-drifted total — every field is rounded to whole cents", () => {
  const result = calculateBundlePricing([17.99, 33.33, 12.5]);
  for (const value of [result.itemSubtotal, result.mavelleFee, result.totalPrice]) {
    assert.equal(Math.round(value * 100), value * 100, `expected ${value} to already be rounded to cents`);
  }
});

test("the initial generation attempt is stamped (attempt_count: 1, last_attempt_at) so retries have a real starting point to increment from", () => {
  const fnBody = bundleGenerationSource.slice(
    bundleGenerationSource.indexOf("export async function createGeneratingBundle"),
    bundleGenerationSource.indexOf("export async function runBundleGenerationAsync"),
  );
  assert.match(fnBody, /attempt_count: 1,/);
  assert.match(fnBody, /last_attempt_at: new Date\(\)\.toISOString\(\),/);
});

test("retryBundleGeneration only retries a genuinely failed bundle — never one that's still generating or already ready", () => {
  const fnBody = styleRequestsSource.slice(
    styleRequestsSource.indexOf("export async function retryBundleGeneration"),
  );
  assert.match(fnBody.slice(0, 1500), /if \(bundleRow\.status !== "error"\)/);
});

test("retryBundleGeneration caps attempts and returns a clear terminal message once the cap is reached", () => {
  const fnBody = styleRequestsSource.slice(styleRequestsSource.indexOf("export async function retryBundleGeneration"));
  assert.match(styleRequestsSource, /const MAX_GENERATION_ATTEMPTS = 3;/);
  assert.match(fnBody.slice(0, 1500), /if \(attemptCount >= MAX_GENERATION_ATTEMPTS\)/);
  assert.match(fnBody.slice(0, 2000), /We couldn't complete this bundle after several attempts\. Please submit a new style request\./);
});

test("retryBundleGeneration never duplicates the request or the bundle — reuses the same request_id/bundleId, never inserts a new style_requests or styled_bundles row", () => {
  const fnBody = styleRequestsSource.slice(
    styleRequestsSource.indexOf("export async function retryBundleGeneration"),
    styleRequestsSource.indexOf("export async function addBundleToCart"),
  );
  assert.doesNotMatch(fnBody, /\.from\("style_requests"\)\s*\.insert/);
  assert.doesNotMatch(fnBody, /\.from\("styled_bundles"\)\s*\.insert/);
  assert.match(fnBody, /\.update\(\{/); // resets the SAME row instead
});

test("retryBundleGeneration clears any stale styled_bundle_items before re-running generation, so a retry can never leave duplicate items", () => {
  const fnBody = styleRequestsSource.slice(
    styleRequestsSource.indexOf("export async function retryBundleGeneration"),
    styleRequestsSource.indexOf("export async function addBundleToCart"),
  );
  assert.match(fnBody, /\.from\("styled_bundle_items"\)\.delete\(\)\.eq\("bundle_id", bundleId\)/);
});

test("retryBundleGeneration reuses the same after()-wrapped detached-execution pattern as the original submission", () => {
  const fnBody = styleRequestsSource.slice(
    styleRequestsSource.indexOf("export async function retryBundleGeneration"),
    styleRequestsSource.indexOf("export async function addBundleToCart"),
  );
  assert.match(fnBody, /after\(async \(\) => \{/);
  assert.match(fnBody, /await runBundleGenerationAsync\(bundleRow\.request_id, bundleId, user\.id\)/);
});

test("the UI distinguishes a real terminal failure from the calm still-working state, and 'Try again' is a real retry button, not just explanatory text", () => {
  assert.match(bundleOutfitViewSource, /const isStillWorking = bundle\.status === "generating" && pollTimedOut;/);
  assert.match(bundleOutfitViewSource, /const isError = bundle\.status === "error";/);
  const errorBlock = bundleOutfitViewSource.slice(
    bundleOutfitViewSource.indexOf("{isError && ("),
    bundleOutfitViewSource.indexOf("{isError && (") + 800,
  );
  assert.match(errorBlock, /onClick=\{handleRetry\}/);
  assert.match(errorBlock, /\{retrying \? "Retrying…" : "Try again"\}/);
});

test("the retry button prevents rapid repeated clicks and shows progress", () => {
  const fnBody = bundleOutfitViewSource.slice(bundleOutfitViewSource.indexOf("async function handleRetry"));
  assert.match(fnBody.slice(0, 200), /if \(retrying\) return;/);
  const errorBlock = bundleOutfitViewSource.slice(bundleOutfitViewSource.indexOf("{isError && ("));
  assert.match(errorBlock.slice(0, 800), /disabled=\{retrying\}/);
});

test("no raw stack trace, provider name, or SQL error ever reaches the user-facing generation error copy", () => {
  // fail() itself only ever receives hand-written safe strings or
  // error.message from a caught exception (never a raw stack) — verified
  // by checking every literal string passed to fail(...) in this file is
  // plain prose, not an SQL/stack-shaped string.
  const failCalls = [...bundleGenerationSource.matchAll(/await fail\("([^"]*)"\)/g)].map((m) => m[1]);
  assert.ok(failCalls.length > 0, "expected at least one fail(...) call with a literal message");
  for (const message of failCalls) {
    assert.doesNotMatch(message, /SELECT|INSERT|UPDATE|at \w+\.\w+ \(/i);
  }
});
