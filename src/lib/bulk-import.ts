// Bulk-import batch processor — takes a chunk of candidate product URLs
// (already found by src/lib/marketplace-discovery.ts) and runs each
// through the exact same pipeline the single-URL importer uses
// (extractListingFromUrl -> enrichListing), then batch-inserts the
// survivors. "Scraped listings go live automatically unless flagged" —
// each survivor is inserted as 'active' unless flagListing()
// (src/lib/inventory/listing-flagging.ts) finds a concrete problem, in
// which case it's inserted as 'flagged' for /admin/listings review
// instead. This is additive to (not a replacement for) the AI quality
// score below, which still hard-rejects anything under
// QUALITY_REJECTION_THRESHOLD before it ever reaches this insert.
import { extractListingFromUrl } from "@/lib/listing-extraction";
import { enrichListing } from "@/lib/listing-enrichment";
import { generateAndSaveListingEmbedding } from "@/lib/listing-embeddings";
import { scoreListingQuality, QUALITY_REJECTION_THRESHOLD, type QualityScoreBreakdown } from "@/lib/listing-quality";
import { flagListing } from "@/lib/inventory/listing-flagging";
import { createAdminClient } from "@/lib/supabase/admin";
import { mapWithConcurrency } from "@/lib/concurrency";
import type { PriceMode, SelectedCategory, SelectedBrand } from "@/lib/marketplace-discovery";
import type { ListingInsert, ListingsDatabase } from "@/lib/supabase/listings.types";
import type { ExtractedListing } from "@/lib/extraction/normalize-listing";

export type { PriceMode, SelectedCategory, SelectedBrand } from "@/lib/marketplace-discovery";

type ListingRowToInsert = ListingInsert & {
  shipping_cost: number;
  status: "active" | "flagged";
  flag_reason: string | null;
  quality_score: number;
  quality_reason: string;
  quality_breakdown: QualityScoreBreakdown;
};

// ---------------------------------------------------------------------------
// Category diversity control — prevents a run from being dominated by one
// category (e.g. the "80% jackets" problem this whole rebalance is fixing).
// Buckets are coarse and keyword-matched, same spirit as
// src/lib/listing-quality.ts's own category matching: good enough to bias
// a ranking decision, not meant to be an authoritative classification.
// ---------------------------------------------------------------------------

// "bags" split out as its own bucket (was previously lumped into
// "accessories" alongside jewelry/belts/scarves) so the reverse-image-
// search matching pipeline (src/lib/garment-matching.ts) can actually
// search for a detected bag/purse specifically, instead of it competing
// against every other accessory type in one broad bucket — see
// src/lib/garment-detection.ts's own comment on why that distinction
// matters for matching quality.
export type CategoryBucket = "tops" | "dresses" | "bottoms" | "outerwear" | "accessories" | "bags" | "shoes" | "other";

export type CategoryCounts = Partial<Record<CategoryBucket, number>>;

// Checked in order — more specific/definitive keywords first so e.g. a
// "sweater dress" lands in dresses rather than tops.
const CATEGORY_BUCKET_KEYWORDS: [string, CategoryBucket][] = [
  ["dress", "dresses"],
  ["skirt", "bottoms"],
  ["jean", "bottoms"],
  ["denim", "bottoms"],
  ["trouser", "bottoms"],
  ["legging", "bottoms"],
  ["pant", "bottoms"],
  ["short", "bottoms"],
  ["jacket", "outerwear"],
  ["coat", "outerwear"],
  ["hoodie", "outerwear"],
  ["cardigan", "outerwear"],
  ["blazer", "outerwear"],
  ["windbreaker", "outerwear"],
  ["shoe", "shoes"],
  ["sneaker", "shoes"],
  ["boot", "shoes"],
  ["sandal", "shoes"],
  ["heel", "shoes"],
  ["bag", "bags"],
  ["purse", "bags"],
  ["backpack", "bags"],
  ["tote", "bags"],
  ["clutch", "bags"],
  ["jewelry", "accessories"],
  ["necklace", "accessories"],
  ["earring", "accessories"],
  ["bracelet", "accessories"],
  ["belt", "accessories"],
  ["scarf", "accessories"],
  ["sunglasses", "accessories"],
  // Deliberately NOT "hat" — verified live against this app's own
  // inventory that it's a substring of the real, common brand name "Baby
  // Phat" ("Phat".includes("hat")), which was silently miscategorizing
  // every Baby Phat top/tee as an accessory. This keyword-substring
  // matcher has no word-boundary check, so a short, common word like
  // "hat" is too easy to collide with an unrelated brand/word.
  ["camisole", "tops"],
  ["blouse", "tops"],
  ["sweater", "tops"],
  ["cami", "tops"],
  ["crop", "tops"],
  ["tank", "tops"],
  ["t-shirt", "tops"],
  ["tee", "tops"],
  ["shirt", "tops"],
  ["top", "tops"],
];

