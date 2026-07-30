// Hybrid image + semantic search upgrade for Discover — an ADDITIVE
// retrieval path layered on top of fetchDiscoverBatch's existing
// text-based search (discover-feed.ts), never replacing it:
// searchDiscoverByImageEmbedding below is only ever called when a user
// uploads an inspiration photo (searchDiscoverByPhoto, an action in
// src/app/actions/discover-feed.ts) — ordinary text/category/style
// browsing keeps going through fetchDiscoverBatch exactly as before.
//
// Retrieval shape (the 3 things this file actually does):
//   1. PRIMARY signal — a real pgvector KNN query
//      (match_listings_by_embedding, supabase/schema.sql's Part 10)
//      against listings.visual_embedding, ordered by cosine similarity.
//      This bounded candidate fetch IS "prioritize visual similarity" —
//      nothing here re-derives similarity in application code; the order
//      the RPC returns is the base order everything else adjusts.
//   2. SECONDARY signal — the same category/style/type/free-text
//      predicates fetchDiscoverBatch already applies are reapplied here
//      as a RANKING BOOST, not a filter: a candidate that also matches
//      the active text filters ranks above an equally visually-similar
//      one that doesn't, but a strong visual match is never excluded
//      just for failing a text condition — that's the actual difference
//      between "text filters as primary" (ordinary Discover search) and
//      "text filters as secondary ranking" (this file, per this
//      feature's own spec).
//   3. FALLBACK — if the vector search comes back sparse (fewer than
//      MIN_VECTOR_RESULTS), the remaining slots are filled from a
//      category-based fetch (the resolved category/style if one's
//      active, else just the newest active listings) — same "a search
//      should never come back thin/empty" spirit as fetchDiscoverBatch's
//      own style fallback-terms.
import { createClient } from "@/lib/supabase/server";
import { getHomepageCategoryBySlug, getAestheticCategoryBySlug, type HomepageCategory } from "@/lib/aesthetic-categories";
import { getItemTypeCategoryBySlug, type ItemTypeCategory } from "@/lib/item-type-categories";
import type { Listing } from "@/lib/supabase/listings.types";

// Same column set fetchDiscoverBatch selects for its own (non-intelligence)
// columns — kept identical so a photo-search result renders through the
// exact same ListingCard props as ordinary browsing, no special-casing
// needed on the client.
const LISTING_COLUMNS =
  "id, title, description, price, image_url, images, product_url, platform, brand, category, size, color, aesthetic_tags, created_at";

// Bounded candidate pool for the pgvector KNN stage — same "top ~100,
// never a full scan" shape as src/lib/ai/embedding-search.ts's own Part
// 10 design. Kept a little larger (150) since this file's own ranking
// (unlike that one) doesn't do an AI rerank pass to narrow things down
// further — the extra headroom is what the category-fallback stage below
// draws "already good, just not top-similarity" candidates from before
// resorting to an unrelated newest-first fetch.
const CANDIDATE_COUNT = 150;

// Below this many post-similarity results, pad out with the category
// fallback rather than showing a thin page — mirrors fetchDiscoverBatch's
// own "never let a real search come back looking broken" stance.
const MIN_VECTOR_RESULTS = 8;

// Added to a candidate's [0,1] cosine similarity when it ALSO satisfies
// every currently-active text/category/style/type filter — enough to
// reorder candidates that are already close in similarity, deliberately
// not large enough to be the dominant term (this is a BOOST, not a
// filter — see this file's own header comment).
const TEXT_MATCH_BOOST = 0.15;

export interface DiscoverVisualSearchOptions {
  categorySlug?: string | null;
  typeSlug?: string | null;
  searchQuery?: string | null;
  styleSlug?: string | null;
  limit: number;
}

