// Covers the P0 first-60-seconds fix (item 6) — match percentages shown
// to users must never read below 25%, never a bare single digit, and a
// near-perfect raw score should still land in the "90s" (never a literal
// boastful 100%). Deliberately a display-only transform — see
// match-percent-display.ts's own header comment for why this is NOT
// applied inside scoreListingMatch/scoreGarmentStyleMatch themselves.
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeMatchPercentForDisplay } from "@/lib/match-percent-display";

test("a raw score of 0 never displays below 25%", () => {
  assert.equal(normalizeMatchPercentForDisplay(0), 25);
});

test("a raw score of 100 lands in the 90s, never a literal 100%", () => {
  const result = normalizeMatchPercentForDisplay(100);
  assert.ok(result >= 90 && result <= 99, `expected 90-99, got ${result}`);
});

test("a high raw score (88+) stays in the 90s", () => {
  const result = normalizeMatchPercentForDisplay(90);
  assert.ok(result >= 90, `expected a 90s match, got ${result}`);
});

test("a weak-but-real raw score lands around 30-50%, not near-zero", () => {
  const low = normalizeMatchPercentForDisplay(10);
  const mid = normalizeMatchPercentForDisplay(30);
  assert.ok(low >= 25 && low <= 40, `expected ~25-40, got ${low}`);
  assert.ok(mid >= 30 && mid <= 50, `expected ~30-50, got ${mid}`);
});

test("never displays a single-digit percentage for any raw input 0-100", () => {
  for (let raw = 0; raw <= 100; raw += 1) {
    const displayed = normalizeMatchPercentForDisplay(raw);
    assert.ok(displayed >= 10, `raw=${raw} produced single-digit displayed=${displayed}`);
  }
});

test("is monotonic — a higher raw score never displays lower than a lower one", () => {
  let previous = -1;
  for (let raw = 0; raw <= 100; raw += 5) {
    const displayed = normalizeMatchPercentForDisplay(raw);
    assert.ok(displayed >= previous, `raw=${raw} displayed=${displayed} regressed below previous=${previous}`);
    previous = displayed;
  }
});

test("out-of-range raw inputs are clamped before normalizing, never producing an out-of-range display", () => {
  assert.equal(normalizeMatchPercentForDisplay(-50), 25);
  assert.equal(normalizeMatchPercentForDisplay(500), 99);
});
