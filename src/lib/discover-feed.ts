// Batch-fetching pipeline for /discover — the single unified browsing
// page (formerly split across /discover and /feed, see that removed
// page's redirect stub) — shared by the initial server-rendered page load
// and the "load more" Server Action DiscoverView calls once the user
// scrolls near the bottom (see src/app/actions/discover-feed.ts). Scoring
// blends two independent signals: onboarding Style DNA preferences
// (scoreAndSortListings, listing-scoring.ts) and liked-item tag/keyword
// affinity (scoreAndSortByLikedTags, feed-scoring.ts — /feed's own scoring
// before the merge), combined near the bottom of fetchDiscoverBatch.
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { scoreAndSortListings, type ScoredListing } from "@/lib/listing-scoring";
import { getLikedTags, getLikedKeywords, scoreAndSortByLikedTags } from "@/lib/feed-scoring";
import { buildAvailabilityFilter, releaseExpiredReservations } from "@/lib/reservations";
import {
  getHomepageCategoryBySlug,
  getAestheticCategoryBySlug,
  type HomepageCategory,
} from "@/lib/aesthetic-categories";
import { getItemTypeCategoryBySlug, type ItemTypeCategory } from "@/lib/item-type-categories";
import type { DislikedStyles } from "@/lib/disliked-styles";
import type { Listing } from "@/lib/supabase/listings.types";

export { DISCOVER_BATCH_SIZE } from "@/lib/pagination-constants";

// user_id and is_low_quality are NOT selected here — neither column exists
// on the live `listings` table (verified directly against the database's
// PostgREST schema; both are declared in supabase/schema.sql but that
// migration hasn't been applied live). user_id has no other use in this
// file (Discover's owner-only edit/delete menu was removed entirely in the
// admin-curated-platform pivot); is_low_quality being absent just means
// scoreAndSortListings' low-quality penalty never applies (its own type
// already declares this field optional for exactly this reason).
//
// `images` IS selected (previously excluded "by design" to keep list
// views light) — it's just an array of URL strings, not image bytes, so
// selecting it costs nothing meaningful even across a full page of
// listings; ListingCard uses it to show a photo-count indicator.
//
// Deliberately no `score` column here — the live `listings` table has no
// such column (confirmed directly against the database: selecting or
// ordering by it fails with "column listings.score does not exist",
// Postgres code 42703), and this file no longer tries to depend on it at
// all rather than papering over its absence with a fallback. The query
// below orders by created_at/id only (newest-imported first); all
// preference-based ranking (onboarding Style DNA, liked-item tag/keyword
// affinity — scoreAndSortListings/scoreAndSortByLikedTags below) already
// happens entirely in memory, AFTER this fetch, and was never reading
// this column anyway — see this file's own header comment.
const LISTING_COLUMNS =
  "id, title, description, price, image_url, images, product_url, platform, brand, category, size, color, aesthetic_tags, created_at";

// Inventory Intelligence integration (Parts 1/8) — visual_analysis/
// inventory_quality_score feed scoreAndSortListings/scoreAndSortByLikedTags'
// new bonus terms (listing-scoring.ts, feed-scoring.ts). Selected only
// once this database is confirmed to actually have these columns —
// probed lazily (see intelligenceColumnsAvailable below) rather than
// just appending them to LISTING_COLUMNS directly, since that would
// break Discover entirely (the whole query fails on ANY missing column,
// same as every other "not migrated yet" case this file already guards
// against) on a database where supabase/schema.sql's Part 8 migration
// hasn't been run yet.
const INTELLIGENCE_COLUMNS = "visual_analysis, inventory_quality_score";

// Cached per server process (not per-request) — this changes only once,
// the moment an operator actually runs the Part 8 migration, so probing
// on every single Discover page load would be pure waste. `null` = not
// probed yet.
let intelligenceColumnsAvailable: boolean | null = null;

async function checkIntelligenceColumnsAvailable(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- matching createClient()'s own untyped default (see supabase/server.ts), same convention as reservations.ts's buildAvailabilityFilter
  supabase: SupabaseClient<any>,
): Promise<boolean> {
  if (intelligenceColumnsAvailable != null) return intelligenceColumnsAvailable;

  const { error } = await supabase.from("listings").select(INTELLIGENCE_COLUMNS).limit(1);
  intelligenceColumnsAvailable = !error;
  if (error) {
    console.log(
      "[discover-feed] Inventory intelligence columns not found yet — scoring without them until " +
        "supabase/schema.sql's Part 8 migration is applied.",
    );
  }
  return intelligenceColumnsAvailable;
}

