// Not yet implemented, and deliberately not scraping-based — same
// finding as src/lib/marketplaces/depop.ts's live-search stub: Depop has
// no public search/catalog API, and a live test against its internal
// webapi.depop.com search endpoint returned an immediate HTTP 403 from
// Cloudflare's bot-management layer (not a rate limit — a block on the
// very first request), plus Depop's Terms of Service prohibit automated
// access. Getting past that would mean building real anti-bot-evasion
// tooling (stealth headless browser, proxy rotation) against another
// company's live production security controls — not something this
// codebase takes on (see src/lib/marketplaces/depop.ts's own header for
// the full reasoning). This provider is scaffolding for a future,
// LEGITIMATE source of Depop data (e.g. if Depop ever ships a partner/
// catalog API), not a scraper waiting to be filled in.
import { buildSearchableText } from "../shared";
import type { IngestionProvider, NormalizedMarketplaceListing, RawMarketplaceListing } from "../types";

export const depopProvider: IngestionProvider = {
  source: "depop",

  async discoverListings(): Promise<RawMarketplaceListing[]> {
    console.log(
      "[Marketplace Search] Depop ingestion unavailable: no legitimate data source (see src/lib/marketplace-ingestion/providers/depop.ts)",
    );
    return [];
  },

  normalizeListing(raw: RawMarketplaceListing): NormalizedMarketplaceListing {
    // Never actually called today (discoverListings always returns []),
    // but implemented for real so this provider satisfies the same
    // IngestionProvider contract every other source does.
    return {
      sourcePlatform: "depop",
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