export function categorizeListing(listing: ExtractedListing): CategoryBucket {
  const haystack = `${listing.category ?? ""} ${listing.title ?? ""}`.toLowerCase();
  for (const [keyword, bucket] of CATEGORY_BUCKET_KEYWORDS) {
    if (haystack.includes(keyword)) return bucket;
  }
  return "other";
}

// "For every 100 imported listings aim for: Tops 30%, Dresses 15%,
// Bottoms 20%, Outerwear 10%, Accessories 7%, Bags 3%, Shoes 10%, Other 5%."
// Accessories' original 10% split into 7/3 now that bags is its own
// bucket (see this file's own comment on why bags was split out) — kept
// summing to 1.0 overall, same as before.
const CATEGORY_QUOTAS: Record<CategoryBucket, number> = {
  tops: 0.3,
  dresses: 0.15,
  bottoms: 0.2,
  outerwear: 0.1,
  accessories: 0.07,
  bags: 0.03,
  shoes: 0.1,
  other: 0.05,
};

// Category balance is a SOFT ranking preference only — it never causes a
// candidate to be skipped/rejected (a prior version hard-skipped anything
// over a quota multiplier once the running total passed a threshold, which
// in practice meant that a run dominated by one category — e.g. almost
// everything coming back "tops" — had nowhere else to draw from and ended
// up skipping the vast majority of real candidates for no good reason: 196
// skipped in one reported run). Now it only affects ORDER: once a category
// is at/over its soft cap, its candidates sort later (see rankCandidates),
// so other categories get first pick when there's real competition, but a
// category is always allowed to fill the rest of a batch if that's what's
// actually available — every scored candidate still gets inserted.
//
// "Target tops = 30% ... allow up to 50% if they are highest quality" is
// the literal example this cap is built from: a category's soft cap is its
// target share plus this fixed overflow allowance (0.3 + 0.2 = 0.5).
const CATEGORY_SOFT_CAP_OVERFLOW = 0.2;
// Don't start enforcing the cap until there's enough of a running total
// for "share of total" to mean anything — otherwise the very first
// imported item (100% of a running total of 1) would immediately look
// over quota for every category except the biggest one.
const MIN_TOTAL_BEFORE_ENFORCING_QUOTA = 10;

function categoryShare(bucket: CategoryBucket, counts: CategoryCounts, total: number): number {
  return total > 0 ? (counts[bucket] ?? 0) / total : 0;
}

function categorySoftCap(bucket: CategoryBucket): number {
  return Math.min(CATEGORY_QUOTAS[bucket] + CATEGORY_SOFT_CAP_OVERFLOW, 1);
}

function isAtOrOverSoftCategoryCap(bucket: CategoryBucket, counts: CategoryCounts, total: number): boolean {
  if (total < MIN_TOTAL_BEFORE_ENFORCING_QUOTA) return false;
  return categoryShare(bucket, counts, total) >= categorySoftCap(bucket);
}

// Quality scoring is its own AI vision call (src/lib/listing-quality.ts) —
// bounded separately from EXTRACTION_CONCURRENCY below since it only ever
// runs on candidates that already survived the image_url duplicate check,
// a smaller set than the full batch.
const QUALITY_SCORE_CONCURRENCY = 4;

// How many candidate URLs this module will actually extract+enrich at
// once. Each one is a real page fetch (possibly a full Playwright render)
// plus two OpenAI calls, so this is deliberately modest — not the same
// number as the 25-per-database-insert batch size below, which is a
// separate constraint (Postgres can insert 25 rows in one round trip
// instantly; the network+AI work per candidate is what actually takes
// time and is what concurrency bounds here).
const EXTRACTION_CONCURRENCY = 4;

// "25 listings per database insert" — enforced here as an invariant of
// this module itself, not just a convention the caller happens to follow.
// If a caller ever passes more than 25 URLs in one call, the actual
// inserts still go through in chunks of this size.
const DB_INSERT_CHUNK_SIZE = 25;

// Embedding generation (src/lib/listing-embeddings.ts) is 2 OpenAI calls
// per listing (vision description + text embedding) — kept low for the
// same "don't pile up too many concurrent OpenAI requests" reasoning as
// QUALITY_SCORE_CONCURRENCY/EXTRACTION_CONCURRENCY above.
const EMBEDDING_CONCURRENCY = 4;

const SHIPPING_COST_BY_PLATFORM: Record<string, number> = {
  Depop: 2,
  Vinted: 0,
};

function shippingCostForPlatform(platform: string | null): number {
  if (!platform) return 0;
  return SHIPPING_COST_BY_PLATFORM[platform] ?? 0;
}

