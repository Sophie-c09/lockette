// Covers the P0 launch-readiness fix for category-bucket.ts's keyword
// matcher — a documented false positive already existed ("hat" collided
// with the brand "Baby Phat", fixed by removing that keyword outright)
// and this audit found the same class of bug going the other direction:
// "tote" is a substring PREFIX of the real fashion brand "Toteme." Fixed
// with a right-boundary-only check (not a full word-boundary — that would
// break legitimate compound garment words like "sundress"/"raincoat",
// which this file specifically regression-tests below).
import { test } from "node:test";
import assert from "node:assert/strict";
import { categorizeListing } from "@/lib/category-bucket";

function listing(title: string, category: string | null = null) {
  return { title, category };
}

test("a Toteme sweater is no longer misfiled as a bag", () => {
  assert.equal(categorizeListing(listing("Toteme Wool Sweater")), "tops");
});

test("a real tote bag still correctly buckets as bags", () => {
  assert.equal(categorizeListing(listing("Canvas Tote Bag")), "bags");
  assert.equal(categorizeListing(listing("Leather Totes")), "bags");
});

test("compound garment words with no space before the keyword still match correctly (regression guard)", () => {
  assert.equal(categorizeListing(listing("Floral Sundress")), "dresses");
  assert.equal(categorizeListing(listing("Wool Raincoat")), "outerwear");
  assert.equal(categorizeListing(listing("Vintage Overcoat")), "outerwear");
  assert.equal(categorizeListing(listing("Nike Sweatpants")), "bottoms");
  assert.equal(categorizeListing(listing("Grey Sweatshirt")), "tops");
});

test("plural forms (+s and +es) still match their singular keyword's bucket", () => {
  assert.equal(categorizeListing(listing("Denim Shorts")), "bottoms");
  assert.equal(categorizeListing(listing("Suede Boots")), "shoes");
  assert.equal(categorizeListing(listing("Silk Dresses Lot")), "dresses");
  assert.equal(categorizeListing(listing("Evening Clutches")), "bags");
  assert.equal(categorizeListing(listing("Skinny Jeans")), "bottoms");
});

test("Baby Phat is not miscategorized (the original documented bug stays fixed)", () => {
  assert.equal(categorizeListing(listing("Baby Phat Pink Tee")), "tops");
});

test("an unrecognized item falls back to 'other'", () => {
  assert.equal(categorizeListing(listing("Mystery Vintage Item")), "other");
});

test("more specific keywords are still checked before more generic ones (dress before short-sleeve etc.)", () => {
  assert.equal(categorizeListing(listing("Sweater Dress")), "dresses");
});
