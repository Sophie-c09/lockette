// eBay as an ingestion source — the other real, fully-working adapter in
// this directory (see providers/reworn.ts for the other, and
// depop.ts/vinted.ts/poshmark.ts/mercari.ts for why the rest are
// placeholders). Deliberately does NOT reimplement eBay's OAuth/search
// plumbing: src/lib/marketplaces/ebay.ts already has that (used for live,
// per-request Recreate This Look search), so this file just calls it —
// one broad sweep per GarmentCategory instead of one query per detected
// garment, which is the "ahead of time, not per live request" difference
// between ingestion and live search (see this directory's own
// types.ts header comment). Still needs EBAY_CLIENT_ID/EBAY_CLIENT_SECRET
// (see marketplaces/ebay.ts) — without them this returns [] via that
// same file's own logging, nothing new to duplicate here.
import { GARMENT_CATEGORIES } from "@/lib/garment-detection";
import { ebayProvider as liveEbaySearchProvider } from "@/lib/marketplaces/ebay";
import { buildSearchableText } from "../shared";
import type { IngestionProvider, NormalizedMarketplaceListing, RawMarketplaceListing } from "../types";

function toRawListing(candidate: Awaited<ReturnType<typeof liveEbaySearchProvider.search>>[number]): RawMarketplaceListing {
  const { normalized } = candidate;
  return {
    externalId: normalized.id,
    title: normalized.title,
    // NormalizedMarketplaceItem (src/lib/marketplaces/types.ts) is
    // deliberately flat and doesn't carry a separate description field —
    // see that file's own header comment on why.
    description: null,
    images: normalized.image ? [normalized.image] : [],
    price: normalized.price,
    category: normalized.category,
    brand: null,
    url: normalized.url ?? "",
    availability: normalized.availability,
  };
}

export const ebayProvider: IngestionProvider = {
  source: "ebay",

  async discoverListings(options = {}): Promise<RawMarketplaceListing[]> {
    const limit = options.limit ?? GARMENT_CATEGORIES.length * 5;
    const perCategory = Math.max(1, Math.ceil(limit / GARMENT_CATEGORIES.length));

    const bySource = await Promise.all(
      GARMENT_CATEGORIES.map(async (category) => {
        try {
          const candidates = await liveEbaySearchProvider.search({
            category,
            description: category,
            color: "",
            style: "",
            priceLimit: null,
          });
          return candidates.slice(0, perCategory);
        } catch (error) {
          console.error(`[Marketplace Search] eBay ingestion sweep for "${category}" failed:`, error);
          return [];
        }
      }),
    );

    return bySource
      .flat()
      .map(toRawListing)
      .filter((listing) => listing.url !== "");
  },

  normalizeListing(raw: RawMarketplaceListing): NormalizedMarketplaceListing {
    return {
      sourcePlatform: "ebay",
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
