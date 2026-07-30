// Mercari has no current public search API (its legacy API is restricted
// to approved partners this project isn't registered as). As with Depop/
// Vinted/Poshmark (src/lib/marketplaces/depop.ts, vinted.ts, poshmark.ts),
// the only way to get live results would be scraping Mercari's own
// search-result pages per end-user request — a materially riskier,
// different undertaking than this app's existing admin-triggered,
// ahead-of-time scraper (src/lib/admin-scraper.ts,
// src/lib/marketplace-discovery.ts), and one Mercari's Terms of Service
// prohibit. See src/lib/marketplace-search.ts's own header comment for
// the same reasoning applied across all four no-API sources.
//
// This is a documented, NON-SILENT stub: it always returns [], but every
// call logs exactly why, so an empty Mercari result is never mistaken
// for "Mercari was searched and genuinely found nothing."
import type { MarketplaceSearchProvider, ScorableCandidate } from "./types";

export const mercariProvider: MarketplaceSearchProvider = {
  source: "mercari",
  async search(): Promise<ScorableCandidate[]> {
    console.log(
      "[Marketplace Search] Mercari unavailable — no public search API; live scraping not implemented (see src/lib/marketplaces/mercari.ts)",
    );
    return [];
  },
};