// Same "is this a not-yet-migrated column" detection as
// /api/import-listing/route.ts — duplicated rather than imported since
// that file only exports its POST handler (Next.js route module
// convention), not a reusable library.
function isMissingColumnError(error: { code?: string; message: string }): boolean {
  return error.code === "PGRST204" || /column .* does not exist/i.test(error.message);
}

// `status` is deliberately NEVER in this list. This function strips
// columns that might not exist yet on an unmigrated database — status
// always exists (it's core to this whole feature) and dropping it here
// would let Postgres fall back to the column's own default, which is NOT
// guaranteed to be 'pending' on every database (confirmed live: it can
// still be the pre-moderation-queue default of 'active' if schema.sql's
// `alter column status set default 'pending'` hasn't been re-run). A
// bulk-imported listing accidentally going live as 'active' — the one
// thing this whole feature exists to prevent — is a much worse failure
// mode than this retry not stripping a column that was never actually
// the problem.
/* eslint-disable @typescript-eslint/no-unused-vars -- destructured only to omit these possibly-not-yet-migrated columns */
function withoutOptionalFields({
  source_likes_count,
  source_views_count,
  source_comments_count,
  shipping_cost,
  quality_score,
  quality_reason,
  quality_breakdown,
  // New (see supabase/migrations/20260728063000_add_listing_flagging.sql)
  // — same "possibly not migrated yet" reasoning as every other field
  // here, never `status` itself.
  flag_reason,
  ...rest
}: ListingRowToInsert) {
  return rest;
}
/* eslint-enable @typescript-eslint/no-unused-vars */

export interface BulkImportFailure {
  url: string;
  error: string;
}

export interface BulkImportBatchResult {
  successCount: number;
  failedCount: number;
  // Candidates that extracted fine but turned out to already exist
  // (same source_url or same image_url as an existing row) — tracked
  // separately from failedCount since these aren't broken scrapes, just
  // correctly-skipped duplicates (requirement 2: never create a
  // duplicate listing).
  duplicateCount: number;
  // Candidates that extracted fine, weren't duplicates, but scored below
  // QUALITY_REJECTION_THRESHOLD (src/lib/listing-quality.ts) — never
  // inserted at all, not even as 'rejected'. Also not a failure: the
  // scrape worked, the listing just isn't good enough for the queue.
  qualityRejectedCount: number;
  // Candidates that extracted fine, weren't duplicates, but priced above
  // EXTREME_PRICE_REJECTION_THRESHOLD (a sanity-check ceiling, not the
  // admin's Price Mode selection — see the "Price Mode scoring" section)
  // — rejected BEFORE quality scoring runs, specifically so a wildly
  // over-priced listing never spends an AI vision call it's guaranteed to
  // be thrown away after anyway. Same "not a failure" treatment as
  // qualityRejectedCount.
  priceRejectedCount: number;
  // Candidates that extracted fine, weren't duplicates, and were under the
  // price limit, but didn't match any of the admin's selected categories
  // (/admin/import's category checklist — see the "Selected-category
  // filtering" section) — rejected BEFORE quality scoring runs, same
  // cost-saving reasoning as priceRejectedCount. Always 0 when no
  // categories are selected (section 8: no filtering by default).
  categoryRejectedCount: number;
  // Candidates that extracted fine, weren't duplicates, were under the
  // price limit, and matched a selected category (if any), but neither
  // listing.brand nor listing.title mentioned any of the admin's selected
  // brands (/admin/import's Brand Filters — see "Brand filtering" below)
  // — rejected BEFORE quality scoring runs, same cost-saving reasoning as
  // priceRejectedCount/categoryRejectedCount. Always 0 when no brands are
  // selected (fallback: no filtering by default).
  brandRejectedCount: number;
  // Cumulative per-category counts across this whole run (this batch's
  // insertions merged into whatever was passed in) — callers should feed
  // this straight into the next processBulkImportBatch call so category
  // BALANCE (a soft ranking preference, see isAtOrOverSoftCategoryCap) is
  // computed against the *whole* run, not reset every batch.
  categoryCounts: CategoryCounts;
  failures: BulkImportFailure[];
}

function emptyResult(categoryCountsSoFar: CategoryCounts): BulkImportBatchResult {
  return {
    successCount: 0,
    failedCount: 0,
    duplicateCount: 0,
    qualityRejectedCount: 0,
    priceRejectedCount: 0,
    categoryRejectedCount: 0,
    brandRejectedCount: 0,
    categoryCounts: categoryCountsSoFar,
    failures: [],
  };
}

