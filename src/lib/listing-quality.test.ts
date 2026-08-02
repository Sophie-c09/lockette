// Tests for the quality-scoring model (src/lib/listing-quality.ts). Uses
// Node's built-in test runner (node:test/node:assert) rather than adding a
// test framework dependency — this project has none configured yet.
//
// Run with: npx tsx --test src/lib/listing-quality.test.ts
//
// No OPENAI_API_KEY is assumed to be set when these run (matching this
// project's actual dev/CI environment) — every case below exercises the
// fail-open path, where imageQuality/productAppeal default to their
// maximum UNLESS the listing has no image at all (see
// scoreListingQuality's own doc comment for why those two cases are
// treated differently). That makes priceValue, fashionRelevance, and
// completeness the only score components that vary between these cases,
// which is exactly what each test below is actually checking.
import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreListingQuality, calculatePriceValueScore, type QualityScoreBreakdown } from "./listing-quality";
import type { ExtractedListing } from "@/lib/extraction/normalize-listing";

function makeListing(overrides: Partial<ExtractedListing> = {}): ExtractedListing {
  return {
    title: "Item",
    description: null,
    price: null,
    image_url: "https://example.com/photo.jpg",
    images: [],
    product_url: "https://example.com/listing",
    platform: "Depop",
    brand: null,
    category: null,
    size: null,
    color: null,
    aesthetic_tags: [],
    source_likes_count: null,
    source_views_count: null,
    source_comments_count: null,
    removal_signal: null,
    ...overrides,
  };
}

function assertValidScore(score: number, breakdown: QualityScoreBreakdown) {
  assert.ok(Number.isInteger(score), `score ${score} should be an integer`);
  assert.ok(score >= 0 && score <= 100, `score ${score} should be within 0-100`);

  const sum =
    breakdown.imageQuality + breakdown.fashionRelevance + breakdown.completeness + breakdown.productAppeal + breakdown.priceValue;
  assert.ok(sum >= 0 && sum <= 100, `breakdown sum ${sum} should be within 0-100`);
}

// The four worked examples from the "rebalance toward affordable thrift
// finds" spec this model was rewritten for — these are the authoritative
// reference points for calculatePriceValueScore's expected behavior now.

test("$5 cute Y2K tank scores a perfect priceValue", () => {
  const result = calculatePriceValueScore(makeListing({ title: "Cute Y2K Tank Top", brand: null, price: 5 }));
  assert.equal(result.score, 10, `expected a perfect priceValue for a $5 thrift find, got ${result.score}`);
});

test("$6 vintage floral blouse scores a perfect priceValue", () => {
  const result = calculatePriceValueScore(makeListing({ title: "Vintage Floral Blouse", brand: null, price: 6 }));
  assert.equal(result.score, 10, `expected a perfect priceValue for a $6 thrift find, got ${result.score}`);
});

test("$25 generic leather jacket scores 5/10 priceValue", () => {
  const result = calculatePriceValueScore(makeListing({ title: "Leather Jacket", brand: null, price: 25 }));
  assert.equal(result.score, 5, `expected 5/10 for a $25 leather jacket with no notable brand, got ${result.score}`);
});

test("$50 designer item is lower priority, not maxed out", () => {
  const result = calculatePriceValueScore(makeListing({ title: "Designer Bag", brand: "Coach", price: 50 }));
  assert.ok(
    result.score <= 5,
    `expected a $50 item to stay lower-priority even with a recognizable brand, got ${result.score}`,
  );
  assert.ok(result.score > 0, "still shouldn't be a hard zero — 'do not completely reject expensive items'");
});

test("cheap thrift finds outscore expensive designer pieces on priceValue, even with a recognizable brand", () => {
  const cheapTank = calculatePriceValueScore(makeListing({ title: "Tank Top", brand: null, price: 5 }));
  const expensiveDesigner = calculatePriceValueScore(makeListing({ title: "Designer Bag", brand: "Coach", price: 50 }));

  assert.ok(
    cheapTank.score > expensiveDesigner.score,
    `expected the $5 tank (${cheapTank.score}) to outscore the $50 designer bag (${expensiveDesigner.score}) — ` +
      "the goal is 'best thrift find,' not 'highest resale value'",
  );
});

test("a full quality score favors an affordable Y2K tank over an expensive leather jacket", async () => {
  const tank = await scoreListingQuality(
    makeListing({ title: "Cute Y2K Tank Top", brand: null, price: 5, aesthetic_tags: ["#Y2K"] }),
  );
  const jacket = await scoreListingQuality(
    makeListing({ title: "Leather Jacket", brand: null, price: 25, aesthetic_tags: [] }),
  );

  assertValidScore(tank.qualityScore, tank.breakdown);
  assertValidScore(jacket.qualityScore, jacket.breakdown);

  assert.ok(
    tank.qualityScore > jacket.qualityScore,
    `expected the $5 Y2K tank (${tank.qualityScore}) to outscore the $25 leather jacket (${jacket.qualityScore})`,
  );
});

test("missing image loses image-quality points", async () => {
  const withImage = await scoreListingQuality(makeListing({ image_url: "https://example.com/photo.jpg" }));
  const withoutImage = await scoreListingQuality(makeListing({ image_url: null }));

  assertValidScore(withImage.qualityScore, withImage.breakdown);
  assertValidScore(withoutImage.qualityScore, withoutImage.breakdown);

  assert.ok(
    withoutImage.breakdown.imageQuality < withImage.breakdown.imageQuality,
    "a listing with no image at all should score lower on imageQuality than one with a photo",
  );
  assert.equal(withoutImage.breakdown.imageQuality, 0, "no photo at all means nothing to judge — imageQuality should be 0");
  assert.ok(
    withoutImage.qualityScore < withImage.qualityScore,
    "missing the image should also pull down completeness, so the overall score should drop too",
  );
});

test("missing price loses price-related points", async () => {
  const withPrice = await scoreListingQuality(makeListing({ price: 5, brand: null, title: "Y2K tank" }));
  const withoutPrice = await scoreListingQuality(makeListing({ price: null, brand: null, title: "Y2K tank" }));

  assertValidScore(withPrice.qualityScore, withPrice.breakdown);
  assertValidScore(withoutPrice.qualityScore, withoutPrice.breakdown);

  assert.equal(withoutPrice.breakdown.priceValue, 0, "no price at all can't be assessed for value — should score 0");
  assert.ok(
    withoutPrice.breakdown.completeness < withPrice.breakdown.completeness,
    "missing price should also cost completeness points",
  );
  assert.ok(withoutPrice.qualityScore < withPrice.qualityScore);
});

test("total score always stays within 0-100 across a range of inputs", async () => {
  const cases: Partial<ExtractedListing>[] = [
    {},
    { price: 0 },
    { price: -5 },
    { price: 100000, brand: "Coach", title: "bag" },
    { image_url: null, price: null, brand: null, title: "" },
    { aesthetic_tags: ["#Y2K", "#Vintage", "#Coquette", "#Streetwear"] },
    { price: 5, title: "Y2K tank" },
  ];

  for (const overrides of cases) {
    const result = await scoreListingQuality(makeListing(overrides));
    assertValidScore(result.qualityScore, result.breakdown);
  }
});
