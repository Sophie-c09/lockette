// Covers the pre-launch polish fix (item 1) — Match now applies the same
// staged recommendation strategy Discover already uses (discover-feed.ts):
// below a meaningful-interaction threshold, rank by fashionQualityScore
// instead of a flat, meaningless personalization score. Source-level
// assertions — fetchMatchBatch needs a real Supabase session to exercise
// end-to-end, which this project avoids depending on in its unit suite.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(join(__dirname, "..", "src", "lib", "match-feed.ts"), "utf-8");

test("fetchMatchBatch computes a cold-start flag from likes+passes and onboarding brand/style signal", () => {
  assert.match(source, /MIN_INTERACTIONS_FOR_PERSONALIZATION\s*=\s*3/);
  assert.match(source, /interactionSignalCount\s*=\s*likedIds\.length \+ dislikedIds\.length/);
  assert.match(source, /hasOnboardingSignal\s*=\s*favoriteBrands\.length > 0 \|\| stylePreferences\.length > 0/);
});

test("cold-start listings are re-ranked by fashionQualityScore, descending", () => {
  const coldStartBlock = source.slice(source.indexOf("if (!isColdStart)"));
  assert.match(coldStartBlock, /computeFashionQualityScore/);
  assert.match(coldStartBlock, /\.sort\(\(a, b\) => b\.fashionQuality\.score - a\.fashionQuality\.score\)/);
});

test("cold-start matchPercent is substituted with the normalized quality score, not left as the flat personalization value", () => {
  const coldStartBlock = source.slice(source.indexOf("if (!isColdStart)"));
  assert.match(coldStartBlock, /matchPercent:\s*normalizeMatchPercentForDisplay\(fashionQuality\.score\)/);
});

test("the deterministic fallback is used (no dependency on quality_score/inventory_quality_score columns existing)", () => {
  const coldStartBlock = source.slice(source.indexOf("if (!isColdStart)"));
  assert.match(coldStartBlock, /qualityScore:\s*null/);
  assert.match(coldStartBlock, /inventoryQualityScore:\s*null/);
});
