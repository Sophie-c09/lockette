"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Sparkles, Camera, X, Loader2, ChevronDown } from "lucide-react";
import { ListingCard } from "@/components/listing/ListingCard";
import { StyleFeaturesPromo } from "@/components/StyleFeaturesPromo";
import { loadMoreDiscoverListings, searchDiscoverByPhoto } from "@/app/actions/discover-feed";
import { DISCOVER_BATCH_SIZE } from "@/lib/pagination-constants";
import { ITEM_TYPE_CATEGORIES } from "@/lib/item-type-categories";
import { useToast } from "@/components/ToastProvider";
import type { ScoredDiscoverListing } from "@/lib/discover-feed";
// applyDiscoverSort/DiscoverSortOption come from discover-sort.ts, NOT
// discover-feed.ts — this component is "use client", and discover-feed.ts
// imports @/lib/supabase/server (a server-only module), so importing a
// VALUE (not just a type) from it here would break the client bundle.
// Switching the sort dropdown re-sorts the already-loaded `listings`
// state directly with this same shared logic, instead of navigating to a
// new URL — see this feature's own "do not trigger a full reload when
// switching back to Default" requirement, and discover-sort.ts's own
// header comment.
import { applyDiscoverSort, type DiscoverSortOption, type DiscoverSortKeys } from "@/lib/discover-sort";

const SORT_OPTIONS: { value: DiscoverSortOption; label: string }[] = [
  { value: "", label: "Default" },
  { value: "recent", label: "Most Recent" },
  { value: "price_asc", label: "Price: Low to High" },
  { value: "price_desc", label: "Price: High to Low" },
];

function listingSortKeys(listing: ScoredDiscoverListing): DiscoverSortKeys {
  return { id: listing.id, price: listing.price, createdAt: listing.created_at, matchPercent: listing.matchPercent };
}

