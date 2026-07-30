// Not yet implemented, and deliberately not scraping-based — same
// finding as src/lib/marketplaces/poshmark.ts's live-search stub:
// Poshmark has no public search/catalog API for third parties, and its
// Terms of Service prohibit automated access. This provider is
// scaffolding for a future, LEGITIMATE source of Poshmark data (e.g. a
// partner data feed, if one is ever offered), not a scraper waiting to
// be filled in.
import { buildSearchableText } from "../shared";
import type { IngestionProvider, NormalizedMarketplaceListing, RawMarketplaceListing } from "../types";

export const poshmarkProvider: IngestionProvider = {
  source: "poshmark",

  async discoverListings(): Promise<RawMarketplaceListing[]> {
    console.log(
      "[Marketplace Search] Poshmark ingestion unavailable: no legitimate data source (see src/lib/marketplace-ingestion/providers/poshmark.ts)",
    );
    return [];
  },

  normalizeListing(raw: RawMarketplaceListing): NormalizedMarketplaceListing {
    return {
      sourcePlatform: "poshmark",
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
