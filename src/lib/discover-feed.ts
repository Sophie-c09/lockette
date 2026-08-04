// Batch-fetching pipeline for /discover — the single unified browsing
// page (formerly split across /discover and /feed, see that removed
// page's redirect stub) — shared by the initial server-rendered page load
// and the "load more" Server Action DiscoverView calls once the user
// scrolls near the bottom (see src/app/actions/discover-feed.ts).
//
// Personalization pipeline (garment-level rework — fixes Discover
// surfacing unfashionable/mismatched inventory): match-scoring.ts's
// scoreListingMatch/getTopTags (still used by /match, untouched) only ever
// compared aesthetic_tags — broad vibe words like "coquette" or "y2k" — so
// a floral maxi skirt and a fitted lace top could score identically for a
// user who only actually likes the top, as long as both happened to share
// one tag. This file now builds a deterministic per-user style vector
// from Likes/onboarding/positive-interaction history
// (src/lib/discover-style-vector.ts, weighted 45/25/15/10/5 per that
// module's own spec) and scores each candidate's GARMENT-LEVEL
// resemblance to it (src/lib/discover-personalization.ts's
// scoreGarmentStyleMatch, weighted 30/20/15/10/10/5/5/5) before a
// fashionability quality gate (FASHION_QUALITY_GATE) deprioritizes
// visibly weak inventory. matchPercent (0-100) and stylePoints (the
// aesthetic-match sub-component) keep the same field names/shape the UI
// already renders (ListingCard.tsx) — nothing about the page itself
// changed, only what feeds those two numbers.
//
// Also fixes a second, compounding bug: the OLD pipeline fetched exactly
// one recency-ordered page (`.range(offset, offset+limit-1)`) and only
// ever reordered THAT page — a genuinely great match sitting one page
// further back (older) could never surface on page 1, no matter how well
// it scored, because personalization never saw it. This file now scores
// across a wider recency-ordered CANDIDATE POOL (RANKED_WINDOW below) and
// paginates the RANKED result instead, so personalization actually gets a
// meaningful pool to choose from rather than whatever happened to be
// newest. See RANKED_WINDOW's own comment for the scale tradeoff this
// makes for very deep pagination.
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { buildAvailabilityFilter, releaseExpiredReservations } from "@/lib/reservations";
import {
  getHomepageCategoryBySlug,
  getAestheticCategoryBySlug,
  type HomepageCategory,
} from "@/lib/aesthetic-categories";
import { getItemTypeCategoryBySlug, type ItemTypeCategory } from "@/lib/item-type-categories";
import { getHardExcludedStyleKeys, assessListingAgainstDislikedStyles, type DislikedStyles } from "@/lib/disliked-styles";
import { buildUserStyleVector, type LikedListingAttributes } from "@/lib/discover-style-vector";
import { scoreGarmentStyleMatch, computeFashionQualityScore, FASHION_QUALITY_GATE } from "@/lib/discover-personalization";
import { normalizeMatchPercentForDisplay } from "@/lib/match-percent-display";
import type { Listing } from "@/lib/supabase/listings.types";
// The 4 sort-control options (Default / Most Recent / Price: Low to High /
// Price: High to Low) — "" (Default) is the default and the fallback for
// a missing/unrecognized ?sort= value (including the retired "match"/
// "points"). This is purely display ORDER: it never changes which
// listings qualify for Discover (the fashionability gate + matchPercent/
// stylePoints personalization in fetchDiscoverBatch below are unaffected).
// Default means "leave the algorithm's own personalized ranking (highest
// matchPercent first) alone" — not "no ranking at all" — see
// discover-sort.ts's own header comment for why this logic (and
// DiscoverView.tsx's client-side re-sort-on-dropdown-change) lives in its
// own shared, zero-import module rather than only here. Re-exported so
// every existing caller of these three names from "@/lib/discover-feed"
// keeps working unchanged.
import { applyDiscoverSort, parseDiscoverSortOption, DEFAULT_DISCOVER_SORT, type DiscoverSortOption } from "@/lib/discover-sort";
export { DEFAULT_DISCOVER_SORT, parseDiscoverSortOption, type DiscoverSortOption };

