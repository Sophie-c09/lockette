// Vinted has no public search API. As with Depop (src/lib/marketplaces/depop.ts),
// the only way to get live results would be scraping Vinted's own
// search-result pages per end-user request, which Vinted's Terms of
// Service prohibit and which is a materially riskier, different
// undertaking than this app's existing admin-triggered, ahead-of-time
// scraper (src/lib/admin-scraper.ts, src/lib/marketplace-discovery.ts).
// See src/lib/marketplace-search.ts's own header comment for the same
// reasoning applied across all four no-API sources.
//
// This is a documented, NON-SILENT stub: it always returns [], but every
// call logs exactly why, so an empty Vinted result is never mistaken for
// "Vinted was searched and genuinely found nothing."
import type { MarketplaceSearchProvider, ScorableCandidate } from "./types";

export const vintedProvider: MarketplaceSearchProvider = {
  source: "vinted",
  async search(): Promise<ScorableCandidate[]> {
    console.log(
      "[Marketplace Search] Vinted unavailable — no public search API; live scraping not implemented (see src/lib/marketplaces/vinted.ts)",
    );
    return [];
  },
};
