// Real, working database plumbing for the ingestion architecture — pure
// upsert into `marketplace_listings` (supabase/schema.sql), no scraping
// or fetching of any kind. Kept separate from each provider (network/DB
// read + normalization, no writes to this table) so this is the one
// place that ever writes to marketplace_listings.
import { createAdminClient } from "@/lib/supabase/admin";
import type {
  MarketplaceListingInsert,
  MarketplaceListingsDatabase,
} from "@/lib/supabase/marketplace-listings.types";
import type { NormalizedMarketplaceListing } from "./types";

// Service-role, not the normal request-scoped createClient() —
// marketplace_listings has no authenticated-role write policy (see
// supabase/schema.sql's own comment on that table), same reasoning
// src/lib/bulk-import.ts's saveListing already established for
// `listings` itself.
function adminClient() {
  return createAdminClient<MarketplaceListingsDatabase>();
}

function toInsertRow(listing: NormalizedMarketplaceListing): MarketplaceListingInsert {
  return {
    source_platform: listing.sourcePlatform,
    external_id: listing.externalId,
    title: listing.title,
    description: listing.description,
    images: listing.images,
    price: listing.price,
    category: listing.category,
    brand: listing.brand,
    url: listing.url,
    availability: listing.availability,
    searchable_text: listing.searchableText,
    detected_category: listing.detectedCategory ?? null,
    garment_attributes: listing.garmentAttributes ?? null,
    image_embedding: listing.imageEmbedding ?? null,
  };
}

export interface UpsertResult {
  count: number;
  error?: string;
}

/**
 * Upserts one batch of normalized listings, keyed on the
 * (source_platform, external_id) unique index — re-ingesting a listing
 * that's already indexed updates it in place instead of creating a
 * duplicate row.
 */
export async function upsertIndexedListings(listings: NormalizedMarketplaceListing[]): Promise<UpsertResult> {
  if (listings.length === 0) return { count: 0 };

  const supabase = adminClient();
  const rows = listings.map(toInsertRow);

  const { data, error } = await supabase
    .from("marketplace_listings")
    .upsert(rows, { onConflict: "source_platform,external_id" })
    .select("id");

  if (error) {
    console.error("[marketplace-ingestion] upsert failed:", error);
    return { count: 0, error: error.message };
  }

  return { count: data?.length ?? 0 };
}
