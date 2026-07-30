// Real eBay Browse API integration — the only one of the 5 previously-
// stubbed external marketplaces with an official, public search API, so
// it's the only one implemented as a live call rather than a documented
// stub (see depop.ts/vinted.ts/poshmark.ts/mercari.ts for why those four
// stay stubs).
//
// Needs a registered eBay Developer application (developer.ebay.com,
// Browse API + OAuth "client credentials" grant) and its Client
// ID/Secret in EBAY_CLIENT_ID / EBAY_CLIENT_SECRET. Without both set,
// this provider logs why and returns [] — same "never block or fake a
// search" convention as classifyOutfitPhoto's own SAFE_DEFAULT fallback
// (src/lib/outfit-classification.ts) and this file's own sibling
// providers.
//
// NOT YET LIVE-TESTED: no EBAY_CLIENT_ID/EBAY_CLIENT_SECRET exists in
// this project's .env.local as of this writing. This is built strictly
// against eBay's documented Browse API contract (token endpoint +
// item_summary/search shape) but has not been exercised against a real
// eBay account — verify the actual response shape once credentials
// exist, in case eBay's docs have drifted from current behavior.
//
// CATEGORY FILTERING CAVEAT: eBay's category taxonomy (numeric
// category_ids) doesn't map cleanly onto this app's 7 coarse
// GarmentCategory buckets without a real lookup table (out of scope
// here) — rather than guess a mapping and risk silently wrong filtering,
// the category name is folded into the free-text query instead, and
// this app's own downstream re-ranking (src/lib/garment-similarity-ranking.ts)
// is relied on to push mismatched results down rather than eBay being
// trusted to hard-filter server-side the way Lockette's own provider does.
import type { MarketplaceSearchProvider, MarketplaceSearchQuery, ScorableCandidate } from "./types";

const TOKEN_URL = "https://api.ebay.com/identity/v1/oauth2/token";
const SEARCH_URL = "https://api.ebay.com/buy/browse/v1/item_summary/search";
const OAUTH_SCOPE = "https://api.ebay.com/oauth/api_scope";
const REQUEST_TIMEOUT_MS = 8_000;
const RESULT_LIMIT = 20;

interface CachedToken {
  accessToken: string;
  expiresAt: number; // epoch ms
}

// Module-level cache — the client-credentials token is app-level (not
// per-user), so every search call in this process can share one until it
// expires, instead of fetching a fresh token per request.
let cachedToken: CachedToken | null = null;

async function fetchAccessToken(): Promise<string | null> {
  if (cachedToken && cachedToken.expiresAt > Date.now()) {
    return cachedToken.accessToken;
  }

  const clientId = process.env.EBAY_CLIENT_ID;
  const clientSecret = process.env.EBAY_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    console.log("[Marketplace Search] eBay unavailable — EBAY_CLIENT_ID/EBAY_CLIENT_SECRET not set");
    return null;
  }

  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  try {
    const response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        Authorization: `Basic ${credentials}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ grant_type: "client_credentials", scope: OAUTH_SCOPE }).toString(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      console.error(`[marketplace-search] eBay token request failed: ${response.status}`);
      return null;
    }

    const data = (await response.json()) as { access_token: string; expires_in: number };
    cachedToken = {
      accessToken: data.access_token,
      // Refresh a bit early rather than exactly at expiry.
      expiresAt: Date.now() + (data.expires_in - 60) * 1000,
    };
    return cachedToken.accessToken;
  } catch (error) {
    console.error("[marketplace-search] eBay token request errored:", error);
    return null;
  }
}

interface EbayItemSummary {
  itemId: string;
  title: string;
  image?: { imageUrl: string };
  price?: { value: string; currency: string };
  itemWebUrl: string;
  itemAffiliateWebUrl?: string;
}

interface EbaySearchResponse {
  itemSummaries?: EbayItemSummary[];
}

function toCandidate(item: EbayItemSummary, category: MarketplaceSearchQuery["category"]): ScorableCandidate {
  return {
    normalized: {
      id: `ebay:${item.itemId}`,
      title: item.title,
      image: item.image?.imageUrl ?? null,
      price: item.price ? Number(item.price.value) : null,
      url: item.itemAffiliateWebUrl ?? item.itemWebUrl ?? null,
      platform: "ebay",
      category,
      // The Browse API's search endpoint only ever returns buyable/
      // listed items — there's no separate "sold" state to check here
      // the way Lockette's own `listings.status` column has.
      availability: "available",
    },
    searchableText: item.title,
  };
}

export const ebayProvider: MarketplaceSearchProvider = {
  source: "ebay",
  async search(query: MarketplaceSearchQuery): Promise<ScorableCandidate[]> {
    const token = await fetchAccessToken();
    if (!token) return [];

    const searchText = [query.category, query.description].filter(Boolean).join(" ").trim();
    const params = new URLSearchParams({
      q: searchText || query.category,
      limit: String(RESULT_LIMIT),
    });

    try {
      const response = await fetch(`${SEARCH_URL}?${params.toString()}`, {
        headers: {
          Authorization: `Bearer ${token}`,
          "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (!response.ok) {
        console.error(`[marketplace-search] eBay search failed: ${response.status}`);
        return [];
      }

      const data = (await response.json()) as EbaySearchResponse;
      return (data.itemSummaries ?? []).map((item) => toCandidate(item, query.category));
    } catch (error) {
      console.error("[marketplace-search] eBay search errored:", error);
      return [];
    }
  },
};
