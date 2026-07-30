// Shared contract every marketplace provider (this directory) implements
// — moved out of src/lib/marketplace-search.ts so each provider file can
// import it without a circular dependency back on that file. That file
// re-exports the public members (MarketplaceSearchQuery,
// NormalizedMarketplaceItem, MarketplaceSource, EXTERNAL_MARKETPLACE_SOURCES)
// unchanged, so existing callers (src/app/actions/outfit-recreations.ts)
// don't need an import-path change.
import type { GarmentCategory } from "@/lib/garment-detection";

export type MarketplaceSource = "reworn" | "depop" | "vinted" | "poshmark" | "mercari" | "ebay";

export const EXTERNAL_MARKETPLACE_SOURCES: Exclude<MarketplaceSource, "reworn">[] = [
  "depop",
  "vinted",
  "poshmark",
  "mercari",
  "ebay",
];

export interface MarketplaceSearchQuery {
  // Hard filter, not just a scoring input — a bottom query cannot return
  // tops. Every provider is responsible for only ever returning items
  // already in this category (or, where a source has no reliable way to
  // filter server-side — e.g. eBay's category taxonomy doesn't map 1:1
  // onto this app's own buckets — folding the category into the search
  // text and leaning on this app's own downstream re-ranking instead;
  // see each provider's own header comment).
  category: GarmentCategory;
  // Free text — the caller is expected to fold in whatever specific
  // detail it has (garment type, pattern, material, silhouette, era,
  // resale search terms, etc.) since this interface only takes one
  // description field, not a fully structured DetectedGarment.
  description: string;
  color: string;
  // Free text — a style/aesthetic descriptor (e.g. aesthetic tags
  // joined into one string). Used as a lighter-weight scoring signal
  // than description/color.
  style: string;
  // null = no ceiling.
  priceLimit: number | null;
}

// Unified shape for a result from ANY source, including Lockette's own
// inventory — deliberately flat and source-agnostic (no full Listing
// leaking through here) so a caller never needs to branch on where a
// result came from just to read its title/price/etc. A caller that also
// needs the FULL Lockette Listing (e.g. to render this app's own listing
// card/detail page) looks it up separately by `id` when `platform ===
// "reworn"` — see outfit-recreations.ts's own comment on why that lookup
// stays in the caller instead of this abstraction.
export interface NormalizedMarketplaceItem {
  id: string;
  title: string;
  image: string | null;
  price: number | null;
  url: string | null;
  platform: MarketplaceSource;
  category: GarmentCategory;
  availability: "available" | "unavailable";
}

// Internal-only — carries the extra freeform text (title + description)
// each provider's own source data has, so scoring can use more than just
// the fields NormalizedMarketplaceItem exposes publicly. Never returned
// from searchMarketplaceItems itself.
export interface ScorableCandidate {
  normalized: NormalizedMarketplaceItem;
  searchableText: string;
}

export interface MarketplaceSearchProvider {
  source: MarketplaceSource;
  search(query: MarketplaceSearchQuery): Promise<ScorableCandidate[]>;
}
