// Depop has no public search API. The only way to get live results
// would be scraping Depop's own search-result pages on every end-user
// request — a fundamentally different (and riskier) undertaking than
// this app's existing admin-triggered, ahead-of-time scraper
// (src/lib/admin-scraper.ts, src/lib/marketplace-discovery.ts), which
// only ever crawls ahead of a human-reviewed import, never live per
// request. Depop's Terms of Service prohibit automated/bot access, and
// building infrastructure whose whole purpose is repeated, automated,
// per-request scraping of a site that disallows it is a risk this
// codebase doesn't take on (see src/lib/marketplace-search.ts's own
// header comment for the same reasoning applied across all four
// no-API sources).
//
// This is a documented, NON-SILENT stub: it always returns [], but every
// call logs exactly why, so an empty Depop result is never mistaken for
// "Depop was searched and genuinely found nothing" — that distinction
// matters for anyone debugging a thin result set later.
import type { MarketplaceSearchProvider, ScorableCandidate } from "./types";

export const depopProvider: MarketplaceSearchProvider = {
  source: "depop",
  async search(): Promise<ScorableCandidate[]> {
    console.log(
      "[Marketplace Search] Depop unavailable — no public search API; live scraping not implemented (see src/lib/marketplaces/depop.ts)",
    );
    return [];
  },
};
