// Run with: npm test (tests/**/*.test.ts)
//
// Covers the two pure modules behind Discover's personalization fix:
// discover-style-vector.ts (deterministic per-user taste representation)
// and discover-personalization.ts (garment-level match scoring + the
// fashionability quality gate). The worked example straight from this
// feature's own spec — "a floral maxi skirt should not rank highly for
// someone who likes fitted lace tops merely because both are tagged
// 'coquette'" — is asserted directly.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildUserStyleVector, type LikedListingAttributes } from "../src/lib/discover-style-vector";
import { scoreGarmentStyleMatch, computeFashionQualityScore, FASHION_QUALITY_GATE } from "../src/lib/discover-personalization";

const DAY_MS = 24 * 60 * 60 * 1000;

function likedTop(): LikedListingAttributes {
  return {
    id: "top-1",
    title: "Fitted lace-trim camisole",
    category: "Women Tank tops",
    brand: "Brandy Melville",
    color: "white",
    price: 18,
    aesthetic_tags: ["#Coquette", "#Y2K"],
    visual_analysis: null,
  };
}

test("garment-level matching: a floral maxi skirt does not outrank a similar top for a user who only likes fitted lace tops, even sharing the 'coquette' tag", () => {
  const now = Date.now();
  const vector = buildUserStyleVector({
    now,
    styleProfile: null,
    likedListings: [{ listing: likedTop(), occurredAt: new Date(now).toISOString() }],
    feedbackListings: [],
    hardExcludedAestheticKeys: new Set(),
  });

  const similarTop = scoreGarmentStyleMatch(vector, {
    id: "candidate-top",
    title: "Ruched lace-trim camisole top",
    category: "Women Tank tops",
    brand: "Brandy Melville",
    color: "white",
    price: 16,
    aestheticTags: ["#Coquette"],
    visualAnalysis: null,
  });

  const floralSkirt = scoreGarmentStyleMatch(vector, {
    id: "candidate-skirt",
    title: "Floral maxi skirt",
    category: "Women Maxi skirts",
    brand: "Unknown",
    color: "pink",
    price: 22,
    aestheticTags: ["#Coquette"],
    visualAnalysis: null,
  });

  assert.ok(
    similarTop.total > floralSkirt.total,
    `expected the similar top (${similarTop.total}) to outscore the floral skirt (${floralSkirt.total}) despite both sharing the "coquette" tag`,
  );
  // The skirt's ENTIRE match comes from generic aesthetic-tag overlap —
  // its garment-level component should be the one component that stays
  // near zero, since "skirt" was never something this user liked.
  assert.ok(floralSkirt.garmentScore < similarTop.garmentScore, "skirt's garment-level score should be well below the top's");
});

test("generic aesthetic tags contribute less to the style vector than specific garment attributes", () => {
  const now = Date.now();
  const genericOnly: LikedListingAttributes = {
    id: "generic-1",
    title: "Cute vintage top",
    category: null,
    brand: null,
    color: null,
    price: null,
    aesthetic_tags: ["#Y2K"], // one of the spec's own named generic tags
    visual_analysis: null,
  };
  const specificOnly: LikedListingAttributes = {
    id: "specific-1",
    title: "Cute vintage top",
    category: null,
    brand: null,
    color: null,
    price: null,
    aesthetic_tags: ["#AsymmetricNeckline"], // a specific, non-generic tag
    visual_analysis: null,
  };

  const vector = buildUserStyleVector({
    now,
    styleProfile: null,
    likedListings: [
      { listing: genericOnly, occurredAt: new Date(now).toISOString() },
      { listing: specificOnly, occurredAt: new Date(now).toISOString() },
    ],
    feedbackListings: [],
    hardExcludedAestheticKeys: new Set(),
  });

  const genericWeight = vector.aestheticTerms.get("y2k") ?? 0;
  const specificWeight = vector.aestheticTerms.get("asymmetricneckline") ?? 0;

  assert.ok(genericWeight > 0 && specificWeight > 0, "both tags should have contributed some weight");
  assert.ok(
    genericWeight < specificWeight,
    `expected the generic tag's weight (${genericWeight}) to be dampened below the specific tag's (${specificWeight})`,
  );
});