// What this file actually returns per listing now — the base row plus the
// two display-only scores attached below (matchPercent/stylePoints), same
// "base type + attached score fields" shape match-feed.ts's own
// ScoredMatchListing already uses. Nullable (not just optional) because
// the photo-search path (searchDiscoverByPhoto, src/app/actions/
// discover-feed.ts) returns real listings that were never run through
// this file's own scoring at all — vector-similarity search results,
// scored/ranked entirely differently — so it explicitly sets both to null
// rather than omitting them, and ListingCard already renders its
// matchScore/stylePoints props as absent for null.
export type ScoredDiscoverListing = Listing & {
  matchPercent: number | null;
  stylePoints: number | null;
};

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

// Fashionability gate (src/lib/discover-personalization.ts) prefers
// quality_score (src/lib/listing-quality.ts's pre-import AI read) when
// inventory_quality_score isn't available — probed independently, same
// lazy/cached pattern as intelligenceColumnsAvailable above, rather than
// bundled into that same probe: quality_score is an older, separately
// migrated column (supabase/schema.sql, well before the Part 8 visual_
// analysis/inventory_quality_score columns), so a database that has one
// doesn't necessarily have the other — probing them independently means
// a database with quality_score but not yet Part 8 still gets to use it.
let qualityScoreColumnAvailable: boolean | null = null;