// Same "is this a not-yet-migrated column" detection as
// /api/import-listing/route.ts, src/lib/bulk-import.ts, src/lib/admin-scraper.ts
// — duplicated rather than imported since none of those export it as a
// reusable function (matches this codebase's existing per-module
// convention for this exact check).
function isMissingColumnError(error: { code?: string; message: string }): boolean {
  return error.code === "PGRST204" || /column .* does not exist/i.test(error.message);
}

// Structured, not just the raw PostgrestError object — {message, code,
// details, hint} is what actually tells you WHICH column/constraint is
// missing at a glance (e.g. code 42703 + "column listings.score does not
// exist"), instead of relying on however the error happens to stringify.
function logQueryError(context: string, error: { message: string; code?: string; details?: string | null; hint?: string | null }): void {
  console.error(`[discover-feed] ${context}`, {
    message: error.message,
    code: error.code ?? null,
    details: error.details ?? null,
    hint: error.hint ?? null,
  });
}

export interface DiscoverBatchResult {
  // Already excludes anything in savedListingIds or disliked_items — see
  // fetchDiscoverBatch.
  listings: Listing[];
  // Still returned separately (not just used to filter `listings` above)
  // because DiscoverView also needs it to pre-fill each SaveButton's heart
  // icon as already-filled for a listing liked on a previous visit.
  savedListingIds: string[];
  // Raw row count before scoring/sorting/liked-exclusion — a short page
  // means the table is exhausted, which is what tells the client to stop
  // trying to load more.
  rawCount: number;
  error: string | null;
}

/**
 * Fetches one page of real listings for /discover (includes `images`, the
 * full photo gallery array, so ListingCard can show a photo-count
 * indicator — see LISTING_COLUMNS above), excludes anything the user has
 * already liked (saved_items.listing_id),
 * and applies the existing preference-based scoreAndSortListings to
 * what's left, then lightly reshuffles that order (shuffleWithBias) so the
 * page doesn't render in the exact same sequence on every refresh — good
 * matches still cluster near the top on average, they just aren't glued to
 * one fixed order. Each page is scored/sorted/shuffled independently, so
 * ordering is "newest pages first, best-matching (with light shuffle)
 * within each page" — the same tradeoff every paginated ranked feed makes,
 * since a global re-rank across an ever-growing list isn't possible
 * without re-fetching everything.
 *
 * categorySlug (from the homepage's category cards / ?category= query
 * param) is resolved against HOMEPAGE_CATEGORIES and applied as a
 * server-side array-overlap filter on aesthetic_tags — done here (not as
 * a post-fetch JS filter) so it composes correctly with `.range()`
 * pagination: filtering after paging would make "load more" think the
 * table was exhausted the moment a page happened to contain few matches,
 * even with plenty more further down the table. An unrecognized/missing
 * slug is simply ignored (falls open to the unfiltered feed) rather than
 * erroring.
 *
 * typeSlug (?type= query param) is the second, independent filter axis —
 * resolved against ITEM_TYPE_CATEGORIES and applied as an OR'd set of
 * `category.ilike.%keyword%` conditions via `.or()`, for the same
 * before-`.range()` reason as categorySlug above. Chaining `.overlaps()`
 * and `.or()` on the same query builder ANDs them together, which is
 * exactly what lets category+type combine (e.g. Y2K Tops) instead of one
 * silently overriding the other.
 *
 * searchQuery (?query= query param — no longer fed by the homepage,
 * which now links ?style=<slug> instead, but still fully functional for
 * anyone linking to it directly) is a third, independent filter axis, and
 * the only one of the three that's raw free text rather than a slug
 * resolved against a fixed list: it's matched via ILIKE against
 * title/description, plus an opportunistic exact aesthetic_tags overlap check (true
 * substring-per-array-element matching isn't expressible via PostgREST's
 * plain filter grammar without a dedicated Postgres function — given
 * title/description ILIKE already covers this project's real inventory
 * well, that wasn't worth adding for this). Applied the same
 * before-`.range()` way as the other two.
 *
 * styleSlug (?style= query param, the homepage's current "shop by vibe"
 * entry point) is resolved against AESTHETIC_CATEGORIES and applied as a
 * HYBRID filter: exact aesthetic_tags containment (the same signal
 * categorySlug uses) OR'd together with ILIKE title/description matches
 * against that aesthetic's fallback_terms. The explicit point of the
 * fallback terms is to guarantee a style page is never an empty feed —
 * unlike categorySlug (still exact-tag-only, kept for whatever still
 * calls it directly), a listing the tagging pipeline missed entirely can
 * still surface here as long as its title/description uses ordinary
 * words for the look (e.g. "grunge", "leather"). Composed via the same
 * chained-`.or()` AND-with-everything-else pattern as the other axes.
 */
