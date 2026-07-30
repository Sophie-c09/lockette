import { test } from "node:test";
import assert from "node:assert/strict";
import { calculateServiceFee, calculateCartTotal } from "@/lib/pricing";

const CASES: Array<[price: number, expectedFee: number]> = [
  [20, 2],
  [50, 2.5],
  [100, 5],
  [200, 8],
  [500, 15],
  [1000, 20],
];

for (const [price, expectedFee] of CASES) {
  test(`calculateServiceFee(${price}) === ${expectedFee}`, () => {
    assert.equal(calculateServiceFee(price), expectedFee);
  });
}

test("never exceeds $5 for items under $100", () => {
  for (const price of [1, 25, 25.01, 50, 99.99, 100]) {
    assert.ok(calculateServiceFee(price) <= 5, `price ${price} produced fee > $5`);
  }
});

test("rounds to 2 decimal places", () => {
  assert.equal(calculateServiceFee(33.33), 1.67);
});

test("calculateCartTotal applies the fee once to the combined subtotal, not once per item", () => {
  // $10 + $12 = $22 subtotal -> single $2 minimum-tier fee, not $2 twice.
  const result = calculateCartTotal([{ price: 10 }, { price: 12 }]);
  assert.equal(result.subtotal, 22);
  assert.equal(result.fee, 2);
  assert.equal(result.total, 24);
});

test("calculateCartTotal matches calculateServiceFee for a single-item cart (Buy Now)", () => {
  const result = calculateCartTotal([{ price: 60 }]);
  assert.equal(result.subtotal, 60);
  assert.equal(result.fee, calculateServiceFee(60));
  assert.equal(result.total, 60 + calculateServiceFee(60));
});

test("calculateCartTotal on an empty cart is all zeros", () => {
  const result = calculateCartTotal([]);
  assert.equal(result.subtotal, 0);
  assert.equal(result.fee, 2); // calculateServiceFee(0) is still the $0-$25 flat minimum
  assert.equal(result.total, 2);
});

test("calculateCartTotal crossing a fee tier only charges the higher-tier rate once", () => {
  // Two $15 items ($30 combined subtotal) each sit in the $0-$25 flat-$2
  // tier alone — the old per-item bug would charge $2 + $2 = $4. Priced as
  // one $30 cart, the fee is 5% capped at $5, i.e. $1.50 — this is exactly
  // the "small carts got overcharged" bug the fix addresses.
  const result = calculateCartTotal([{ price: 15 }, { price: 15 }]);
  assert.equal(result.subtotal, 30);
  assert.equal(result.fee, 1.5);
  assert.equal(result.total, 31.5);
});