// ---------------------------------------------------------------------------
// Price Mode scoring — a SOFT ranking bonus, not a filter. The old design
// hard-rejected any listing priced above the selected mode's ceiling (e.g.
// $10), which in practice threw out ~98% of real candidates: most genuine
// thrift finds a scraper surfaces are priced a little above whatever
// round-number ceiling an admin picks, so a hard cutoff there was
// indistinguishable from "almost nothing survives." This bonus instead
// biases ranking toward cheap listings without ever eliminating pricier
// ones outright — see EXTREME_PRICE_REJECTION_THRESHOLD below for the only
// remaining hard reject.
// ---------------------------------------------------------------------------

// A sanity-check ceiling, NOT a Price Mode ceiling — rejects only listings
// priced high enough to be almost certainly a scraping error or a genuine
// mismatch with Lockette's thrift-find identity, regardless of which Price
// Mode the admin selected (even "any").
const EXTREME_PRICE_REJECTION_THRESHOLD = 80;

// "Any" applies no price-based ranking preference at all — that's what
// makes it meaningfully different from "under10"/"under20" here (both of
// those still bias ranking toward cheap listings via this bonus, just
// without ever hard-rejecting the rest).
function priceModeValueScore(price: number | null, priceMode: PriceMode): number {
  if (priceMode === "any" || price == null) return 0;
  if (price <= 6) return 10;
  if (price <= 10) return 8;
  if (price <= 15) return 5;
  if (price <= 25) return 2;
  return 0;
}

// ---------------------------------------------------------------------------
// Selected-category filtering — /admin/import's category checklist (SelectedCategory,
// src/lib/marketplace-discovery.ts). Distinct from CategoryBucket/CATEGORY_QUOTAS
// above (that's about run-wide category BALANCE); this is about whether an
// extracted listing matches what the admin explicitly asked for at all. When
// the admin selects nothing, this whole section is a no-op (section 8:
// "behave as current system").
// ---------------------------------------------------------------------------

type CategoryMatchStrength = "strong" | "partial";

interface CategoryMatch {
  category: SelectedCategory;
  strength: CategoryMatchStrength;
}

// Garment-type keywords used to recognize whether a listing's title/category
// field/aesthetic tags mention the kind of item a SelectedCategory means —
// deliberately broader than the search terms used to FIND candidates
// (src/lib/marketplace-discovery.ts's SELECTED_CATEGORY_SEARCH_TERMS), since
// a real listing's title rarely echoes the exact search phrase back.
const GARMENT_TYPE_KEYWORDS: Record<SelectedCategory, string[]> = {
  "low-rise-jeans": ["jean", "denim"],
  "low-rise-shorts": ["short"],
  "low-rise-skirts": ["skirt"],
  tops: ["tee", "t-shirt", "tank", "camisole", "cami", "top", "blouse", "shirt", "crop"],
  dresses: ["dress"],
  skirts: ["skirt"],
  "sweaters-jackets": ["sweater", "cardigan", "hoodie", "jacket", "sweatshirt", "pullover"],
};

const LOW_RISE_CATEGORIES = new Set<SelectedCategory>(["low-rise-jeans", "low-rise-shorts", "low-rise-skirts"]);
const LOW_RISE_PATTERN = /low[\s-]?rise/i;
const HIGH_RISE_PATTERN = /high[\s-]?rise|high[\s-]?waist(?:ed)?/i;
const Y2K_INDICATOR_PATTERN = /\by2k\b|\b2000s\b|\b90s\b|early 2000s/i;

// "MUST contain 'low rise' or Y2K indicators, reject if 'high rise' or
// 'high waisted'" — applied only for the three low-rise categories, on top
// of the base garment-type match every category needs.
function categoryMatchStrength(listing: ExtractedListing, category: SelectedCategory): CategoryMatchStrength | null {
  const title = (listing.title ?? "").toLowerCase();
  const categoryField = (listing.category ?? "").toLowerCase();
  const tags = listing.aesthetic_tags.join(" ").toLowerCase();
  const combined = `${title} ${categoryField} ${tags}`;

  const garmentKeywords = GARMENT_TYPE_KEYWORDS[category];
  const matchesInTitle = garmentKeywords.some((keyword) => title.includes(keyword));
  const matchesAnywhere = matchesInTitle || garmentKeywords.some((keyword) => combined.includes(keyword));

  if (!matchesAnywhere) return null;

  if (LOW_RISE_CATEGORIES.has(category)) {
    if (HIGH_RISE_PATTERN.test(combined)) return null;
    if (!LOW_RISE_PATTERN.test(combined) && !Y2K_INDICATOR_PATTERN.test(combined)) return null;
  }

  return matchesInTitle ? "strong" : "partial";
}

