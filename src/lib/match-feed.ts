// Batch-fetching pipeline for /match — shared by the initial server-rendered
// page load and the "load more" Server Action MatchView calls once the
// swipe queue runs low (see src/app/actions/match-feed.ts). Kept separate
// from match-scoring.ts (pure, no I/O) since this does the actual Supabase
// reads; scoring/filtering logic itself is untouched here.
import { createClient } from "@/lib/supabase/server";
import { getTopTags, sortByTagAffinity, attachMatchPercent } from "@/lib/match-scoring";
import { buildAvailabilityFilter, releaseExpiredReservations } from "@/lib/reservations";
import { getHardExcludedStyleKeys, type DislikedStyles } from "@/lib/disliked-styles";
import { computeFashionQualityScore } from "@/lib/discover-personalization";
import { normalizeMatchPercentForDisplay } from "@/lib/match-percent-display";
import type { MatchListing, ScoredMatchListing } from "@/components/match/MatchView";

export { MATCH_BATCH_SIZE } from "@/lib/pagination-constants";

function debugLog(message: string): void {
  console.log(`[match-page] ${message}`);
}

export interface MatchBatchResult {
  listings: ScoredMatchListing[];
  // Raw row count returned by the listings query itself, before the
  // already-liked/tag-affinity filtering above is applied — callers use
  // this (not listings.length) to know whether another batch is worth
  // requesting: a short raw page means the table is exhausted, even if
  // filtering already reduced this page's own visible count further.
  rawCount: number;
  error: string | null;
}

/**
 * Fetches one page of real listings for /match, applies the existing
 * personalization pipeline (exclude already-liked -> tag-affinity
 * filter/sort -> attach matchPercent), and returns it. offset/limit page
 * over `listings` ordered by created_at desc (id as a tiebreaker for
 * stable pagination) — Style DNA / onboarding / liked-tag signals are
 * recomputed per batch since they're cheap, single-row/single-column
 * reads, keeping each batch request self-contained. No popularity signal
 * is read at all — match % is purely taste-based.
 */
