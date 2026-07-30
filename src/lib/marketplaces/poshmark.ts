// Poshmark has no public search API. As with Depop/Vinted
// (src/lib/marketplaces/depop.ts, vinted.ts), the only way to get live
// results would be scraping Poshmark's own search-result pages per
// end-user request — a materially riskier, different undertaking than
// this app's existing admin-triggered, ahead-of-time scraper
// (src/lib/admin-scraper.ts, src/lib/marketplace-discovery.ts), and one
// Poshmark's Terms of Service prohibit. See
// src/lib/marketplace-search.ts's own header comment for the same
// reasoning applied across all four no-API sources.
//
// This is a documented, NON-SILENT stub: it always returns [], but every
// call logs exactly why, so an empty Poshmark result is never mistaken
// for "Poshmark was searched and genuinely found nothing."
import type { MarketplaceSearchProvider, ScorableCandidate } from "./types";

export const poshmarkProvider: MarketplaceSearchProvider = {
  source: "poshmark",
  async search(): Promise<ScorableCandidate[]> {
    console.log(
      "[Marketplace Search] Poshmark unavailable — no public search API; live scraping not implemented (see src/lib/marketplaces/poshmark.ts)",
    );
    return [];
  },
};
