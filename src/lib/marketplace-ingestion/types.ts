// Shared contract for the marketplace ingestion architecture — the
// AHEAD-OF-TIME counterpart to src/lib/marketplace-search.ts's live,
// per-request provider fan-out. See supabase/schema.sql's own
// `marketplace_listings` header comment for how the two relate.
//
// Nothing in this directory calls out to a live marketplace over the
// network except src/lib/marketplace-ingestion/providers/reworn.ts (a
// read of this app's OWN already-owned `listings` table) and
// providers/ebay.ts (eBay's official Browse API, same integration
// src/lib/marketplaces/ebay.ts already uses for live search) — see
// providers/depop.ts, vinted.ts, poshmark.ts, mercari.ts for why those
// four remain documented, not-yet-implemented placeholders rather than
// working ingesters.
import type { DetectedGarment, GarmentCategory } from "@/lib/garment-detection";
import type { MarketplaceSource } from "@/lib/marketplaces/types";

export type { MarketplaceSource };

// The shape one provider's discoverListings() produces — deliberately
// close to src/lib/extraction/normalize-listing.ts's own
// ExtractedListing (same title/description/images/price/category/brand/
// url fields), but a separate type: that file's shape is specific to
// scraped-HTML extraction for Lockette's own `listings` table, while this
// one has to cover every source's own listing shape (including sources
// fetched via a real API response, not scraped HTML) and adds the field
// specific to this table (externalId, this source's own concept of
// buyable/sold availability).
export interface RawMarketplaceListing {
  // The source's own listing identifier — required so
  // src/lib/marketplace-ingestion/store.ts can upsert on
  // (source_platform, external_id) instead of ever inserting duplicates.
  externalId: string;
  title: string;
  description: string | null;
  images: string[];
  price: number | null;
  // Raw, as reported by the source — not assumed to match this app's own
  // GarmentCategory vocabulary (see NormalizedMarketplaceListing's own
  // detectedCategory field).
  category: string | null;
  brand: string | null;
  url: string;
  availability: "available" | "unavailable";
}

// Structured, per-item detail in the same shape DetectedGarment already
// uses (src/lib/garment-detection.ts) — minus `category` (a listing's
// detectedCategory is its own top-level field, same as `listings.category`
// sits next to `listings.matched_style`) and minus `searchQueries` (a
// runtime-only field for live search, not something a stored, indexed
// listing needs to keep). Reusing DetectedGarment's own fields here
// (rather than redeclaring a parallel shape) is what keeps
// src/lib/listing-enrichment.ts's output a straight write into this
// column, with no remapping.
export type GarmentAttributes = Omit<DetectedGarment, "category" | "searchQueries">;

// The shape one provider's normalizeListing() produces — the in-memory,
// logical form of a marketplace_listings row (supabase/schema.sql).
// src/lib/marketplace-ingestion/store.ts maps this 1:1 onto
// MarketplaceListingInsert (src/lib/supabase/marketplace-listings.types.ts)
// — kept as a separate type from that DB-generated one so this directory
// never has to import Supabase-generated types just to describe "what a
// provider hands back."
export interface NormalizedMarketplaceListing {
  sourcePlatform: MarketplaceSource;
  externalId: string;
  title: string;
  description: string | null;
  images: string[];
  price: number | null;
  category: string | null;
  brand: string | null;
  url: string;
  availability: "available" | "unavailable";
  searchableText: string;
  // AI enrichment (src/lib/listing-enrichment.ts) — undefined until that
  // step actually runs for a given listing, never a fabricated guess.
  detectedCategory?: GarmentCategory | null;
  garmentAttributes?: GarmentAttributes | null;
  imageEmbedding?: number[] | null;
}

// One adapter per marketplace (src/lib/marketplace-ingestion/providers/)
// — deliberately NOT parameterized by a search query the way
// MarketplaceSearchProvider (src/lib/marketplaces/types.ts) is: this is
// an ahead-of-time bulk crawl/import, the same "no query, no live user
// request in the loop" shape src/lib/admin-scraper.ts's own scraper
// already uses for Lockette's own inventory.
export interface IngestionProvider {
  source: MarketplaceSource;
  discoverListings(options?: { limit?: number }): Promise<RawMarketplaceListing[]>;
  normalizeListing(raw: RawMarketplaceListing): NormalizedMarketplaceListing;
}

// One run of runIngestionSource() (registry.ts) — mirrors the
// ingestion_jobs row it gets persisted into.
export interface IngestionResult {
  source: MarketplaceSource;
  listingsFound: number;
  listingsImported: number;
  errors: string[];
}