export async function fetchMatchBatch(offset: number, limit: number): Promise<MatchBatchResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Best-effort — clears out stale reservations so they don't keep
  // hiding listings past their 15-minute window. No cron/background job
  // in this app, so this is the opportunistic substitute.
  await releaseExpiredReservations();

  let likedTagLists: string[][] = [];
  let likedIds: string[] = [];
  let dislikedIds: string[] = [];
  let stylePreferences: string[] = [];
  let favoriteBrands: string[] = [];
  let favoriteCategories: string[] = [];
  let favoriteColors: string[] = [];
  let sizePreference: string | null = null;
  let dislikedStyles: DislikedStyles = {};

  if (user) {
    const [{ data: savedRows, error: savedItemsError }, { data: dislikedRows, error: dislikedItemsError }, { data: styleProfile }] =
      await Promise.all([
        supabase
          .from("saved_items")
          .select("listing_id")
          .eq("user_id", user.id)
          .not("listing_id", "is", null),
        supabase.from("disliked_items").select("listing_id").eq("user_id", user.id),
        supabase
          .from("style_profiles")
          .select("style_tags, favorite_brands, favorite_categories, favorite_colors, size_preference, disliked_styles")
          .eq("user_id", user.id)
          .maybeSingle(),
      ]);

    if (savedItemsError) {
      console.error("[match-feed] Failed to fetch saved_items:", savedItemsError);
    }
    if (dislikedItemsError) {
      console.error("[match-feed] Failed to fetch disliked_items:", dislikedItemsError);
    }
    console.log("[match-feed] saved_items fetch result:", savedRows);

    likedIds = (savedRows ?? [])
      .map((row) => row.listing_id)
      .filter((id): id is string => Boolean(id));
    dislikedIds = (dislikedRows ?? [])
      .map((row) => row.listing_id)
      .filter((id): id is string => Boolean(id));

    stylePreferences = styleProfile?.style_tags ?? [];
    favoriteBrands = styleProfile?.favorite_brands ?? [];
    favoriteCategories = styleProfile?.favorite_categories ?? [];
    favoriteColors = styleProfile?.favorite_colors ?? [];
    sizePreference = styleProfile?.size_preference ?? null;
    dislikedStyles = styleProfile?.disliked_styles ?? {};

    if (likedIds.length > 0) {
      const { data: likedListings } = await supabase
        .from("listings")
        .select("aesthetic_tags")
        .in("id", likedIds);

      likedTagLists = (likedListings ?? []).map((row) => row.aesthetic_tags ?? []);
    }
  }

  // shipping_cost is deliberately NOT selected here: the column was added
  // to schema.sql for the checkout-preview feature but that migration
  // hasn't been applied to the live database yet, and selecting a column
  // that doesn't exist fails the whole query with a 42703 error — which is
  // exactly what was taking down every /match page load. CartListing/
  // ListingDetailView already treat shipping_cost as optional (falling
  // back to 0/"Free"), so omitting it here just means Match-added cart
  // items show no shipping cost until that migration lands — re-add it to
  // this select once it has.
  const MATCH_LISTING_COLUMNS =
    "id, title, price, image_url, brand, size, category, color, aesthetic_tags, platform, product_url";

  const availabilityFilter = await buildAvailabilityFilter(supabase, user?.id ?? null);

  const filtered = await supabase
    .from("listings")
    .select(MATCH_LISTING_COLUMNS)
    .or(availabilityFilter)
    .eq("status", "active")
    .order("created_at", { ascending: false })
    .order("id", { ascending: true })
    .range(offset, offset + limit - 1);

  let listingsData = filtered.data;
  let error = filtered.error;

  // Fallback keeps `.eq("status", "active")` non-negotiable — status is
  // what excludes pending/rejected/removed listings, so it must never be
  // dropped even if the availability filter's reservation columns turn out
  // to be missing on some database. Only the availability filter itself is
  // relaxed here.
  if (error) {
    console.error("[match-feed] Query failed, retrying without the availability filter:", error);
    const fallback = await supabase
      .from("listings")
      .select(MATCH_LISTING_COLUMNS)
      .eq("status", "active")
      .order("created_at", { ascending: false })
      .order("id", { ascending: true })
      .range(offset, offset + limit - 1);
    listingsData = fallback.data;
    error = fallback.error;
  }

  if (error) {
    console.error("[match-query-error]", error);
    return { listings: [], rawCount: 0, error: error.message };
  }

  // Guard against a row somehow coming back with a null aesthetic_tags or
  // price — the listings table declares both non-null with defaults, but
  // this shouldn't have to trust that to avoid crashing filterAndSortBy-
  // TagAffinity/attachMatchPercent (which .map() over aesthetic_tags) or
  // MatchView's price.toFixed(2) rendering.
  const listings: MatchListing[] = (listingsData ?? []).map((row) => ({
    ...row,
    aesthetic_tags: row.aesthetic_tags ?? [],
    price: row.price ?? 0,
  }));
  debugLog(`Active listings available (this page, status='active'): ${listings.length}`);
  debugLog(
    `Style preferences loaded: styleTags=${JSON.stringify(stylePreferences)} favoriteBrands=${JSON.stringify(favoriteBrands)} favoriteCategories=${JSON.stringify(favoriteCategories)} favoriteColors=${JSON.stringify(favoriteColors)} sizePreference=${sizePreference}`,
  );

  // ONLY exclusion in this whole pipeline: a listing the user has already
  // interacted with (liked/saved, or disliked/skipped) by id. Every active
  // listing the user hasn't touched yet must stay eligible for the swipe
  // queue — style/aesthetic compatibility (disliked styles, tag affinity,
  // match percentage) must NEVER remove a listing here, only affect its
  // ranking/displayed score further down (attachMatchPercent's own
  // dislikePenalty subtraction, and sortByTagAffinity's reordering).
  const now = Date.now();
  const likedIdSet = new Set(likedIds);
  const dislikedIdSet = new Set(dislikedIds);
  const unseenListings = listings.filter(
    (listing) => !likedIdSet.has(listing.id) && !dislikedIdSet.has(listing.id),
  );

  // hardExcludedStyles only keeps a heavily-disliked style from winning a
  // "top liked tag" ranking slot (see getTopTags' own comment) — it does
  // NOT remove any listing; sortByTagAffinity below reorders the full
  // unseenListings set, it never drops anything from it.
  const hardExcludedStyles = getHardExcludedStyleKeys(dislikedStyles, now);
  const topTags = getTopTags(likedTagLists, 3, hardExcludedStyles);
  debugLog(
    `Top liked tags (excluding hard-excluded styles ${JSON.stringify([...hardExcludedStyles])}): ${JSON.stringify(topTags)}`,
  );

  // Ranking only — every listing in unseenListings comes back out, just
  // reordered by tag-overlap when there's something to rank against yet
  // (new/signed-out users have no topTags, so the set passes through
  // untouched either way).
  const results = topTags.length > 0 ? sortByTagAffinity(unseenListings, topTags) : unseenListings;
  debugLog(`Listings after excluding liked/disliked (${results.length}) — unchanged by tag-affinity ranking`);

  const resultsWithScore = attachMatchPercent(results, {
    stylePreferences,
    favoriteBrands,
    favoriteCategories,
    favoriteColors,
    sizePreference,
    topLikedTags: topTags,
    dislikedStyles,
    now,
  });
  debugLog(`Matches after scoring: ${resultsWithScore.length}`);

  // P0 pre-launch polish fix (item 1) — same "staged recommendation
  // strategy" already applied to Discover (src/lib/discover-feed.ts): a
  // brand-new user has no likes/passes and no onboarding brand/style
  // signal for scoreListingMatch to work with, so every candidate gets
  // the same flat neutral score and the "personalized" ranking above is
  // really just recency order wearing a match-percent badge. Below the
  // same meaningful-interaction threshold, re-rank by fashionQualityScore
  // (visually attractive/complete metadata/high-quality photos — same
  // composite Discover uses, with a deterministic fallback when this
  // database has no quality_score/inventory_quality_score columns yet, so
  // this never risks a missing-column query failure) instead of the
  // meaningless personalization order, and substitute it into the
  // displayed matchPercent too so a cold-start badge reflects something
  // real rather than an identical number on every card.
  const MIN_INTERACTIONS_FOR_PERSONALIZATION = 3;
  const interactionSignalCount = likedIds.length + dislikedIds.length;
  const hasOnboardingSignal = favoriteBrands.length > 0 || stylePreferences.length > 0;
  const isColdStart = interactionSignalCount < MIN_INTERACTIONS_FOR_PERSONALIZATION && !hasOnboardingSignal;

  if (!isColdStart) {
    return { listings: resultsWithScore, rawCount: listings.length, error: null };
  }

  const qualityRanked = resultsWithScore
    .map((listing) => ({
      listing,
      fashionQuality: computeFashionQualityScore({
        images: undefined,
        imageUrl: listing.image_url,
        title: listing.title,
        aestheticTags: listing.aesthetic_tags,
        brand: listing.brand,
        category: listing.category,
        price: listing.price,
        qualityScore: null,
        inventoryQualityScore: null,
      }),
    }))
    .sort((a, b) => b.fashionQuality.score - a.fashionQuality.score)
    .map(({ listing, fashionQuality }) => ({
      ...listing,
      matchPercent: normalizeMatchPercentForDisplay(fashionQuality.score),
    }));

  return { listings: qualityRanked, rawCount: listings.length, error: null };
}
