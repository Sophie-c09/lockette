// Not yet implemented, and deliberately not scraping-based — same
// finding as src/lib/marketplaces/mercari.ts's live-search stub: Mercari
// has no current public search/catalog API (its legacy API is
// restricted to approved partners this project isn't registered as), and
// its Terms of Service prohibit automated access. This provider is
// scaffolding for a future, LEGITIMATE source of Mercari data, not a
// scraper waiting to be filled in.
import { buildSearchableText } from "../shared";
import type { IngestionProvider, NormalizedMarketplaceListing, RawMarketplaceListing } from "../types";

export const mercariProvider: IngestionProvider = {
  source: "mercari",

  async discoverListings(): Promise<RawMarketplaceListing[]> {
    console.log(
      "[Marketplace Search] Mercari ingestion unavailable: no legitimate data source (see src/lib/marketplace-ingestion/providers/mercari.ts)",
    );
    return [];
  },

  normalizeListing(raw: RawMarketplaceListing): NormalizedMarketplaceListing {
    return {
      sourcePlatform: "mercari",
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