test("recency weighting: within the same Likes bucket, a like from today earns more of the bucket's weight than a like from a year ago", () => {
  const now = Date.now();
  // Two DIFFERENT garment nouns (cami vs cardigan) in the SAME bucket, so
  // each one's resulting weight reflects its own item's recency share of
  // the fixed 45-point Likes budget — a single-item bucket always claims
  // the whole budget regardless of age (correctly: recency only matters
  // RELATIVE to other items in the same bucket), so this needs at least
  // two.
  // No `category` on either (its raw text would otherwise cross-match
  // "top" via "Tops" for both, contaminating the isolation this test
  // relies on) — each title matches exactly one, disjoint garment-noun
  // keyword, so each map key's final weight comes from exactly one entry.
  const recentListing: LikedListingAttributes = {
    id: "recent-1",
    title: "Ribbed cami piece",
    category: null,
    brand: null,
    color: null,
    price: null,
    aesthetic_tags: [],
    visual_analysis: null,
  };
  const staleListing: LikedListingAttributes = {
    id: "stale-1",
    title: "Straight-leg jean piece",
    category: null,
    brand: null,
    color: null,
    price: null,
    aesthetic_tags: [],
    visual_analysis: null,
  };

  const vector = buildUserStyleVector({
    now,
    styleProfile: null,
    likedListings: [
      { listing: recentListing, occurredAt: new Date(now).toISOString() },
      { listing: staleListing, occurredAt: new Date(now - 365 * DAY_MS).toISOString() },
    ],
    feedbackListings: [],
    hardExcludedAestheticKeys: new Set(),
  });

  const recentWeight = vector.garmentTerms.get("cami") ?? 0;
  const staleWeight = vector.garmentTerms.get("jean") ?? 0;

  assert.ok(recentWeight > 0 && staleWeight > 0, "both should register some garment-term weight");
  assert.ok(recentWeight > staleWeight, `expected the recent like's weight (${recentWeight}) to exceed the year-old like's (${staleWeight})`);
});

test("a brand-new user with no likes, feedback, or onboarding gets a neutral baseline, not an arbitrary score", () => {
  const vector = buildUserStyleVector({
    now: Date.now(),
    styleProfile: null,
    likedListings: [],
    feedbackListings: [],
    hardExcludedAestheticKeys: new Set(),
  });

  assert.equal(vector.hasSignal, false);

  const breakdown = scoreGarmentStyleMatch(vector, {
    id: "any-listing",
    title: "Anything at all",
    category: "Tops",
    brand: "Some Brand",
    color: "blue",
    price: 20,
    aestheticTags: ["#Random"],
    visualAnalysis: null,
  });

  assert.equal(breakdown.total, 50);
});

test("fashionability gate: prefers the existing inventory_quality_score field over the deterministic fallback", () => {
  const result = computeFashionQualityScore({
    images: ["a.jpg"],
    imageUrl: "a.jpg",
    title: "x",
    aestheticTags: [],
    brand: null,
    category: null,
    price: null,
    qualityScore: 20,
    inventoryQualityScore: 0.9,
  });

  assert.equal(result.source, "inventory_quality_score");
  assert.equal(result.score, 90);
});

test("fashionability gate: a listing with no photos, a near-empty title, and no price scores below the gate threshold via the deterministic fallback", () => {
  const result = computeFashionQualityScore({
    images: [],
    imageUrl: null,
    title: "Top",
    aestheticTags: [],
    brand: null,
    category: null,
    price: null,
    qualityScore: null,
    inventoryQualityScore: null,
  });

  assert.equal(result.source, "deterministic_fallback");
  assert.ok(result.score < FASHION_QUALITY_GATE, `expected a low-effort listing to score below the gate (${FASHION_QUALITY_GATE}), got ${result.score}`);
});

test("fashionability gate: a listing with several photos, a descriptive title, brand, category, and plausible price clears the gate via the deterministic fallback", () => {
  const result = computeFashionQualityScore({
    images: ["a.jpg", "b.jpg", "c.jpg"],
    imageUrl: "a.jpg",
    title: "Brandy Melville ribbed lace-trim camisole in cream",
    aestheticTags: ["#Coquette", "#Y2K"],
    brand: "Brandy Melville",
    category: "Tops",
    price: 18,
    qualityScore: null,
    inventoryQualityScore: null,
  });

  assert.equal(result.source, "deterministic_fallback");
  assert.ok(result.score >= FASHION_QUALITY_GATE, `expected a well-described listing to clear the gate (${FASHION_QUALITY_GATE}), got ${result.score}`);
});