// A listing can match more than one selected category (e.g. a "sweater
// dress" could match both "dresses" and "sweaters-jackets") — the strongest
// match wins, since that's what determines both whether it survives
// filtering and its priority-boost bonus below.
function bestCategoryMatch(listing: ExtractedListing, selectedCategories: SelectedCategory[]): CategoryMatch | null {
  let best: CategoryMatch | null = null;

  for (const category of selectedCategories) {
    const strength = categoryMatchStrength(listing, category);
    if (!strength) continue;
    if (!best || (strength === "strong" && best.strength === "partial")) {
      best = { category, strength };
    }
  }

  return best;
}

// "+10 score if strong match, +5 if partial match" — zero (no boost, but
// also no penalty) when nothing was selected or nothing matched.
function categoryMatchBonus(match: CategoryMatch | null): number {
  if (!match) return 0;
  return match.strength === "strong" ? 10 : 5;
}

// ---------------------------------------------------------------------------
// Brand filtering — /admin/import's Brand Filters (Abercrombie/Hollister/
// American Eagle, SelectedBrand — src/lib/selected-brands.ts). Same
// treatment as selected-category filtering above: a real hard filter (not
// just a ranking preference) when the admin picks specific brands, since
// this is an explicit request, not an automatic heuristic. A no-op when
// nothing is selected (Fallback: "behave normally, no filtering").
// ---------------------------------------------------------------------------

// "listing.brand OR listing.title must include one of selected brands
// (case-insensitive)" — plain substring match, which also naturally
// handles real-world brand-name variants (e.g. a listing brand of
// "Abercrombie & Fitch" or a title mentioning "American Eagle Outfitters"
// both still contain the shorter selected-brand string).
function matchesSelectedBrand(listing: ExtractedListing, selectedBrands: SelectedBrand[]): boolean {
  if (selectedBrands.length === 0) return true;
  const haystack = `${listing.brand ?? ""} ${listing.title ?? ""}`.toLowerCase();
  return selectedBrands.some((brand) => haystack.includes(brand.toLowerCase()));
}

// "+25 score if listing matches selected brand" — 0 when no brands are
// selected. In practice this is only ever computed for listings that
// already passed the hard brand filter below (non-matches are rejected
// before scoring runs), so it's always +25 once brands are selected — but
// it still combines correctly with categoryMatchBonus in rankCandidates'
// priority-boost step below.
function brandMatchBonus(listing: ExtractedListing, selectedBrands: SelectedBrand[]): number {
  if (selectedBrands.length === 0) return 0;
  return matchesSelectedBrand(listing, selectedBrands) ? 25 : 0;
}

interface ScoredCandidate {
  url: string;
  listing: ExtractedListing;
  qualityScore: number;
  qualityReason: string;
  breakdown: QualityScoreBreakdown;
  category: CategoryBucket;
  priceModeScore: number;
  categoryMatchBonus: number;
  brandMatchBonus: number;
}

// Process ALL listings first (every extracted, non-duplicate, in-price-limit,
// selected-category-matching, selected-brand-matching candidate gets scored —
// nothing is filtered out here), THEN sort by: quality score, price score,
// aesthetic match. Category BALANCE only enters as a final, soft tie-break
// (step 4) that reorders but never drops a candidate — see
// isAtOrOverSoftCategoryCap above. The selected-category/selected-brand
// priority boost (step 0) ranks ahead of everything else, since it reflects
// the admin's own explicit request ("ONLY low-rise jeans + tops" / "ONLY
// Abercrombie"), not just a general preference.
function rankCandidates(
  candidates: ScoredCandidate[],
  categoryCountsSoFar: CategoryCounts,
  totalSoFar: number,
): ScoredCandidate[] {
  return [...candidates].sort((a, b) => {
    // 0. Priority boost — strong/partial matches to the admin's selected
    // categories, plus a flat +25 for matching a selected brand. Zero for
    // everyone when nothing was selected, so this step is a no-op by
    // default.
    const aBoost = a.categoryMatchBonus + a.brandMatchBonus;
    const bBoost = b.categoryMatchBonus + b.brandMatchBonus;
    const boostDiff = bBoost - aBoost;
    if (boostDiff !== 0) return boostDiff;

    // 1. Quality score.
    const qualityDiff = b.qualityScore - a.qualityScore;
    if (qualityDiff !== 0) return qualityDiff;

    // 2. Price score — the quality model's priceValue plus Price Mode's
    // soft cheap-listing bonus (priceModeValueScore), combined into one
    // "how affordable is this" signal.
    const aPriceScore = a.breakdown.priceValue + a.priceModeScore;
    const bPriceScore = b.breakdown.priceValue + b.priceModeScore;
    const priceDiff = bPriceScore - aPriceScore;
    if (priceDiff !== 0) return priceDiff;

    // 3. Aesthetic match — more detected tags first.
    const tagDiff = b.listing.aesthetic_tags.length - a.listing.aesthetic_tags.length;
    if (tagDiff !== 0) return tagDiff;

    // 4. Category balance — a soft deprioritization, not a rejection: once
    // a bucket is at/over its soft cap (see isAtOrOverSoftCategoryCap),
    // its candidates sort after ones from buckets still under cap, so a
    // still-under-quota category gets first pick when there's genuine
    // competition — but every candidate is still inserted below regardless
    // of which side of this tie-break it lands on.
    const aOverCap = isAtOrOverSoftCategoryCap(a.category, categoryCountsSoFar, totalSoFar) ? 1 : 0;
    const bOverCap = isAtOrOverSoftCategoryCap(b.category, categoryCountsSoFar, totalSoFar) ? 1 : 0;
    return aOverCap - bOverCap;
  });
}

