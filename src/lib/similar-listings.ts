// "More Like This" — other listings sharing the most aesthetic_tags with
// the one currently being viewed (src/app/(app)/listing/[id]/page.tsx).
//
// This used to call a database-side Postgres function
// (public.similar_listings, still defined in supabase/schema.sql) so the
// "most shared tags first" ordering could be a single computed-overlap
// ORDER BY — PostgREST's plain filter-builder can express the overlap
// filter alone (.overlaps(), as discover-feed.ts already does) but has no
// way to order by a computed count. That function was never actually
// created on the live database (confirmed directly: calling it returns
// PGRST202, "function not found in the schema cache"), so every call fell
// back to an empty result. Rather than adding that migration, this fetches
// a wider pool of tag-overlapping listings with a plain query and computes
// the "most shared tags" ordering here in JS instead — no database object
// beyond the plain `listings` table is required.
import { createClient } from "@/lib/supabase/server";
import type { Listing } from "@/lib/supabase/listings.types";

const SIMILAR_LISTINGS_LIMIT = 10;

// How many tag-overlapping candidates to pull before ranking — comfortably
// more than the final limit so the "most shared tags" sort has a real pool
// to choose from, not just whatever 10 rows happened to come back first.
const SIMILAR_LISTINGS_POOL_SIZE = 40;

const SIMILAR_LISTINGS_COLUMNS =
  "id, title, description, price, image_url, product_url, platform, brand, size, aesthetic_tags, created_at";

function sharedTagCount(listingTags: string[], viewedTags: string[]): number {
  const viewedTagSet = new Set(viewedTags);
  return listingTags.reduce((count, tag) => count + (viewedTagSet.has(tag) ? 1 : 0), 0);
}

/**
 * Fetches up to 10 other listings ordered by most shared aesthetic_tags
 * first (ties broken by newest), optionally capped to `maxPrice` (the
 * "Find Similar" item-level budget selector — src/lib/budget-options.ts;
 * null/omitted means no cap, same as before this feature existed). The 10
 * returned here are a pool for the caller's own "top 3" display + Shuffle
 * to draw from (src/app/actions/similar-listings.ts,
 * src/components/listing/SimilarListingsPanel.tsx) — a hard ceiling
 * applied server-side rather than filtered client-side, so a shuffle can
 * never surface something outside the selected budget. Returns [] (never
 * throws) if the listing has no tags to match on, or if the query fails
 * for any reason — "More Like This" is a discovery aid, not something that
 * should ever break the listing detail page.
 */
export async function fetchSimilarListings(
  listingId: string,
  aestheticTags: string[],
  maxPrice: number | null = null,
): Promise<Listing[]> {
  if (aestheticTags.length === 0) return [];

  const supabase = await createClient();
  let query = supabase
    .from("listings")
    .select(SIMILAR_LISTINGS_COLUMNS)
    .neq("id", listingId)
    .eq("status", "active")
    .overlaps("aesthetic_tags", aestheticTags);

  if (maxPrice != null) {
    query = query.lte("price", maxPrice);
  }

  const { data, error } = await query
    .order("created_at", { ascending: false })
    .limit(SIMILAR_LISTINGS_POOL_SIZE);

  if (error) {
    console.error("[similar-listings]", error);
    return [];
  }

  const candidates = (data ?? []) as Listing[];

  // Array.prototype.sort is stable, and `candidates` already arrived
  // ordered newest-first — so ties in shared-tag count keep that relative
  // order, matching the original SQL function's `order by shared desc,
  // created_at desc` exactly.
  return candidates
    .map((listing) => ({ listing, shared: sharedTagCount(listing.aesthetic_tags, aestheticTags) }))
    .sort((a, b) => b.shared - a.shared)
    .slice(0, SIMILAR_LISTINGS_LIMIT)
    .map(({ listing }) => listing);
}
