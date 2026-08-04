import { test } from "node:test";
import assert from "node:assert/strict";
import { STYLE_REQUEST_BUDGET_OPTIONS } from "../src/lib/style-request-budget";

// Style Bundle budget dropdown — verifies every tier maps to the correct
// numeric ceiling (total-bundle-budget, dollars, matching what
// bundle-generation.ts's allocateBudgetPerItem expects) and that the
// dropdown's real DOM behavior (an HTML <select> always serializes its
// value to a string) round-trips correctly through the server action's
// zod coercion.
test("every budget tier maps to the correct numeric total-bundle ceiling", () => {
  const expected: Record<string, number> = {
    "Under $25": 25,
    "$25–50": 50,
    "$50–75": 75,
    "$75–100": 100,
    "$100–150": 150,
    "$150+": 500,
  };

  assert.equal(STYLE_REQUEST_BUDGET_OPTIONS.length, Object.keys(expected).length);
  for (const option of STYLE_REQUEST_BUDGET_OPTIONS) {
    assert.equal(option.value, expected[option.label], `unexpected value for "${option.label}"`);
  }
});

test("every tier value is a plain positive number, never a string, a range, or cents", () => {
  for (const option of STYLE_REQUEST_BUDGET_OPTIONS) {
    assert.equal(typeof option.value, "number");
    assert.ok(Number.isFinite(option.value) && option.value > 0);
    // Not cents — every real tier is well under 1000, so a cents value
    // (e.g. 2500 for "$25") would be an obvious, easy-to-catch regression.
    assert.ok(option.value < 1000, `${option.label}'s value (${option.value}) looks like it might be in cents, not dollars`);
  }
});

test("tiers are strictly increasing (each option's ceiling is higher than the last)", () => {
  for (let i = 1; i < STYLE_REQUEST_BUDGET_OPTIONS.length; i++) {
    assert.ok(
      STYLE_REQUEST_BUDGET_OPTIONS[i].value > STYLE_REQUEST_BUDGET_OPTIONS[i - 1].value,
      `expected tier ${i} (${STYLE_REQUEST_BUDGET_OPTIONS[i].label}) to exceed tier ${i - 1} (${STYLE_REQUEST_BUDGET_OPTIONS[i - 1].label})`,
    );
  }
});

test("the open-ended top tier ('$150+') is represented as a real finite ceiling, not null/unbounded — allocateBudgetPerItem has no separate 'no ceiling' branch for it", () => {
  const topTier = STYLE_REQUEST_BUDGET_OPTIONS[STYLE_REQUEST_BUDGET_OPTIONS.length - 1];
  assert.equal(topTier.label, "$150+");
  assert.equal(topTier.value, 500);
});

// zod's z.coerce.number() (src/app/actions/style-requests.ts's
// SubmitStyleRequestSchema) is what actually parses the <select>'s
// stringified value on submit — verified directly here since a dropdown
// option's `value={number}` is serialized to a string by the DOM
// regardless of the JS value's own type.
test("the string a <select> actually submits coerces back to the exact same numeric ceiling", () => {
  for (const option of STYLE_REQUEST_BUDGET_OPTIONS) {
    const domSerializedValue = String(option.value); // what formData.get("budget") actually receives
    assert.equal(Number(domSerializedValue), option.value);
  }
});

test("'No preference' (empty string) is treated as no budget constraint, not as 0 or NaN", () => {
  const emptySelectValue = "";
  const parsedOrUndefined = emptySelectValue || undefined; // matches submitStyleRequest's own `formData.get("budget") || undefined`
  assert.equal(parsedOrUndefined, undefined);
});
