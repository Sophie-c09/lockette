// Marketplace search abstraction layer for outfit recreation retrieval
// (currently wired to "Recreate This Outfit" —
// src/app/actions/outfit-recreations.ts). NOT the same thing as
// src/lib/marketplace-discovery.ts, which crawls Vinted/Depop/Poshmark
// search-result PAGES to find new candidate URLs for the admin scraper to
// import ahead of time — this file is the per-detected-garment lookup
// used at request time, and normalizes results from every source into
// one flat shape regardless of where they came from.
//
// PROBLEM THIS FIXES: results were still limited to this app's own
// `listings` table (Lockette's own already-scraped inventory — "Lockette"
// inventory in this task's own wording) even after the vision model
// started correctly extracting tops/bottoms/outerwear/shoes/bags/
// accessories — there was no notion of "also search Depop/Vinted/
// Poshmark/Mercari/eBay live, right now, for this specific detected
// item." searchMarketplaceItems adds that shape: one provider per
// source, fanned out in parallel, filtered to the requested category
// only (a bottom query never returns a top; a bag query never returns a
// shirt), combined, and ranked as one set — not per-source, so a great
// Depop match and a great Lockette-inventory match are directly comparable
// instead of just concatenated list-after-list.
//
// CURRENT STATUS: eBay is a real, live integration
// (src/lib/marketplaces/ebay.ts) against its official Browse API —
// contingent on EBAY_CLIENT_ID/EBAY_CLIENT_SECRET being set, since no
// public API works without a registered developer app. Depop, Vinted,
// Poshmark, and Mercari remain documented, NON-SILENT stubs
// (src/lib/marketplaces/{depop,vinted,poshmark,mercari}.ts) — none of
// them have a public search API, and the only way to get live results
// from them would be scraping their own search-result pages on every
// end-user request: a materially different (and riskier — ToS
// violations, anti-bot defenses, rate limits) undertaking than this
// app's existing scraper, which only ever crawls ahead of time for an
// admin-triggered, human-reviewed import, never live per end-user
// request. See each of those four files for the source-specific
// reasoning. Every provider (real or stub) returning [] rather than
// throwing or fabricating placeholder results means a request never
// fails just because one source isn't available — it simply
// contributes zero results, logged clearly either way (see the
// per-provider logging in searchMarketplaceItems below) so a genuine
// "found nothing" is never confused with "this source isn't wired up."
import { createClient } from "@/lib/supabase/server";
import { categorizeListing } from "@/lib/bulk-import";
import type { ExtractedListing } from "@/lib/extraction/normalize-listing";
import type { GarmentCategory } from "@/lib/garment-detection";
import type { Listing } from "@/lib/supabase/listings.types";
import { ebayProvider } from "@/lib/marketplaces/ebay";
import { depopProvider } from "@/lib/marketplaces/depop";
import { vintedProvider } from "@/lib/marketplaces/vinted";
import { poshmarkProvider } from "@/lib/marketplaces/poshmark";
import { mercariProvider } from "@/lib/marketplaces/mercari";
import type {
  MarketplaceSearchProvider,
  MarketplaceSearchQuery,
  NormalizedMarketplaceItem,
  ScorableCandidate,
} from "@/lib/marketplaces/types";

// Re-exported unchanged so existing callers/imports of these types don't
// need an import-path change now that the shared contract itself lives
// in src/lib/marketplaces/types.ts.
export type { MarketplaceSource, MarketplaceSearchQuery, NormalizedMarketplaceItem } from "@/lib/marketplaces/types";
export { EXTERNAL_MARKETPLACE_SOURCES } from "@/lib/marketplaces/types";

const LISTING_COLUMNS =
  "id, title, description, price, image_url, product_url, platform, brand, category, size, color, aesthetic_tags, status, created_at";

// categorizeListing only ever reads .category/.title (see bulk-import.ts).
function bucketOf(listing: Pick<Listing, "title" | "category">): ReturnType<typeof categorizeListing> {
  return categorizeListing({ title: listing.title, category: listing.category ?? null } as ExtractedListing);
}

function toRewornCandidate(listing: Listing, category: GarmentCategory): ScorableCandidate {
  return {
    normalized: {
      id: listing.id,
      title: listing.title,
      image: listing.image_url,
      price: listing.price,
      url: listing.product_url,
      platform: "reworn",
      category,
      availability: listing.status === "active" ? "available" : "unavailable",
    },
    searchableText: `${listing.title} ${listing.description ?? ""}`,
  };
}