function buildItemTypeOrFilter(itemType: ItemTypeCategory): string {
  return itemType.categoryKeywords.map((keyword) => `category.ilike.%${keyword}%`).join(",");
}

// The tag value is quoted inside the array literal (`{"..."}`, not
// `{...}`) — required Postgres array-literal syntax for any element that
// might contain a space, comma, or brace (e.g. "#Indie Sleaze"). Verified
// live that both forms actually return identical, correct results against
// this project's real data, but quoting is the objectively correct way to
// write this regardless — an unquoted element with a space happens to
// still parse fine only because none of today's tags also contain a
// comma or brace, which would break both the array literal and the outer
// comma-delimited .or() clause list at once.
function buildStyleOrFilter(style: HomepageCategory): string {
  const tagClause = `aesthetic_tags.cs.{"${style.tag}"}`;
  const termClauses = style.fallback_terms.flatMap((term) => [
    `title.ilike.%${term}%`,
    `description.ilike.%${term}%`,
  ]);
  return [tagClause, ...termClauses].join(",");
}

// Strips characters PostgREST's `.or()` filter-string grammar treats as
// syntax (comma separates conditions, parentheses group them) — this value
// comes straight from a public URL param, unlike categorySlug/typeSlug
// which are always resolved against a fixed, hardcoded list first. A
// genuine product-name search never needs these characters, so stripping
// them is a safe simplification rather than full percent-escaping.
function sanitizeSearchQuery(raw: string): string {
  return raw.replace(/[,()]/g, "").trim();
}

function buildSearchQueryOrFilter(searchQuery: string): string {
  const safe = sanitizeSearchQuery(searchQuery);
  const capitalizedTag = `#${safe.charAt(0).toUpperCase()}${safe.slice(1)}`;
  return [
    `title.ilike.%${safe}%`,
    `description.ilike.%${safe}%`,
    `aesthetic_tags.cs.{${capitalizedTag}}`,
  ].join(",");
}

// Applied AFTER scoreAndSortListings, not instead of it — the strict
// score-descending order it produces would otherwise show the exact same
// sequence on every refresh (same preferences, same page of listings).
// Blending in a random component (weighted 30/70 against the real score)
// still keeps genuinely better matches clustered near the top on average,
// while giving the page a "freshly shuffled" feel each time it loads. Pure
// per-request randomness — nothing is seeded/persisted, so this never
// needs to be undone or accounted for anywhere else.
//
// entry.score is normalized to 0-1 before blending (score / 100) — it's a
// 0-100 percentage (see scoreListingMatch's own doc comment in
// listing-scoring.ts), and blending that directly against Math.random()'s
// 0-1 range would make the random term (max 0.3) utterly negligible next
// to the score term (up to 70) for any realistic score gap: verified live
// that the unscaled version returns the identical order on every single
// call given real 0-100 scores, which would have silently defeated this
// entire feature's actual goal.
function shuffleWithBias<T>(scoredListings: ScoredListing<T>[]): ScoredListing<T>[] {
  return scoredListings
    .map((entry) => ({ entry, sort: Math.random() * 0.3 + (entry.score / 100) * 0.7 }))
    .sort((a, b) => b.sort - a.sort)
    .map(({ entry }) => entry);
}