async function checkQualityScoreColumnAvailable(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- matching checkIntelligenceColumnsAvailable's own convention above
  supabase: SupabaseClient<any>,
): Promise<boolean> {
  if (qualityScoreColumnAvailable != null) return qualityScoreColumnAvailable;

  const { error } = await supabase.from("listings").select("quality_score").limit(1);
  qualityScoreColumnAvailable = !error;
  if (error) {
    console.log("[discover-feed] quality_score column not found yet — fashionability gate falls back to inventory_quality_score/deterministic estimate.");
  }
  return qualityScoreColumnAvailable;
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
  listings: ScoredDiscoverListing[];
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
 * already liked (saved_items.listing_id), attaches matchPercent/stylePoints
 * to what's left (scoreListingMatch, reused from match-scoring.ts — see
 * this file's own header comment), then sorts deterministically per
 * sortOption (sortDiscoverListings below — no shuffle anymore: priority
 * order needs to be exact and reproducible, not "clustered on average").
 * Each page is scored/sorted independently, so ordering is "newest pages
 * first, then priority-sorted within each page" — the same tradeoff every
 * paginated ranked feed makes, since a global re-rank across an
 * ever-growing list isn't possible without re-fetching everything.
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

export interface DiscoverSortEntry {
  listing: Listing;
  matchPercent: number;
  stylePoints: number;
  fashionQualityScore: number;
}

// Thin adapter over discover-sort.ts's shared applyDiscoverSort — see
// that file's own header comment for why the actual comparator logic
// lives there (DiscoverView.tsx needs the exact same logic client-side,
// and can't import a value from this server-only module). "" (Default)
// returns the algorithm's own personalized ranking (matchPercent
// descending) untouched; "recent"/"price_asc"/"price_desc" re-sort that
// same already-personalized set by a different key. matchPercent/
// stylePoints are still computed and still shown on every card
// regardless of which of these four the user picks — this only ever
// changes DISPLAY ORDER, never which listings qualify (the
// fashionability gate — fetchDiscoverBatch's gatePassed/gateFailed
// partition, computed BEFORE this function ever runs — is what keeps
// stronger inventory ranked ahead of weaker inventory no matter the
// sortOption).
//
// Exported for direct unit testing (tests/discover-sort.test.ts) — pure,
// no I/O, same "export the pure scoring/sorting function itself" pattern
// match-scoring.ts's own exports already use.
export function sortDiscoverListings(entries: DiscoverSortEntry[], sortOption: DiscoverSortOption): DiscoverSortEntry[] {
  return applyDiscoverSort(entries, sortOption, (entry) => ({
    id: entry.listing.id,
    price: entry.listing.price,
    createdAt: entry.listing.created_at,
    matchPercent: entry.matchPercent,
  }));
}

// How large a recency-ordered candidate pool to fetch/rank/quality-gate
// on every request, instead of only the one page actually requested — see
// this file's own header comment on why "score just one recency-ordered
// page" left personalization unable to ever surface a great match sitting
// one page further back. 5 pages' worth: enough for personalization to
// have a real pool to choose from across the screens an actual user
// scrolls through, without re-fetching/re-scoring an unbounded prefix on
// every "load more" call as this app's inventory grows toward its
// 50,000-listing target. Beyond this window, fetchDiscoverBatch falls
// back to the OLD per-page-only behavior (see useRankedWindow below) —
// a real, deliberate scale tradeoff for very deep infinite scroll, not an
// oversight: a proper fix at full scale would need a precomputed/
// materialized per-user ranking or a pgvector similarity query (this
// codebase already has style_profiles.style_embedding/
// listings.visual_embedding for exactly that — see src/lib/style-embedding.ts
// — just not wired to Discover, and doing so would need that embedding
// kept fresh on every Like, not only at onboarding save time).
const RANKED_WINDOW = 5 * 60; // keep in sync with DISCOVER_BATCH_SIZE's real value (60) if that ever changes

export async function fetchDiscoverBatch(
  offset: number,
  limit: number,
  categorySlug?: string | null,
  typeSlug?: string | null,
  searchQuery?: string | null,
  styleSlug?: string | null,
  sortOption: DiscoverSortOption = DEFAULT_DISCOVER_SORT,
): Promise<DiscoverBatchResult> {
  // TEMPORARY diagnostic (Discover production-crash investigation,
  // commit 459b7de's regression) — `stage` is updated right before each
  // major phase below so an unexpected exception's log line says WHERE
  // in the loader it happened, not just that it happened. Remove once
  // the fix is confirmed stable in production.
  let stage = "auth";
  let userIdForLogging: string | null = null;

  try {
    return await fetchDiscoverBatchInner();
  } catch (error) {
    console.error("[DISCOVER_LOAD_FAILED]", {
      userId: userIdForLogging,
      stage,
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      supabaseCode: typeof error === "object" && error && "code" in error ? (error as { code?: unknown }).code : undefined,
    });
    return { listings: [], savedListingIds: [], rawCount: 0, error: error instanceof Error ? error.message : "Failed to load Discover." };
  }

  async function fetchDiscoverBatchInner(): Promise<DiscoverBatchResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  userIdForLogging = user?.id ?? null;

  // Best-effort — clears out stale reservations so they don't keep
  // hiding listings past their 15-minute window. No cron/background job
  // in this app, so this is the opportunistic substitute.
  await releaseExpiredReservations();

  // Computed up front (not after the `if (user)` block below, as before)
  // — the liked/feedback listing-attribute lookup just below needs to
  // know whether visual_analysis is selectable too.
  const hasIntelligenceColumns = await checkIntelligenceColumnsAvailable(supabase);
  const hasQualityScoreColumn = await checkQualityScoreColumnAvailable(supabase);
  const listingColumns = hasIntelligenceColumns ? `${LISTING_COLUMNS}, ${INTELLIGENCE_COLUMNS}` : LISTING_COLUMNS;
  const attributeColumns = `id, title, category, brand, color, price, aesthetic_tags${hasIntelligenceColumns ? ", visual_analysis" : ""}`;

  let preferences: string[] = [];
  let savedListingIds: string[] = [];
  let dislikedListingIds: string[] = [];
  let dislikedStyles: DislikedStyles = {};
  let favoriteBrands: string[] = [];
  let favoriteCategories: string[] = [];
  let favoriteColors: string[] = [];
  // Discover's own deterministic per-user style vector (Likes/onboarding/
  // positive-interaction history — see this file's own header comment
  // and discover-style-vector.ts). hasSignal: false is the correct
  // default for a signed-out user — scoreGarmentStyleMatch's neutral
  // baseline handles that case exactly like match-scoring.ts already
  // does for /match.
  let userStyleVector = buildUserStyleVector({
    now: Date.now(),
    styleProfile: null,
    likedListings: [],
    feedbackListings: [],
    hardExcludedAestheticKeys: new Set(),
  });

  if (user) {
    stage = "fetch_profile_likes_feedback";
    const [
      { data: styleProfile },
      { data: savedRows, error: savedItemsError },
      { data: dislikedRows, error: dislikedItemsError },
      { data: feedbackRows, error: feedbackError },
    ] = await Promise.all([
      supabase
        .from("style_profiles")
        .select("style_tags, favorite_brands, favorite_categories, favorite_colors, size_preference, disliked_styles")
        .eq("user_id", user.id)
        .maybeSingle(),
      supabase
        .from("saved_items")
        .select("listing_id, created_at")
        .eq("user_id", user.id)
        .not("listing_id", "is", null),
      supabase.from("disliked_items").select("listing_id").eq("user_id", user.id),
      // Positive-interaction history (15% of the style vector, see
      // discover-style-vector.ts's own header comment) — the append-only
      // behavioral log (src/lib/style-feedback.ts), distinct from
      // saved_items' CURRENT state: still includes items later unsaved,
      // and captures real purchases. "like" is never actually logged
      // anywhere in this codebase today (only save/skip/purchase are —
      // see style-feedback.ts's callers), so it's omitted from this
      // filter rather than silently matching nothing.
      supabase
        .from("user_style_feedback")
        .select("listing_id, created_at")
        .eq("user_id", user.id)
        .in("action", ["save", "purchase"])
        .not("listing_id", "is", null)
        .order("created_at", { ascending: false })
        .limit(150),
    ]);

    if (savedItemsError) {
      console.error("[discover-feed] Failed to fetch saved_items:", savedItemsError);
    }
    if (dislikedItemsError) {
      console.error("[discover-feed] Failed to fetch disliked_items:", dislikedItemsError);
    }
    if (feedbackError) {
      console.error("[discover-feed] Failed to fetch user_style_feedback:", feedbackError);
    }

    preferences = styleProfile?.style_tags ?? [];
    favoriteBrands = styleProfile?.favorite_brands ?? [];
    favoriteCategories = styleProfile?.favorite_categories ?? [];
    favoriteColors = styleProfile?.favorite_colors ?? [];
    dislikedStyles = styleProfile?.disliked_styles ?? {};
    savedListingIds = (savedRows ?? [])
      .map((row) => row.listing_id)
      .filter((id): id is string => Boolean(id));
    dislikedListingIds = (dislikedRows ?? [])
      .map((row) => row.listing_id)
      .filter((id): id is string => Boolean(id));

    const savedEntries = (savedRows ?? []).filter(
      (row): row is { listing_id: string; created_at: string } => Boolean(row.listing_id),
    );
    const feedbackEntries = (feedbackRows ?? []).filter(
      (row): row is { listing_id: string; created_at: string } => Boolean(row.listing_id),
    );

    stage = "fetch_liked_feedback_attributes";
    const attributeIds = [...new Set([...savedEntries.map((r) => r.listing_id), ...feedbackEntries.map((r) => r.listing_id)])];
    const attributesById = new Map<string, LikedListingAttributes>();
    if (attributeIds.length > 0) {
      const { data: attributeRows, error: attributeError } = await supabase
        .from("listings")
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- runtime-computed select string, see listingColumns' own comment above
        .select(attributeColumns as any)
        .in("id", attributeIds);

      if (attributeError) {
        console.error("[discover-feed] Failed to fetch liked/feedback listing attributes:", attributeError);
      }
      for (const row of (attributeRows ?? []) as unknown as LikedListingAttributes[]) {
        attributesById.set(row.id, row);
      }
    }

    const hardExcludedStyles = getHardExcludedStyleKeys(dislikedStyles, Date.now());

    stage = "build_style_vector";
    userStyleVector = buildUserStyleVector({
      now: Date.now(),
      styleProfile: { styleTags: preferences, favoriteBrands, favoriteCategories, favoriteColors },
      likedListings: savedEntries.flatMap(({ listing_id, created_at }) => {
        const listing = attributesById.get(listing_id);
        return listing ? [{ listing, occurredAt: created_at }] : [];
      }),
      feedbackListings: feedbackEntries.flatMap(({ listing_id, created_at }) => {
        const listing = attributesById.get(listing_id);
        return listing ? [{ listing, occurredAt: created_at }] : [];
      }),
      hardExcludedAestheticKeys: hardExcludedStyles,
    });
  }

  // reserved_by_order_id/reservation_expires_at may not exist on the live
  // DB yet (see supabase/schema.sql) — filtering on a missing column fails
  // the *entire* query, so this falls back to an unfiltered fetch (every
  // listing shows as available) rather than hiding the whole page.
  const availabilityFilter = await buildAvailabilityFilter(supabase, user?.id ?? null);
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
  // See RANKED_WINDOW's own comment — within the window, always fetch
  // from the top (0) so personalization has the whole window to rank,
  // then this function slices out [offset, offset+limit) from the RANKED
  // result below. Beyond the window, this reverts to fetching exactly
  // the requested page (the old behavior) since ranking an ever-growing
  // prefix on every call doesn't scale.
  const useRankedWindow = offset + limit <= RANKED_WINDOW;
  const rangeStart = useRankedWindow ? 0 : offset;
  const rangeEnd = useRankedWindow ? RANKED_WINDOW - 1 : offset + limit - 1;

  stage = "fetch_candidate_window";
  let query = supabase
    .from("listings")
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- runtime-computed select string, see listingColumns' own comment above
    .select(listingColumns as any)
    .or(availabilityFilter)
    .eq("status", "active")
    .order("created_at", { ascending: false })
    .order("id", { ascending: true })
    .range(rangeStart, rangeEnd);

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

    stage = "fetch_candidate_window_fallback";
    let statusOnlyQuery = supabase
      .from("listings")
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- runtime-computed select string, see listingColumns' own comment above
    .select(listingColumns as any)
      .eq("status", "active")
      .order("created_at", { ascending: false })
      .order("id", { ascending: true })
      .range(rangeStart, rangeEnd);

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

  // P0 first-60-seconds fix (item 4, staged recommendation strategy) — a
  // brand-new user has NO real signal for scoreGarmentStyleMatch to work
  // with: userStyleVector.hasSignal is false, so EVERY candidate gets the
  // exact same NEUTRAL_BASELINE_TOTAL score (discover-personalization.ts),
  // meaning the "personalized" primary sort key is actually a flat tie for
  // every listing and the feed silently falls back to its tiebreak
  // (price ascending) — a brand-new user's very first session was
  // effectively sorted CHEAPEST FIRST, not by anything resembling quality.
  // "Meaningful interaction" (this feature's own spec: likes, passes,
  // brand selections, style selections) is checked directly against data
  // already fetched above — no new queries. Below the threshold, ranking
  // uses fashionQualityScore (computed per-candidate just below, already
  // a composite of image quality/completeness/premium-brand-adjacent
  // signals — see computeFashionQualityScore's own weights) as the
  // primary signal instead of the meaningless flat personalization score,
  // so a cold-start feed actually leads with Lockette's best inventory
  // rather than an accidental price sort.
  const MIN_INTERACTIONS_FOR_PERSONALIZATION = 3;
  const interactionSignalCount = savedListingIds.length + dislikedListingIds.length;
  const hasOnboardingSignal = favoriteBrands.length > 0 || preferences.length > 0;
  const isColdStart = interactionSignalCount < MIN_INTERACTIONS_FOR_PERSONALIZATION && !hasOnboardingSignal;

  // matchPercent/stylePoints now come from the garment-level style match
  // against userStyleVector (discover-personalization.ts's
  // scoreGarmentStyleMatch — see this file's own header comment for why),
  // plus the fashionability quality gate (computeFashionQualityScore).
  // dislikedStyles is still only ever a scoring penalty here, subtracted
  // AFTER the garment-match total — never an exclusion; the only
  // exclusion in this whole pipeline remains the already-liked/
  // already-disliked filter just above.
  const now = Date.now();
  stage = "score_candidates";
  const scored: DiscoverSortEntry[] = unseenListings.map((listing) => {
    const breakdown = scoreGarmentStyleMatch(userStyleVector, {
      id: listing.id,
      title: listing.title,
      category: listing.category ?? null,
      brand: listing.brand,
      color: listing.color ?? null,
      price: listing.price,
      aestheticTags: listing.aesthetic_tags,
      visualAnalysis: listing.visual_analysis ?? null,
    });
    const dislikePenalty = assessListingAgainstDislikedStyles(listing.aesthetic_tags, dislikedStyles, now).penalty;

    const fashionQuality = computeFashionQualityScore({
      images: listing.images,
      imageUrl: listing.image_url,
      title: listing.title,
      aestheticTags: listing.aesthetic_tags,
      brand: listing.brand,
      category: listing.category ?? null,
      price: listing.price,
      qualityScore: hasQualityScoreColumn ? (listing.quality_score ?? null) : null,
      inventoryQualityScore: hasIntelligenceColumns ? (listing.inventory_quality_score ?? null) : null,
    });

    // P0 first-60-seconds fix (item 6) — normalized for DISPLAY only; the
    // raw 0-100 score (breakdown.total) is untouched above, so the
    // fashionability gate/sort logic just below (which compares raw
    // scores) and tests/discover-personalization.test.ts's own assertion
    // on breakdown.total are both unaffected. See
    // src/lib/match-percent-display.ts for why this is a rescale, not a
    // flat floor.
    const rawMatchScore = isColdStart
      ? Math.round(fashionQuality.score)
      : Math.max(0, Math.min(100, Math.round(breakdown.total - dislikePenalty)));
    const matchPercent = normalizeMatchPercentForDisplay(rawMatchScore);

    return { listing, matchPercent, stylePoints: breakdown.aestheticScore, fashionQualityScore: fashionQuality.score };
  });

  // Fashionability gate — personal relevance alone isn't sufficient
  // (this feature's own "CORE PRODUCT RULE" + "FASHIONABILITY GATE"
  // spec): candidates at/above FASHION_QUALITY_GATE always rank ahead of
  // everything below it, regardless of sortOption, with a graceful
  // backfill (the below-gate group, still sorted the same way) rather
  // than a hard filter — a page/window with too little qualifying
  // inventory shows its best available options instead of coming back
  // empty or short.
  stage = "gate_and_sort";
  const gatePassed = scored.filter((entry) => entry.fashionQualityScore >= FASHION_QUALITY_GATE);
  const gateFailed = scored.filter((entry) => entry.fashionQualityScore < FASHION_QUALITY_GATE);
  const rankedPool = [...sortDiscoverListings(gatePassed, sortOption), ...sortDiscoverListings(gateFailed, sortOption)];

  // Within the ranked window, `rankedPool` covers the WHOLE window (0 to
  // RANKED_WINDOW), so the requested page is sliced out of it here — see
  // RANKED_WINDOW's own comment. Beyond the window, the fetch above
  // already pulled exactly the requested page (rangeStart === offset), so
  // rankedPool already IS that page and needs no further slicing.
  const pageEntries = useRankedWindow ? rankedPool.slice(offset, offset + limit) : rankedPool;

  // rawCount stays about the RAW fetched rows for the CURRENT page, not
  // the filtered/gated count (see this function's own comment above
  // unseenListings) — within the ranked window, that's however many raw
  // window rows exist at/after `offset`, capped at `limit`; beyond the
  // window, `listings.length` already IS this exact page's raw count, as
  // it always was.
  const rawCount = useRankedWindow ? Math.min(limit, Math.max(0, listings.length - offset)) : listings.length;

  return {
    listings: pageEntries.map(({ listing, matchPercent, stylePoints }) => ({ ...listing, matchPercent, stylePoints })),
    savedListingIds,
    rawCount,
    error: null,
  };
  } // end fetchDiscoverBatchInner
}