/**
 * Processes one batch of candidate URLs (intended size: up to 25 — see
 * DB_INSERT_CHUNK_SIZE) end to end: extract -> enrich (text classification
 * + AI image tagging, same as the single-URL importer) -> dedupe against
 * both the database and the rest of this batch -> price/category filters
 * -> quality score -> rank ALL survivors (priority boost, quality score,
 * price score, aesthetic match, category balance — never just "import the
 * first search results") -> insert every ranked candidate as 'pending'.
 * Category balance never removes a candidate from that list, only reorders
 * it — see the "Category diversity control" section above for why a prior
 * version's hard skip was replaced with a soft ranking tie-break. A single
 * bad URL (extraction throws, missing title, etc.) is caught and recorded
 * in `failures` — it never stops the rest of the batch (requirement 6).
 *
 * `categoryCountsSoFar`/`totalInsertedSoFar` carry the running category
 * mix across a whole multi-batch bulk-import run (see ImportListingView.tsx,
 * which threads BulkImportBatchResult.categoryCounts from each call into
 * the next) — balance is computed against the *run's* total, not reset
 * to zero every 25 URLs.
 *
 * `priceMode` ("under10" | "under20" | "any") is a SOFT ranking preference,
 * not a filter (see priceModeValueScore above) — "under10"/"under20" bias
 * ranking toward cheap listings, "any" applies no price-based preference at
 * all. The only price-based hard rejection left is
 * EXTREME_PRICE_REJECTION_THRESHOLD, which applies regardless of priceMode.
 *
 * `selectedCategories` (/admin/import's category checklist) hard-rejects
 * any listing that doesn't match at least one selected category (see
 * bestCategoryMatch) — unlike category BALANCE, this IS a real filter, since
 * it's the admin's own explicit request, not an automatic heuristic. An
 * empty array (the default) applies no filtering at all.
 *
 * `selectedBrands` (/admin/import's Brand Filters) hard-rejects any listing
 * whose brand/title don't mention at least one selected brand (see
 * matchesSelectedBrand) — same real-filter treatment as selectedCategories,
 * plus a +25 ranking boost (brandMatchBonus) for whatever survives. An
 * empty array (the default) applies no filtering at all (Fallback).
 */