export interface DiscoverVisualSearchResult {
  listings: Listing[];
  // True when MIN_VECTOR_RESULTS wasn't met and category-based fallback
  // listings were appended — the caller (searchDiscoverByPhoto) surfaces
  // this so the UI can say "a few of these are closest-category picks,
  // not photo matches" instead of silently blending them in unlabeled.
  usedFallback: boolean;
  error: string | null;
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

// Reimplements fetchDiscoverBatch's own SQL predicates (discover-feed.ts's
// buildStyleOrFilter/buildItemTypeOrFilter/buildSearchQueryOrFilter) as
// plain in-memory checks over the bounded candidate pool the pgvector RPC
// already returned, rather than a second round-trip query — deliberately
// mirrors that file's exact matching rules (aesthetic_tags containment
// for category/style, substring match for style fallback terms and free
// text) so "also matches the text filters" means the same thing here as
// it does in ordinary text search. Returns true only when EVERY currently
// active axis matches (not just one) — earning the boost is meant to
// mean "this really does fit what you typed/clicked," not "matched
// something."
function matchesTextFilters(
  listing: Listing,
  category: HomepageCategory | undefined,
  style: HomepageCategory | undefined,
  itemType: ItemTypeCategory | undefined,
  searchQuery: string | null,
): boolean {
  const tags = (listing.aesthetic_tags ?? []).map(normalize);
  const haystack = normalize(`${listing.title} ${listing.description ?? ""}`);

  if (category && !tags.includes(normalize(category.tag))) return false;

  if (itemType) {
    const listingCategory = normalize(listing.category ?? "");
    const matchesType = itemType.categoryKeywords.some((keyword) => listingCategory.includes(normalize(keyword)));
    if (!matchesType) return false;
  }

  if (style) {
    const matchesStyleTag = tags.includes(normalize(style.tag));
    const matchesFallbackTerm = style.fallback_terms.some((term) => haystack.includes(normalize(term)));
    if (!matchesStyleTag && !matchesFallbackTerm) return false;
  }

  if (searchQuery) {
    const q = normalize(searchQuery);
    const matchesText = haystack.includes(q) || tags.includes(normalize(`#${searchQuery.charAt(0).toUpperCase()}${searchQuery.slice(1)}`));
    if (!matchesText) return false;
  }

  return true;
}

/**
 * Vector-first hybrid search — queryEmbedding is expected to come from
 * the SAME embedding pipeline that populates visual_embedding
 * (src/lib/image-similarity.ts's generateImageEmbedding/
 * generateListingSemanticEmbedding), so the vector space actually lines
 * up. excludeListingIds is the caller's already-saved/already-disliked
 * set (same exclusion fetchDiscoverBatch applies) — passed in rather
 * than refetched here, since the caller already has it.
 */
export async function searchDiscoverByImageEmbedding(
  queryEmbedding: number[],
  excludeListingIds: Set<string>,
  options: DiscoverVisualSearchOptions,
): Promise<DiscoverVisualSearchResult> {
  const supabase = await createClient();

  const category = options.categorySlug ? getHomepageCategoryBySlug(options.categorySlug) : undefined;
  const style = options.styleSlug ? getAestheticCategoryBySlug(options.styleSlug) : undefined;
  const itemType = options.typeSlug ? getItemTypeCategoryBySlug(options.typeSlug) : undefined;
  const searchQuery = options.searchQuery?.trim() || null;

  // Stage 1 — bounded pgvector KNN, not a full-table scan. No
  // filter_category passed even when a category/style is active — a
  // strong visual match outside that category is still worth surfacing
  // (just without the text-match boost below); a hard category filter
  // here would make text filters primary again, the opposite of this
  // feature's spec.
  const { data: matches, error: rpcError } = await supabase.rpc("match_listings_by_embedding", {
    query_embedding: queryEmbedding,
    match_count: CANDIDATE_COUNT,
    filter_category: null,
    max_price: null,
  });

  if (rpcError) {
    console.error(
      "[discover-visual-search] pgvector search failed — this requires supabase/schema.sql's " +
        "match_listings_by_embedding function (and the vector extension) to have been applied:",
      rpcError,
    );
    return { listings: [], usedFallback: false, error: "Couldn't search by that photo right now. Please try again." };
  }

  const similarityById = new Map<string, number>((matches ?? []).map((row: { id: string; similarity: number }) => [row.id, row.similarity]));
  const candidateIds = Array.from(similarityById.keys()).filter((id) => !excludeListingIds.has(id));

  let candidates: Listing[] = [];
  if (candidateIds.length > 0) {
    const { data: rows, error: listingsError } = await supabase
      .from("listings")
      .select(LISTING_COLUMNS)
      .in("id", candidateIds)
      .eq("status", "active");

    if (listingsError) {
      console.error("[discover-visual-search] Failed to fetch candidate listing rows:", listingsError);
    } else {
      candidates = (rows ?? []) as unknown as Listing[];
    }
  }

  const ranked = candidates
    .map((listing) => {
      const similarity = similarityById.get(listing.id) ?? 0;
      const boosted = matchesTextFilters(listing, category, style, itemType, searchQuery);
      return { listing, score: similarity + (boosted ? TEXT_MATCH_BOOST : 0) };
    })
    .sort((a, b) => b.score - a.score)
    .map(({ listing }) => listing);

  let finalListings = ranked.slice(0, options.limit);
  let usedFallback = false;

  // Stage 2 — category-based fallback for sparse vector results. Prefers
  // the resolved category/style tag when one's active (staying "on
  // topic" for the fallback fill), otherwise just the newest active
  // listings — same last-resort shape fetchDiscoverBatch itself has none
  // of today (it can go legitimately empty), except here we actively
  // don't want a photo search to come back looking broken.
  if (finalListings.length < MIN_VECTOR_RESULTS) {
    usedFallback = true;
    const alreadyIncluded = new Set([...excludeListingIds, ...finalListings.map((listing) => listing.id)]);
    const needed = options.limit - finalListings.length;

    let fallbackQuery = supabase
      .from("listings")
      .select(LISTING_COLUMNS)
      .eq("status", "active")
      .order("created_at", { ascending: false })
      // Overfetch past `needed` since some of this page will get dropped
      // by the alreadyIncluded exclusion below.
      .limit(needed + alreadyIncluded.size);

    const fallbackTag = category?.tag ?? style?.tag;
    if (fallbackTag) fallbackQuery = fallbackQuery.overlaps("aesthetic_tags", [fallbackTag]);

    const { data: fallbackRows, error: fallbackError } = await fallbackQuery;
    if (fallbackError) {
      console.error("[discover-visual-search] Category fallback fetch failed:", fallbackError);
    } else {
      const fallbackListings = ((fallbackRows ?? []) as unknown as Listing[]).filter(
        (listing) => !alreadyIncluded.has(listing.id),
      );
      finalListings = [...finalListings, ...fallbackListings.slice(0, needed)];
    }
  }

  console.log(
    `[discover-visual-search] ${matches?.length ?? 0} pgvector candidates -> ${ranked.length} ranked -> ` +
      `${finalListings.length} final (usedFallback=${usedFallback})`,
  );

  return { listings: finalListings, usedFallback, error: null };
}