export async function fetchDiscoverBatch(
  offset: number,
  limit: number,
  categorySlug?: string | null,
  typeSlug?: string | null,
  searchQuery?: string | null,
  styleSlug?: string | null,
): Promise<DiscoverBatchResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Best-effort — clears out stale reservations so they don't keep
  // hiding listings past their 15-minute window. No cron/background job
  // in this app, so this is the opportunistic substitute.
  await releaseExpiredReservations();

  let preferences: string[] = [];
  let savedListingIds: string[] = [];
  let dislikedListingIds: string[] = [];
  let dislikedStyles: DislikedStyles = {};
  // Liked-item tag/keyword affinity — the signal /feed used to score by
  // exclusively, before it was folded into this single unified page (see
  // this function's own doc comment). Blended alongside the onboarding
  // Style DNA preference match below rather than replacing it, so a
  // listing that matches either signal still surfaces well.
  let likedTags: string[] = [];
  let likedKeywords = new Set<string>();
  if (user) {
    const [{ data: styleProfile }, { data: savedRows, error: savedItemsError }, { data: dislikedRows, error: dislikedItemsError }] =
      await Promise.all([
        supabase.from("style_profiles").select("style_tags, disliked_styles").eq("user_id", user.id).maybeSingle(),
        supabase
          .from("saved_items")
          .select("listing_id")
          .eq("user_id", user.id)
          .not("listing_id", "is", null),
        supabase.from("disliked_items").select("listing_id").eq("user_id", user.id),
      ]);

    if (savedItemsError) {
      console.error("[discover-feed] Failed to fetch saved_items:", savedItemsError);
    }
    if (dislikedItemsError) {
      console.error("[discover-feed] Failed to fetch disliked_items:", dislikedItemsError);
    }

    preferences = styleProfile?.style_tags ?? [];
    dislikedStyles = styleProfile?.disliked_styles ?? {};
    savedListingIds = (savedRows ?? [])
      .map((row) => row.listing_id)
      .filter((id): id is string => Boolean(id));
    dislikedListingIds = (dislikedRows ?? [])
      .map((row) => row.listing_id)
      .filter((id): id is string => Boolean(id));

    if (savedListingIds.length > 0) {
      const { data: likedListings } = await supabase
        .from("listings")
        .select("title, description, aesthetic_tags")
        .in("id", savedListingIds);

      likedTags = getLikedTags((likedListings ?? []).map((row) => row.aesthetic_tags ?? []));
      likedKeywords = getLikedKeywords(
        (likedListings ?? []).map((row) => ({ title: row.title, description: row.description })),
      );
    }
  }

  // reserved_by_order_id/reservation_expires_at may not exist on the live
  // DB yet (see supabase/schema.sql) — filtering on a missing column fails
  // the *entire* query, so this falls back to an unfiltered fetch (every
  // listing shows as available) rather than hiding the whole page.
  const availabilityFilter = await buildAvailabilityFilter(supabase, user?.id ?? null);
  const hasIntelligenceColumns = await checkIntelligenceColumnsAvailable(supabase);
  const listingColumns = hasIntelligenceColumns ? `${LISTING_COLUMNS}, ${INTELLIGENCE_COLUMNS}` : LISTING_COLUMNS;
  const category = categorySlug ? getHomepageCategoryBySlug(categorySlug) : undefined;
  const itemType = typeSlug ? getItemTypeCategoryBySlug(typeSlug) : undefined;
  const trimmedSearchQuery = searchQuery?.trim() || null;
  const activeStyle = styleSlug ? getAestheticCategoryBySlug(styleSlug) : undefined;

  // Temporary — remove once the "internal server error on ?style=" report
  // is confirmed resolved (or gets a concrete repro to chase further).
  console.log("[discover-feed] STYLE PARAM:", styleSlug);
  console.log("[discover-feed] MATCHED CATEGORY:", activeStyle);

  // Newest-imported first — no DB score column to order by (see
  // LISTING_COLUMNS's own comment). Preference-based ranking is layered
  // on top of this raw, newest-first page entirely in memory, further
  // down this function.
  let query = supabase
    .from("listings")
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- runtime-computed select string, see listingColumns' own comment above
    .select(listingColumns as any)
    .or(availabilityFilter)
    .eq("status", "active")
    .order("created_at", { ascending: false })
    .order("id", { ascending: true })
    .range(offset, offset + limit - 1);

  if (category) {
    query = query.overlaps("aesthetic_tags", [category.tag]);
  }
  if (activeStyle) {
    query = query.or(buildStyleOrFilter(activeStyle));
  }
  if (itemType) {
    query = query.or(buildItemTypeOrFilter(itemType));
  }
  if (trimmedSearchQuery) {
    query = query.or(buildSearchQueryOrFilter(trimmedSearchQuery));
  }

  const filtered = await query;

  // The `as any` select cast a few lines up (see its own comment) still
  // leaves the query builder chain's final `.data` typed as a generic
  // error-shape placeholder rather than a real row array — recast here
  // to the actual, correct row shape (this is genuinely what the query
  // returns at runtime; only the static literal-parsing gave up on it).
  let listingsData: Listing[] | null = filtered.data as unknown as Listing[] | null;
  let error = filtered.error;

  // `.eq("status", "active")` is non-negotiable in this fallback — status
  // is what excludes pending/rejected/removed listings (see
  // adminListingRemoval.ts's removeListing), so it must never be dropped.
  //
  // This fallback is about the AVAILABILITY FILTER's own columns
  // (reserved_by_order_id/reservation_expires_at) possibly being missing
  // on some database — a separate, unrelated concern from `score` (which
  // this file no longer selects/orders by at all, see LISTING_COLUMNS's
  // own comment). logQueryError below reports exactly what Postgres said
  // (message/code/details/hint), so which column/condition is actually
  // missing is never hidden behind a generic message.
  if (error) {
    logQueryError(
      isMissingColumnError(error)
        ? "Query failed — the availability filter's columns appear missing on this database — retrying without it:"
        : "Query failed for a reason other than a missing column — retrying without the availability filter anyway:",
      error,
    );

    let statusOnlyQuery = supabase
      .from("listings")
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- runtime-computed select string, see listingColumns' own comment above
    .select(listingColumns as any)
      .eq("status", "active")
      .order("created_at", { ascending: false })
      .order("id", { ascending: true })
      .range(offset, offset + limit - 1);

    if (category) {
      statusOnlyQuery = statusOnlyQuery.overlaps("aesthetic_tags", [category.tag]);
    }
    if (activeStyle) {
      statusOnlyQuery = statusOnlyQuery.or(buildStyleOrFilter(activeStyle));
    }
    if (itemType) {
      statusOnlyQuery = statusOnlyQuery.or(buildItemTypeOrFilter(itemType));
    }
    if (trimmedSearchQuery) {
      statusOnlyQuery = statusOnlyQuery.or(buildSearchQueryOrFilter(trimmedSearchQuery));
    }

    const statusOnly = await statusOnlyQuery;
    listingsData = statusOnly.data as unknown as Listing[] | null;
    error = statusOnly.error;

    if (error) {
      logQueryError("Status-only query also failed — Discover cannot load any listings:", error);
    }
  }

  if (error) {
    return { listings: [], savedListingIds, rawCount: 0, error: error.message };
  }

  const listings: Listing[] = listingsData ?? [];

  // Never show a listing the user has already liked or already disliked
  // ("X"/Skip on /match — see disliked_items) — same convention as
  // match-feed.ts/feed/page.tsx. rawCount below stays based on the raw
  // fetched page (not this filtered count), so pagination's "is the table
  // exhausted" signal isn't thrown off by how many of this page's rows
  // happen to already be liked/disliked.
  const savedListingIdSet = new Set(savedListingIds);
  const dislikedListingIdSet = new Set(dislikedListingIds);
  const unseenListings = listings.filter(
    (listing) => !savedListingIdSet.has(listing.id) && !dislikedListingIdSet.has(listing.id),
  );

  // Two independent signals blended into one ranking, same "take
  // whichever fits best" reasoning /match's own combined scoring already
  // uses: onboarding Style DNA preferences (scoreAndSortListings) and
  // actual liked-item tag/keyword affinity (scoreAndSortByLikedTags, the
  // scoring /feed used exclusively before the two pages were unified).
  // Both apply the same dislikedStyles hard-exclusion independently, so
  // they always agree on which listings survive at all — only the score
  // itself needs merging, by listing.id, taking the stronger of the two
  // signals rather than averaging them down.
  const onboardingScored = scoreAndSortListings(unseenListings, preferences, dislikedStyles);
  const likedScored = scoreAndSortByLikedTags(unseenListings, likedTags, likedKeywords, dislikedStyles);
  const likedScoreByListingId = new Map(likedScored.map(({ listing, score }) => [listing.id, score]));

  const combined: ScoredListing<Listing>[] = onboardingScored.map(({ listing, score: onboardingScore }) => {
    const likedScore = likedScoreByListingId.get(listing.id);
    const score = likedScore != null ? Math.max(onboardingScore, likedScore) : onboardingScore;
    return { listing, score };
  });

  const shuffled = shuffleWithBias(combined);

  return {
    listings: shuffled.map(({ listing }) => listing),
    savedListingIds,
    rawCount: listings.length,
    error: null,
  };
}