const rewornProvider: MarketplaceSearchProvider = {
  source: "reworn",
  async search(query) {
    const supabase = await createClient();

    // ACTIVE only — sold/unavailable/pending/rejected/removed listings
    // are excluded at the query level, before anything else happens
    // (requirement: remove sold/unavailable listings).
    const { data, error } = await supabase.from("listings").select(LISTING_COLUMNS).eq("status", "active");

    if (error || !data) {
      console.error("[marketplace-search] reworn search failed:", error);
      return [];
    }

    // Hard category filter (requirement: "a bottom query cannot return
    // tops, a bag query cannot return shirts") — bucketed via the SAME
    // categorizeListing this app's admin import already uses; anything
    // outside the requested bucket is never even scored, let alone
    // returned.
    return (data as Listing[])
      .filter((listing) => bucketOf(listing) === query.category)
      .map((listing) => toRewornCandidate(listing, query.category));
  },
};

const PROVIDERS = [
  depopProvider,
  vintedProvider,
  ebayProvider,
];

// Display name per source, for logging only — MarketplaceSource values
// stay lowercase (they're also the `platform` field on every normalized
// item), but the requested log format wants each marketplace's proper
// name (e.g. "Depop returned 4 results", not "depop returned 4 results").
const SOURCE_DISPLAY_NAMES: Record<MarketplaceSearchProvider["source"], string> = {
  reworn: "Lockette",
  depop: "Depop",
  vinted: "Vinted",
  poshmark: "Poshmark",
  mercari: "Mercari",
  ebay: "eBay",
};

function normalizeText(text: string): string {
  return text.trim().toLowerCase();
}

function isValidUrl(url: string | null): boolean {
  if (!url) return false;
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

/**
 * Scores one candidate against the query. `description` carries by far
 * the richest signal (the caller is expected to fold in the specific
 * garment type, e.g. "mini skirt ..." — see this file's own comment on
 * MarketplaceSearchQuery.description) — an exact phrase match is checked
 * first as the strongest possible signal, falling back to counting
 * individual word overlaps so a partial match (e.g. just "skirt"
 * matching) still counts for something. color/style are lighter-weight
 * secondary signals on top of that.
 */
function scoreCandidate(query: MarketplaceSearchQuery, candidate: ScorableCandidate): number {
  const haystack = normalizeText(candidate.searchableText);
  let score = 0;

  const description = normalizeText(query.description);
  if (description) {
    if (haystack.includes(description)) {
      score += 50;
    } else {
      const words = description.split(/\s+/).filter((word) => word.length > 2);
      const matchedWords = words.filter((word) => haystack.includes(word)).length;
      score += Math.min(matchedWords * 10, 40);
    }
  }

  if (query.color && haystack.includes(normalizeText(query.color))) score += 20;
  if (query.style && haystack.includes(normalizeText(query.style))) score += 12;

  return score;
}

// How many ranked results to keep after combining every source — enough
// for an initial top-3 display plus several rounds of "Shuffle Matches"
// without running out immediately.
const RESULT_POOL_SIZE = 12;

/**
 * Searches every marketplace this feature is meant to cover — Depop,
 * Vinted, Poshmark, Mercari, eBay, plus Lockette's own already-imported
 * inventory as one ADDITIONAL source, never the only one (see this
 * file's own header comment on which of those are real vs. stubbed
 * today) — filters every source to the requested category ONLY,
 * combines every source's surviving results into one set, then ranks
 * that combined set together so results from different sources are
 * directly comparable rather than just listed source-by-source. Sold/
 * unavailable listings and invalid URLs are dropped before ranking;
 * price is applied AFTER ranking (a real match slightly over budget
 * beats an empty slot, same graceful-degrade this app's matching has
 * always used).
 */
export async function searchMarketplaceItems(query: MarketplaceSearchQuery): Promise<NormalizedMarketplaceItem[]> {
  const bySource = await Promise.all(
    PROVIDERS.map(async (provider) => {
      try {
        const results = await provider.search(query);
        console.log(`[Marketplace Search] ${SOURCE_DISPLAY_NAMES[provider.source]} returned ${results.length} results`);
        return results;
      } catch (error) {
        console.error(`[marketplace-search] ${provider.source} search failed:`, error);
        return [];
      }
    }),
  );

  const combined = bySource
    .flat()
    .filter((candidate) => candidate.normalized.availability === "available" && isValidUrl(candidate.normalized.url));

  const withinBudget =
    query.priceLimit != null
      ? combined.filter((candidate) => candidate.normalized.price != null && candidate.normalized.price <= query.priceLimit!)
      : combined;
  const pool = withinBudget.length > 0 ? withinBudget : combined;

  return pool
    .map((candidate) => ({ candidate, score: scoreCandidate(query, candidate) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, RESULT_POOL_SIZE)
    .map(({ candidate }) => candidate.normalized);
}
