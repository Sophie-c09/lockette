// Run with: npx tsx --test src/lib/disliked-styles.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractDislikedStyleSignals,
  mergeDislikedStyleSignals,
  assessListingAgainstDislikedStyles,
  DISLIKE_DECAY_DAYS,
  type DislikedStyles,
} from "./disliked-styles";

const DAY_MS = 24 * 60 * 60 * 1000;

test("extracts the worked example from this feature's own spec: 'low rise jeans grunge' -> ['low rise', 'grunge']", () => {
  const signals = extractDislikedStyleSignals({
    aesthetic_tags: ["#Grunge"],
    title: "Low Rise Jeans Grunge Style",
  });

  assert.ok(signals.includes("low rise"), `expected 'low rise' in ${JSON.stringify(signals)}`);
  assert.ok(signals.includes("grunge"), `expected 'grunge' in ${JSON.stringify(signals)}`);
});

test("aesthetic_tags are normalized (lowercase, '#' stripped)", () => {
  const signals = extractDislikedStyleSignals({ aesthetic_tags: ["#Y2K", "#Cottagecore"], title: "Plain top" });
  assert.deepEqual(new Set(signals), new Set(["y2k", "cottagecore"]));
});

test("no false positive on unrelated titles", () => {
  const signals = extractDislikedStyleSignals({ aesthetic_tags: [], title: "Plain cotton t-shirt" });
  assert.deepEqual(signals, []);
});

test("mergeDislikedStyleSignals: a brand-new signal starts at count 1", () => {
  const merged = mergeDislikedStyleSignals({}, ["grunge"], "2026-01-01T00:00:00.000Z");
  assert.deepEqual(merged, { grunge: { count: 1, last_seen: "2026-01-01T00:00:00.000Z" } });
});

test("mergeDislikedStyleSignals: an existing signal increments count and bumps last_seen", () => {
  const existing: DislikedStyles = { grunge: { count: 2, last_seen: "2025-01-01T00:00:00.000Z" } };
  const merged = mergeDislikedStyleSignals(existing, ["#Grunge"], "2026-01-01T00:00:00.000Z");
  assert.deepEqual(merged.grunge, { count: 3, last_seen: "2026-01-01T00:00:00.000Z" });
});

test("mergeDislikedStyleSignals: untouched signals are left completely alone", () => {
  const existing: DislikedStyles = {
    grunge: { count: 5, last_seen: "2020-01-01T00:00:00.000Z" },
    "low rise": { count: 1, last_seen: "2020-01-01T00:00:00.000Z" },
  };
  const merged = mergeDislikedStyleSignals(existing, ["grunge"], "2026-01-01T00:00:00.000Z");
  assert.deepEqual(merged["low rise"], { count: 1, last_seen: "2020-01-01T00:00:00.000Z" });
});

test("assess: no overlap at all -> not excluded, zero penalty", () => {
  const result = assessListingAgainstDislikedStyles(["#Y2K"], {}, Date.now());
  assert.deepEqual(result, { excluded: false, penalty: 0 });
});

test("assess: count 1, fresh -> -10", () => {
  const now = Date.parse("2026-01-15T00:00:00.000Z");
  const disliked: DislikedStyles = { grunge: { count: 1, last_seen: "2026-01-14T00:00:00.000Z" } };
  const result = assessListingAgainstDislikedStyles(["#Grunge"], disliked, now);
  assert.deepEqual(result, { excluded: false, penalty: 10 });
});

test("assess: count 2-3, fresh -> -20", () => {
  const now = Date.parse("2026-01-15T00:00:00.000Z");
  for (const count of [2, 3]) {
    const disliked: DislikedStyles = { grunge: { count, last_seen: "2026-01-14T00:00:00.000Z" } };
    const result = assessListingAgainstDislikedStyles(["#Grunge"], disliked, now);
    assert.deepEqual(result, { excluded: false, penalty: 20 }, `count=${count}`);
  }
});

test("assess: count >= 4, fresh -> excluded", () => {
  const now = Date.parse("2026-01-15T00:00:00.000Z");
  const disliked: DislikedStyles = { grunge: { count: 4, last_seen: "2026-01-14T00:00:00.000Z" } };
  const result = assessListingAgainstDislikedStyles(["#Grunge"], disliked, now);
  assert.equal(result.excluded, true);
});

test(`assess: decay — last_seen more than ${DISLIKE_DECAY_DAYS} days ago halves the penalty`, () => {
  const now = Date.parse("2026-02-01T00:00:00.000Z");
  const staleLastSeen = new Date(now - (DISLIKE_DECAY_DAYS + 1) * DAY_MS).toISOString();

  const singleStale: DislikedStyles = { grunge: { count: 1, last_seen: staleLastSeen } };
  assert.deepEqual(assessListingAgainstDislikedStyles(["#Grunge"], singleStale, now), {
    excluded: false,
    penalty: 5, // 10 * 0.5
  });

  const repeatedStale: DislikedStyles = { grunge: { count: 3, last_seen: staleLastSeen } };
  assert.deepEqual(assessListingAgainstDislikedStyles(["#Grunge"], repeatedStale, now), {
    excluded: false,
    penalty: 10, // 20 * 0.5
  });
});

test("assess: a stale count>=4 signal is NOT hard-excluded — it decays into a large but finite penalty instead ('doesn't get permanently locked')", () => {
  const now = Date.parse("2026-02-01T00:00:00.000Z");
  const staleLastSeen = new Date(now - (DISLIKE_DECAY_DAYS + 1) * DAY_MS).toISOString();
  const disliked: DislikedStyles = { grunge: { count: 10, last_seen: staleLastSeen } };

  const result = assessListingAgainstDislikedStyles(["#Grunge"], disliked, now);
  assert.equal(result.excluded, false);
  assert.equal(result.penalty, 50); // 100 * 0.5
});

test("assess: exactly at the decay boundary is still fresh (not stale)", () => {
  const now = Date.parse("2026-02-01T00:00:00.000Z");
  const exactlyAtBoundary = new Date(now - DISLIKE_DECAY_DAYS * DAY_MS).toISOString();
  const disliked: DislikedStyles = { grunge: { count: 1, last_seen: exactlyAtBoundary } };

  const result = assessListingAgainstDislikedStyles(["#Grunge"], disliked, now);
  assert.equal(result.penalty, 10); // not yet decayed
});

test("assess: multiple matching tags sum their penalties", () => {
  const now = Date.parse("2026-01-15T00:00:00.000Z");
  const disliked: DislikedStyles = {
    grunge: { count: 1, last_seen: "2026-01-14T00:00:00.000Z" }, // -10
    y2k: { count: 2, last_seen: "2026-01-14T00:00:00.000Z" }, // -20
  };
  const result = assessListingAgainstDislikedStyles(["#Grunge", "#Y2K"], disliked, now);
  assert.deepEqual(result, { excluded: false, penalty: 30 });
});

test("assess: duplicate tags on the same listing only count once", () => {
  const now = Date.parse("2026-01-15T00:00:00.000Z");
  const disliked: DislikedStyles = { grunge: { count: 1, last_seen: "2026-01-14T00:00:00.000Z" } };
  const result = assessListingAgainstDislikedStyles(["#Grunge", "#grunge", "#Grunge"], disliked, now);
  assert.deepEqual(result, { excluded: false, penalty: 10 });
});
