// Not yet implemented, and deliberately not scraping-based — same
// finding as src/lib/marketplaces/vinted.ts's live-search stub: Vinted
// has no public search/catalog API, and a live test against its internal
// api/v2/catalog/items endpoint returned an immediate HTTP 401 (invalid
// bearer token) gated behind Cloudflare bot management — getting a valid
// token requires reverse-engineering an internal, undocumented session
// flow, and Vinted's Terms of Service prohibit automated access anyway.
// Same "not building anti-bot-evasion tooling against another company's
// production infrastructure" line this codebase draws elsewhere (see
// src/lib/marketplaces/vinted.ts's own header for the full reasoning).
// This provider is scaffolding for a future, LEGITIMATE source of Vinted
// data, not a scraper waiting to be filled in.
import { buildSearchableText } from "../shared";
import type { IngestionProvider, NormalizedMarketplaceListing, RawMarketplaceListing } from "../types";

export const vintedProvider: IngestionProvider = {
  source: "vinted",

  async discoverListings(): Promise<RawMarketplaceListing[]> {
    console.log(
      "[Marketplace Search] Vinted ingestion unavailable: no legitimate data source (see src/lib/marketplace-ingestion/providers/vinted.ts)",
    );
    return [];
  },

  normalizeListing(raw: RawMarketplaceListing): NormalizedMarketplaceListing {
    return {
      sourcePlatform: "vinted",
      externalId: raw.externalId,
      title: raw.title,
      description: raw.description,
      images: raw.images,
      price: raw.price,
      category: raw.category,
      brand: raw.brand,
      url: raw.url,
      availability: raw.availability,
      searchableText: buildSearchableText(raw),
    };
  },
};
