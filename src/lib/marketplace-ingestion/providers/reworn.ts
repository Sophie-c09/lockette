// Lockette's own inventory as an ingestion source — one of the two real,
// fully-working adapters in this directory (see providers/ebay.ts for
// the other, and the remaining four sibling files for why they're
// placeholders): reads already-approved rows straight out of
// `public.listings` and reshapes them into RawMarketplaceListing. No
// network call, no scraping — this is this app's own already-imported
// data, just re-normalized into the unified marketplace_listings shape.
import { createAdminClient } from "@/lib/supabase/admin";
import type { ListingsDatabase } from "@/lib/supabase/listings.types";
import { buildSearchableText } from "../shared";
import type { IngestionProvider, NormalizedMarketplaceListing, RawMarketplaceListing } from "../types";

const LISTING_COLUMNS = "id, title, description, images, image_url, price, category, brand, product_url, status";

interface RewornListingRow {
  id: string;
  title: string;
  description: string | null;
  images: string[] | null;
  image_url: string | null;
  price: number | null;
  category: string | null;
  brand: string | null;
  product_url: string | null;
  status: string;
}

function toRawListing(listing: RewornListingRow): RawMarketplaceListing {
  const images = listing.images && listing.images.length > 0 ? listing.images : listing.image_url ? [listing.image_url] : [];

  return {
    externalId: listing.id,
    title: listing.title,
    description: listing.description,
    images,
    price: listing.price,
    category: listing.category,
    brand: listing.brand,
    // `listings.product_url` is nullable (a user-submitted listing has
    // none — see src/lib/supabase/listings.types.ts) but this table's own
    // `url` column is not; a listing without a real external URL isn't a
    // meaningful marketplace_listings row, so it's skipped by the caller
    // (see discoverListings() below) rather than stored with a
    // fabricated URL.
    url: listing.product_url ?? "",
    availability: listing.status === "active" ? "available" : "unavailable",
  };
}

export const rewornProvider: IngestionProvider = {
  source: "reworn",

  async discoverListings(options = {}): Promise<RawMarketplaceListing[]> {
    const supabase = createAdminClient<ListingsDatabase>();

    let query = supabase.from("listings").select(LISTING_COLUMNS).eq("status", "active");
    if (options.limit) {
      query = query.limit(options.limit);
    }

    const { data, error } = await query;

    if (error) {
      console.error("[Marketplace Search] Lockette ingestion unavailable:", error.message);
      return [];
    }

    return (data as RewornListingRow[]).map(toRawListing).filter((listing) => listing.url !== "");
  },

  normalizeListing(raw: RawMarketplaceListing): NormalizedMarketplaceListing {
    return {
      sourcePlatform: "reworn",
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