// Continuous, scroll-based browsing feed — a grid of ListingCard (same
// shared card Match's "More Like This"-style surfaces and Style Me's
// reveal bundle use), NOT a swipe deck: /match is the only page in this
// app meant to use swipe interactions (src/components/match/MatchView.tsx).
// Pagination is IntersectionObserver-driven (a sentinel div near the
// bottom of the grid triggers the next batch) rather than swipe-queue-
// driven — see loadMoreDiscoverListings's own comment
// (src/app/actions/discover-feed.ts) for why that's the intended shape.
export function DiscoverView({
  initialListings,
  initialSavedListingIds,
  initialOffset,
  isAdmin = false,
  categorySlug = null,
  categoryLabel = null,
  typeSlug = null,
  typeLabel = null,
  searchQuery = null,
  styleSlug = null,
  styleLabel = null,
  styleDescription = null,
  sortOption: initialSortOption = "",
}: {
  initialListings: ScoredDiscoverListing[];
  initialSavedListingIds: string[];
  initialOffset: number;
  isAdmin?: boolean;
  // From the homepage's category cards (?category=<slug>) — see
  // discover/page.tsx, which already resolved and validated the slug
  // server-side. categorySlug is re-sent on every "load more" call so
  // infinite scroll keeps pulling from the same filtered set;
  // categoryLabel is just for the "Showing: X" header text.
  categorySlug?: string | null;
  categoryLabel?: string | null;
  // The second, independent filter axis (?type=<slug>, item type — Tops,
  // Dresses, etc.) — same server-resolved/validated pattern as
  // categorySlug/categoryLabel above.
  typeSlug?: string | null;
  typeLabel?: string | null;
  // The third, independent filter axis (?query=<search terms>) — no
  // longer fed by the homepage (which now links ?style=<slug> instead,
  // see aesthetic-categories.ts), but still fully functional for anyone
  // linking to it directly. Re-sent on every "load more" call, same as
  // categorySlug/typeSlug.
  searchQuery?: string | null;
  // The current homepage entry point (?style=<slug>, "shop by vibe" —
  // see aesthetic-categories.ts). Filtered hybrid (exact tag OR
  // fallback-term text match) server-side in discover-feed.ts so a style
  // page is never empty. Gets its own <h1>/description treatment below
  // rather than folding into the generic "Showing: X" line, since it's
  // the primary way people now land on this page.
  styleSlug?: string | null;
  styleLabel?: string | null;
  styleDescription?: string | null;
  // The INITIAL sort-control selection (?sort=<option>, discover/page.tsx —
  // already validated/defaulted server-side via parseDiscoverSortOption).
  // Only used to seed this component's own `sortOption` state below —
  // switching the dropdown afterward is handled entirely client-side
  // (see that state's own comment), never by re-sending this prop.
  sortOption?: DiscoverSortOption;
}) {
  // Client-side sort selection — deliberately its OWN state, not derived
  // from the `sortOption` prop on every render: switching the dropdown
  // must re-sort the already-loaded `listings` instantly, with no server
  // round-trip and no DiscoverView remount (this feature's own "do not
  // trigger a full reload when switching back to Default" requirement).
  // Re-initializes from a FRESH `initialSortOption` only when the
  // category/type/search/style filters actually change and this
  // component gets a genuinely new `key` (see discover/page.tsx) — a real
  // navigation, which legitimately does need a fresh server fetch.
  const [sortOption, setSortOption] = useState<DiscoverSortOption>(initialSortOption);
  // Read inside loadNextBatch/the IntersectionObserver effect below,
  // which — like offsetRef/hasMoreRef/loadingRef — must never see a stale
  // closed-over value: the effect that wires up the observer only runs
  // once, so a plain closure over `sortOption` would keep using whatever
  // it was when the effect first ran, even after the user changes the
  // dropdown. Synced via its own effect (not written directly during
  // render) — refs must never be mutated during render.
  const sortOptionRef = useRef(sortOption);
  useEffect(() => {
    sortOptionRef.current = sortOption;
  }, [sortOption]);

  // `listings` is the ONLY state driving what's on screen — it starts
  // from the already server-scored/ordered `initialListings`
  // (fetchDiscoverBatch — matchPercent/stylePoints attached via
  // match-scoring.ts, sorted per sortOption) and only ever grows as more
  // pages load.
  const [listings, setListings] = useState(initialListings);
  // Accumulated across every loaded batch, not just the first — each
  // batch's own savedListingIds (fetchDiscoverBatch's return shape) may
  // include listings saved on a previous visit that only show up in a
  // later page, and ListingCard needs this to pre-fill that card's own
  // SaveButton as already-filled.
  const [savedListingIds, setSavedListingIds] = useState(() => new Set(initialSavedListingIds));

  // Refs, not state: read/written from inside an async prefetch loop — a
  // stale-state closure would silently re-fetch the same page twice or
  // stop paginating too early.
  const offsetRef = useRef(initialOffset);
  const hasMoreRef = useRef(true);
  const loadingRef = useRef(false);
  const sentinelRef = useRef<HTMLDivElement>(null);

  // Hybrid image + semantic search ("search by photo") — an entirely
  // separate mode layered on top of the ordinary paginated grid above,
  // never replacing it (searchDiscoverByPhoto,
  // src/app/actions/discover-feed.ts). Active photo-search results
  // REPLACE `listings`/`savedListingIds` outright (a single bounded
  // batch, not paginated further — see handlePhotoFileChange below,
  // which also sets hasMoreRef.current = false so the scroll-sentinel
  // effect above becomes a no-op while a photo search is showing).
  // Clearing restores the original server-rendered page exactly.
  const { showToast } = useToast();
  const [photoSearchActive, setPhotoSearchActive] = useState(false);
  const [photoSearchLoading, setPhotoSearchLoading] = useState(false);
  const [photoSearchUsedFallback, setPhotoSearchUsedFallback] = useState(false);
  const photoInputRef = useRef<HTMLInputElement>(null);

  async function handlePhotoFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = ""; // allow re-selecting the same file later
    if (!file) return;

    setPhotoSearchLoading(true);
    try {
      const formData = new FormData();
      formData.set("image", file);
      const result = await searchDiscoverByPhoto(formData, categorySlug, typeSlug, searchQuery, styleSlug);

      if (result.error) {
        showToast(result.error);
        return;
      }

      hasMoreRef.current = false; // photo search is one bounded batch, not paginated
      setListings(result.listings);
      setSavedListingIds(new Set(result.savedListingIds));
      setPhotoSearchUsedFallback(result.usedFallback);
      setPhotoSearchActive(true);

      if (result.listings.length === 0) {
        showToast("Couldn't find anything close to that photo yet.");
      }
    } catch {
      showToast("Something went wrong searching by photo. Please try again.");
    } finally {
      setPhotoSearchLoading(false);
    }
  }

  function handleClearPhotoSearch() {
    setPhotoSearchActive(false);
    setPhotoSearchUsedFallback(false);
    setListings(initialListings);
    setSavedListingIds(new Set(initialSavedListingIds));
    offsetRef.current = initialOffset;
    hasMoreRef.current = true;
  }

  // IntersectionObserver-driven "load more" — fires once the sentinel
  // near the bottom of the grid scrolls into view, instead of a manual
  // "Load More" button. Loops internally (rather than relying on a
  // single fetch per intersection) because a batch can come back with
  // zero survivors after filtering (already-saved/disliked) even though
  // more raw rows exist — the sentinel would stay intersecting but
  // nothing else would trigger another attempt otherwise.
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;

    const observer = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting) {
        void loadNextBatch();
      }
    });

    observer.observe(sentinel);
    return () => observer.disconnect();

    // categorySlug/typeSlug/searchQuery/styleSlug are stable for this
    // component's lifetime — DiscoverView is remounted (via a `key`
    // combining all four plus the sort that was active at that navigation
    // — see discover/page.tsx) whenever any of them actually changes,
    // rather than this effect re-running mid-session. sortOption is
    // genuinely NOT stable (the dropdown changes it client-side without a
    // remount — see handleSortChange), which is exactly why loadNextBatch
    // reads sortOptionRef.current instead of closing over the sortOption
    // variable directly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadNextBatch() {
    if (!hasMoreRef.current || loadingRef.current) return;
    loadingRef.current = true;

    try {
      while (hasMoreRef.current) {
        const result = await loadMoreDiscoverListings(
          offsetRef.current,
          categorySlug,
          typeSlug,
          searchQuery,
          styleSlug,
          sortOptionRef.current,
        );
        if (result.error) {
          hasMoreRef.current = false;
          break;
        }

        offsetRef.current += DISCOVER_BATCH_SIZE;
        if (result.rawCount < DISCOVER_BATCH_SIZE) hasMoreRef.current = false;

        if (result.listings.length > 0) {
          // Each page is fetched (and sorted) independently server-side,
          // so a naive append wouldn't be correctly ordered as a WHOLE
          // set once combined (e.g. price_asc within page 1 followed by
          // price_asc within page 2 isn't price_asc across all 120) — this
          // re-applies the current sort across the full accumulated list,
          // same shared logic the dropdown's own onChange uses below.
          setListings((current) => applyDiscoverSort([...current, ...result.listings], sortOptionRef.current, listingSortKeys));
          setSavedListingIds((current) => new Set([...current, ...result.savedListingIds]));
          break;
        }
        // This batch's raw rows all got filtered out (already saved/
        // disliked) — try the next one instead of leaving the sentinel
        // stuck with nothing to show for it.
      }
    } catch {
      hasMoreRef.current = false;
    } finally {
      loadingRef.current = false;
    }
  }

  // Preserves the current category/search/style/sort filters while
  // toggling the item-type filter on/off — clicking the already-active
  // pill clears just that axis (slug=null), clicking any other pill
  // switches to it.
  function typeHref(slug: string | null) {
    const params = new URLSearchParams();
    if (categorySlug) params.set("category", categorySlug);
    if (slug) params.set("type", slug);
    if (searchQuery) params.set("query", searchQuery);
    if (styleSlug) params.set("style", styleSlug);
    if (sortOption !== "") params.set("sort", sortOption);
    const qs = params.toString();
    return qs ? `/discover?${qs}` : "/discover";
  }

  // Same preserve-everything-else pattern as typeHref above, but swapping
  // the sort axis instead of type — "" (Default) is the default, so it's
  // simply omitted from the URL rather than written out as ?sort=,
  // matching how every other filter here only appears in the querystring
  // when it's actually non-default. Used only to keep the address bar
  // (bookmarking/sharing) in sync — see this function's own caller below,
  // which updates the URL via history.replaceState rather than a real
  // navigation, so switching sort never remounts this component.
  function sortHref(option: DiscoverSortOption) {
    const params = new URLSearchParams();
    if (categorySlug) params.set("category", categorySlug);
    if (typeSlug) params.set("type", typeSlug);
    if (searchQuery) params.set("query", searchQuery);
    if (styleSlug) params.set("style", styleSlug);
    if (option !== "") params.set("sort", option);
    const qs = params.toString();
    return qs ? `/discover?${qs}` : "/discover";
  }

  // Re-sorts the already-loaded `listings` instantly (client-side only —
  // this feature's own "do not trigger a full reload when switching back
  // to Default" requirement) and keeps the address bar in sync for
  // bookmarking/sharing via history.replaceState — deliberately NOT
  // router.push/replace, since either would re-run discover/page.tsx's
  // Server Component and, because its `key` includes the active sort,
  // remount this whole component (losing every page loaded past the
  // first). Selecting "" (Default) restores the personalized ranking
  // exactly, since applyDiscoverSort always recomputes it fresh from
  // matchPercent rather than remembering any prior display order.
  function handleSortChange(next: DiscoverSortOption) {
    setSortOption(next);
    setListings((current) => applyDiscoverSort(current, next, listingSortKeys));
    if (typeof window !== "undefined") {
      window.history.replaceState(null, "", sortHref(next));
    }
  }

  const showingLabel = [categoryLabel, typeLabel, searchQuery ? `"${searchQuery}"` : null]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="flex min-h-[calc(100vh-137px)] flex-col px-6 pt-6 pb-16 sm:pt-8">
      <div className="mx-auto w-full max-w-6xl">
        {/* Compact editorial header — left-aligned with the grid below it
            rather than a large centered hero block, per the redesign
            brief. styleLabel/styleDescription (an active "shop by vibe"
            filter — see this component's own prop comments) still take
            priority when present, since that's real filter-state context,
            not just decorative copy; the eyebrow/heading/support copy
            below are only the DEFAULT (no style active) treatment. */}
        <div className="mb-5">
          <span className="font-display text-xs font-semibold uppercase tracking-[0.25em] text-oxblood">
            Your Edit
          </span>
          <h1 className="mt-1 font-display text-2xl font-semibold text-ink sm:text-3xl">
            {styleLabel ?? "Find your next favorite"}
          </h1>
          {styleDescription ? (
            <p className="mt-1 text-sm text-ink-soft">{styleDescription}</p>
          ) : !styleLabel ? (
            <p className="mt-1 text-sm text-ink-soft">
              Secondhand pieces selected for your style
            </p>
          ) : null}

          {showingLabel && (
            <p className="mt-2 text-sm text-ink-soft">
              Showing: <span className="font-medium text-ink">{showingLabel}</span>{" "}
              <Link href="/discover" className="text-oxblood underline underline-offset-4">
                Clear filters
              </Link>
            </p>
          )}
        </div>

        {/* Category pills — a single horizontally-scrollable row (never
            wraps to multiple lines) so mobile stays tidy without an
            awkward ragged-edge wrap. */}
        <div className="mb-4 flex gap-1.5 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {ITEM_TYPE_CATEGORIES.map((type) => {
            const active = type.slug === typeSlug;
            return (
              <Link
                key={type.slug}
                href={typeHref(active ? null : type.slug)}
                aria-pressed={active}
                className={`shrink-0 whitespace-nowrap rounded-pill border px-3 py-1 text-xs font-medium transition-colors ${
                  active
                    ? "border-teal bg-teal text-white"
                    : "border-teal/25 bg-highlight-cream/40 text-ink-soft hover:border-teal hover:text-ink"
                }`}
              >
                {type.label}
              </Link>
            );
          })}
        </div>

        {/* Control row — one compact toolbar (result context on the left,
            sort + photo search on the right) instead of two separate,
            centered, stacked rows. */}
        {photoSearchActive ? (
          <div className="mb-6 flex items-center justify-center gap-2 text-center">
            <p className="text-sm text-ink-soft">
              Showing closest matches to your photo
              {photoSearchUsedFallback && " (padded out with closest-category picks)"} ·{" "}
              <button
                type="button"
                onClick={handleClearPhotoSearch}
                className="inline-flex items-center gap-1 text-oxblood underline underline-offset-4"
              >
                <X className="h-3.5 w-3.5" strokeWidth={2} />
                Clear photo search
              </button>
            </p>
          </div>
        ) : (
          <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs font-medium uppercase tracking-wide text-ink-soft">
              Recommended for you
            </p>

            <div className="flex items-center gap-2">
              {/* Native <select> underneath (keeps real keyboard/native
                  dropdown behavior) — appearance-none + a custom chevron
                  on top is what gives it the "understated fashion filter"
                  look instead of a browser-default control. */}
              <div className="relative">
                <select
                  id="discover-sort"
                  aria-label="Sort listings"
                  value={sortOption}
                  onChange={(event) => handleSortChange(event.target.value as DiscoverSortOption)}
                  className="appearance-none rounded-pill border border-teal/25 bg-highlight-cream/40 py-1.5 pl-3 pr-7 text-xs font-medium text-ink focus:border-teal focus:outline-none"
                >
                  {SORT_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
                <ChevronDown
                  className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-soft"
                  strokeWidth={2}
                />
              </div>

              <input
                ref={photoInputRef}
                type="file"
                accept="image/jpeg,image/png,image/webp,image/gif"
                className="hidden"
                onChange={handlePhotoFileChange}
              />
              <button
                type="button"
                onClick={() => photoInputRef.current?.click()}
                disabled={photoSearchLoading}
                aria-label="Search by photo"
                className="flex items-center gap-1.5 rounded-pill border border-teal/25 bg-highlight-cream/40 px-3 py-1.5 text-xs font-medium text-ink-soft transition-colors hover:border-teal hover:text-ink disabled:opacity-60"
              >
                {photoSearchLoading ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2} />
                ) : (
                  <Camera className="h-3.5 w-3.5" strokeWidth={1.75} />
                )}
                <span className="hidden sm:inline">
                  {photoSearchLoading ? "Searching…" : "Search by photo"}
                </span>
              </button>
            </div>
          </div>
        )}

        {listings.length > 0 ? (
          <>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              {listings.map((listing) => (
                <ListingCard
                  key={listing.id}
                  listing={listing}
                  isAdmin={isAdmin}
                  showSaveButton
                  initialSaved={savedListingIds.has(listing.id)}
                  matchScore={listing.matchPercent}
                  stylePoints={listing.stylePoints}
                />
              ))}
            </div>
            {/* Sentinel for the IntersectionObserver above — invisible,
                just a scroll-position trigger near the bottom of the grid. */}
            <div ref={sentinelRef} className="h-1 w-full" aria-hidden="true" />
          </>
        ) : (
          <div className="flex min-h-[320px] flex-col items-center justify-center gap-4 rounded-card border border-dashed border-border-button bg-highlight-cream px-8 text-center">
            <Sparkles className="h-8 w-8 text-oxblood" strokeWidth={1.5} />
            {photoSearchActive ? (
              <>
                <p className="text-sm text-ink-soft">Couldn&apos;t find anything close to that photo yet.</p>
                <button
                  type="button"
                  onClick={handleClearPhotoSearch}
                  className="text-sm text-oxblood underline underline-offset-4"
                >
                  Browse everything
                </button>
              </>
            ) : showingLabel || styleLabel ? (
              <>
                <p className="text-sm text-ink-soft">
                  No {[styleLabel, showingLabel].filter(Boolean).join(" · ")} finds yet — check
                  back soon.
                </p>
                <Link href="/discover" className="text-sm text-oxblood underline underline-offset-4">
                  Browse everything
                </Link>
              </>
            ) : (
              <p className="max-w-xs text-sm text-ink-soft">
                No thrift finds yet — import listings to start building the
                marketplace.
              </p>
            )}
          </div>
        )}
      </div>

      <StyleFeaturesPromo className="mt-10" />
    </div>
  );
}
