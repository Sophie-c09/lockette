// Covers the P0 first-60-seconds fix (item 9) — onboarding's brand picker
// expanded from 8 brands to a real, searchable spread with a minimum-5
// selection requirement.
import { test } from "node:test";
import assert from "node:assert/strict";
import { BRANDS, MIN_BRANDS_REQUIRED } from "@/lib/onboarding-data";

test("BRANDS has between 50 and 100 entries", () => {
  assert.ok(BRANDS.length >= 50, `expected at least 50 brands, found ${BRANDS.length}`);
  assert.ok(BRANDS.length <= 100, `expected at most 100 brands, found ${BRANDS.length}`);
});

test("every brand has a unique id (no duplicate entries)", () => {
  const ids = BRANDS.map((brand) => brand.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("every brand has a non-empty name and a color", () => {
  for (const brand of BRANDS) {
    assert.ok(brand.name.trim().length > 0, `brand ${brand.id} has an empty name`);
    assert.ok(brand.color.trim().length > 0, `brand ${brand.id} has no color`);
  }
});

test("MIN_BRANDS_REQUIRED is 5, matching the feature's own requirement", () => {
  assert.equal(MIN_BRANDS_REQUIRED, 5);
});

test("the brand list is well within reach of the minimum required selection", () => {
  assert.ok(BRANDS.length >= MIN_BRANDS_REQUIRED);
});