export async function processBulkImportBatch(
  urls: string[],
  categoryCountsSoFar: CategoryCounts = {},
  totalInsertedSoFar: number = 0,
  priceMode: PriceMode = "any",
  selectedCategories: SelectedCategory[] = [],
  selectedBrands: SelectedBrand[] = [],
): Promise<BulkImportBatchResult> {
  if (urls.length === 0) return emptyResult(categoryCountsSoFar);

  const supabase = createAdminClient<ListingsDatabase>();
  const failures: BulkImportFailure[] = [];

  // Duplicate check #1 — same source_url already exists. Checked up front
  // (before spending a fetch+two AI calls on something we'd just throw
  // away): the discovery step already excludes known product_urls, but a
  // batch can be retried or called with a stale candidate list, and this
  // must hold regardless.
  const { data: existingByUrl, error: existingByUrlError } = await supabase
    .from("listings")
    .select("product_url")
    .in("product_url", urls);

  if (existingByUrlError) {
    console.error("[bulk-import] Failed to check existing product_urls:", existingByUrlError);
  }

  const existingUrlSet = new Set(
    (existingByUrl ?? []).map((row) => row.product_url).filter((url): url is string => Boolean(url)),
  );

  let duplicateCount = 0;
  const candidateUrls = urls.filter((url) => {
    if (existingUrlSet.has(url)) {
      duplicateCount++;
      return false;
    }
    return true;
  });

  // Extract + enrich each surviving candidate, bounded concurrency so a
  // batch of 25 doesn't fire 25 simultaneous page loads/AI calls.
  type Processed = {
    listing: Awaited<ReturnType<typeof extractListingFromUrl>>;
    url: string;
  };

  const processedResults = await mapWithConcurrency(candidateUrls, EXTRACTION_CONCURRENCY, async (url): Promise<Processed | null> => {
    try {
      const extracted = await extractListingFromUrl(url);
      const enriched = await enrichListing(extracted);

      if (!enriched.title.trim()) {
        failures.push({ url, error: "This listing is missing a title." });
        return null;
      }

      return { listing: enriched, url };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to extract listing.";
      failures.push({ url, error: message });
      return null;
    }
  });

  const processed = processedResults.filter((item): item is Processed => item !== null);

  // Duplicate check #2 — same image_url already exists, either in the
  // database or elsewhere in this same batch (two different source URLs
  // that turn out to be the same item crossposted to another platform).
  // Only knowable now: image_url isn't known until after extraction.
  const candidateImageUrls = [
    ...new Set(processed.map((item) => item.listing.image_url).filter((url): url is string => Boolean(url))),
  ];

  let existingImageSet = new Set<string>();
  if (candidateImageUrls.length > 0) {
    const { data: existingByImage, error: existingByImageError } = await supabase
      .from("listings")
      .select("image_url")
      .in("image_url", candidateImageUrls);

    if (existingByImageError) {
      console.error("[bulk-import] Failed to check existing image_urls:", existingByImageError);
    } else {
      existingImageSet = new Set(
        (existingByImage ?? []).map((row) => row.image_url).filter((url): url is string => Boolean(url)),
      );
    }
  }

  const seenImageUrlsThisBatch = new Set<string>();
  const notDuplicated: Processed[] = [];

  for (const item of processed) {
    const imageUrl = item.listing.image_url;
    if (imageUrl && (existingImageSet.has(imageUrl) || seenImageUrlsThisBatch.has(imageUrl))) {
      duplicateCount++;
      continue;
    }
    if (imageUrl) seenImageUrlsThisBatch.add(imageUrl);
    notDuplicated.push(item);
  }

  // Extreme-price sanity check — the only price-based hard rejection left
  // (see the "Price Mode scoring" section above for why the old per-mode
  // ceiling reject was removed). Applies regardless of priceMode, including
  // "any". A listing with no extracted price passes through unfiltered —
  // there's nothing to compare against, and scoreListingQuality already
  // scores a missing price at 0 on its own.
  let priceRejectedCount = 0;
  const withinExtremePriceLimit: Processed[] = notDuplicated.filter((item) => {
    if (item.listing.price != null && item.listing.price > EXTREME_PRICE_REJECTION_THRESHOLD) {
      priceRejectedCount++;
      return false;
    }
    return true;
  });

  // Selected-category filter (/admin/import's category checklist) — rejects
  // anything that doesn't match at least one selected category, BEFORE
  // quality scoring runs (same cost-saving placement as the price filter
  // above). A no-op when nothing is selected (section 8).
  let categoryRejectedCount = 0;
  const withinSelectedCategories: { item: Processed; categoryMatch: CategoryMatch | null }[] = [];

  for (const item of withinExtremePriceLimit) {
    if (selectedCategories.length === 0) {
      withinSelectedCategories.push({ item, categoryMatch: null });
      continue;
    }

    const categoryMatch = bestCategoryMatch(item.listing, selectedCategories);
    if (!categoryMatch) {
      categoryRejectedCount++;
      continue;
    }

    withinSelectedCategories.push({ item, categoryMatch });
  }

  // Brand filter (/admin/import's Brand Filters) — rejects anything whose
  // brand/title don't mention at least one selected brand, BEFORE quality
  // scoring runs (same cost-saving placement as the filters above). A
  // no-op when nothing is selected (Fallback).
  let brandRejectedCount = 0;
  const withinSelectedBrands: { item: Processed; categoryMatch: CategoryMatch | null }[] = [];

  for (const { item, categoryMatch } of withinSelectedCategories) {
    if (!matchesSelectedBrand(item.listing, selectedBrands)) {
      brandRejectedCount++;
      continue;
    }
    withinSelectedBrands.push({ item, categoryMatch });
  }

  // Quality scoring (src/lib/listing-quality.ts) runs only on survivors of
  // the duplicate check, extreme-price check, selected-category filter, and
  // brand filter above — no point spending an AI vision call scoring
  // something that's about to be dropped anyway. Below
  // QUALITY_REJECTION_THRESHOLD, a listing is skipped entirely (never
  // inserted, not even as 'rejected') rather than added to the queue.
  let qualityRejectedCount = 0;
  const scored: ScoredCandidate[] = [];

  await mapWithConcurrency(withinSelectedBrands, QUALITY_SCORE_CONCURRENCY, async ({ item, categoryMatch }) => {
    const { qualityScore, qualityReason, breakdown } = await scoreListingQuality(item.listing);

    if (qualityScore < QUALITY_REJECTION_THRESHOLD) {
      qualityRejectedCount++;
      return;
    }

    scored.push({
      url: item.url,
      listing: item.listing,
      qualityScore,
      qualityReason,
      breakdown,
      category: categorizeListing(item.listing),
      priceModeScore: priceModeValueScore(item.listing.price, priceMode),
      categoryMatchBonus: categoryMatchBonus(categoryMatch),
      brandMatchBonus: brandMatchBonus(item.listing, selectedBrands),
    });
  });

  // Rank (never "just import the first search results" — requirement 5) —
  // never a rejection past this point: EVERY scored candidate gets
  // inserted below. Category balance already shaped ORDER inside
  // rankCandidates (step 4), not membership, so there is no skip loop here
  // anymore (see the "Category diversity control" section above for why:
  // a hard skip here previously threw out candidates with nowhere else to
  // fall back to — 196 in one reported run — which is exactly what this
  // fixes).
  const ranked = rankCandidates(scored, categoryCountsSoFar, totalInsertedSoFar);

  const runningCategoryCounts: CategoryCounts = { ...categoryCountsSoFar };
  const toInsert: ListingRowToInsert[] = [];

  for (const candidate of ranked) {
    // "Scraped listings go live automatically unless flagged" — flagListing()
    // is additive to the AI quality-score gate above (which already
    // hard-rejects anything below QUALITY_REJECTION_THRESHOLD); everything
    // reaching this loop already cleared that gate, so this only decides
    // 'active' vs 'flagged', never a third rejection.
    const flag = flagListing({
      title: candidate.listing.title,
      description: candidate.listing.description,
      images: candidate.listing.images,
      price: candidate.listing.price,
      category: candidate.listing.category,
    });

    if (flag.isSafe) {
      console.log("[IMPORT] Auto-live:", candidate.listing.title, candidate.listing.price);
    } else {
      console.log("[IMPORT] Flagged:", flag.reasons);
    }

    toInsert.push({
      ...candidate.listing,
      shipping_cost: shippingCostForPlatform(candidate.listing.platform),
      status: flag.isSafe ? "active" : "flagged",
      flag_reason: flag.isSafe ? null : (flag.reasons ?? []).join(", "),
      quality_score: candidate.qualityScore,
      quality_reason: candidate.qualityReason,
      quality_breakdown: candidate.breakdown,
    });

    runningCategoryCounts[candidate.category] = (runningCategoryCounts[candidate.category] ?? 0) + 1;
  }

  // Insert in chunks of DB_INSERT_CHUNK_SIZE — a single failed chunk
  // (e.g. a genuine DB error) doesn't take down the rest of the batch;
  // it's recorded as a failure per listing in that chunk instead.
  let successCount = 0;

  for (let i = 0; i < toInsert.length; i += DB_INSERT_CHUNK_SIZE) {
    const chunk = toInsert.slice(i, i + DB_INSERT_CHUNK_SIZE);

    let { data, error } = await supabase.from("listings").insert(chunk).select("id");

    if (error && isMissingColumnError(error)) {
      console.warn(
        "[bulk-import] Optional columns not found on this database yet — retrying without them. Run the latest supabase/schema.sql.",
      );
      ({ data, error } = await supabase
        .from("listings")
        .insert(chunk.map((row) => withoutOptionalFields(row)))
        .select("id"));
    }

    if (error) {
      console.error("[bulk-import] Batch insert failed:", error);
      for (const row of chunk) {
        failures.push({
          url: typeof row.product_url === "string" ? row.product_url : "(unknown url)",
          error: error.message,
        });
      }
      continue;
    }

    // Best-effort, never blocks this import — each call already catches
    // its own failures (see generateAndSaveListingEmbedding's own
    // comment, src/lib/listing-embeddings.ts). `data` is index-aligned
    // with `chunk` (a single insert statement's returned rows preserve
    // insert order), which is how each inserted id gets paired back up
    // with that same row's own image_url.
    const insertedWithImages = (data ?? []).map((inserted, index) => ({
      id: inserted.id,
      imageUrl: chunk[index]?.image_url ?? null,
    }));
    await mapWithConcurrency(insertedWithImages, EMBEDDING_CONCURRENCY, (row) =>
      generateAndSaveListingEmbedding(row.id, row.imageUrl),
    );

    successCount += data?.length ?? 0;
  }

  // runningCategoryCounts assumes every row in toInsert actually made it in
  // — a simplification in the rare case a DB error above failed part of a
  // chunk: the returned counts could drift slightly high for whatever
  // category that row belonged to. Not worth reconciling exactly for an
  // already-exceptional error path; the next batch's balance tie-break just
  // starts from a marginally more conservative baseline.
  return {
    successCount,
    failedCount: failures.length,
    duplicateCount,
    qualityRejectedCount,
    priceRejectedCount,
    categoryRejectedCount,
    brandRejectedCount,
    categoryCounts: runningCategoryCounts,
    failures,
  };
}
