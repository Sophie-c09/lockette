"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Sparkles, Camera, X, Loader2 } from "lucide-react";
import { ListingCard } from "@/components/listing/ListingCard";
import { StyleFeaturesPromo } from "@/components/StyleFeaturesPromo";
import { loadMoreDiscoverListings, searchDiscoverByPhoto } from "@/app/actions/discover-feed";
import { DISCOVER_BATCH_SIZE } from "@/lib/pagination-constants";
import { ITEM_TYPE_CATEGORIES } from "@/lib/item-type-categories";
import { useToast } from "@/components/ToastProvider";
import type { Listing } from "@/lib/supabase/listings.types";

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
}: {
  initialListings: Listing[];
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
}) {
  // `listings` is the ONLY state driving what's on screen — it starts
  // from the already server-scored/ordered `initialListings`
  // (fetchDiscoverBatch — onboarding preference + liked-tag scoring,
  // untouched by this change) and only ever grows as more pages load.
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
    // combining all four — see discover/page.tsx) whenever any active
    // filter actually changes, rather than this effect re-running
    // mid-session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadNextBatch() {
    if (!hasMoreRef.current || loadingRef.current) return;
    loadingRef.current = true;

    try {
      while (hasMoreRef.current) {
        const result = await loadMoreDiscoverListings(offsetRef.current, categorySlug, typeSlug, searchQuery, styleSlug);
        if (result.error) {
          hasMoreRef.current = false;
          break;
        }

        offsetRef.current += DISCOVER_BATCH_SIZE;
        if (result.rawCount < DISCOVER_BATCH_SIZE) hasMoreRef.current = false;

        if (result.listings.length > 0) {
          setListings((current) => [...current, ...result.listings]);
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

  // Preserves the current category/search/style filters while toggling
  // the item-type filter on/off — clicking the already-active pill clears
  // just that axis (slug=null), clicking any other pill switches to it.
  function typeHref(slug: string | null) {
    const params = new URLSearchParams();
    if (categorySlug) params.set("category", categorySlug);
    if (slug) params.set("type", slug);
    if (searchQuery) params.set("query", searchQuery);
    if (styleSlug) params.set("style", styleSlug);
    const qs = params.toString();
    return qs ? `/discover?${qs}` : "/discover";
  }

  const showingLabel = [categoryLabel, typeLabel, searchQuery ? `"${searchQuery}"` : null]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="flex min-h-[calc(100vh-137px)] flex-col px-6 pt-12 pb-16">
      <div className="mx-auto w-full max-w-6xl">
        <div className="mb-8 text-center">
          <span className="font-display text-sm uppercase tracking-[0.2em] text-oxblood">
            Discover
          </span>
          <h1 className="mt-2 font-display text-3xl font-semibold text-ink sm:text-4xl">
            {styleLabel ?? "Browse real secondhand finds"}
          </h1>
          {styleDescription && (
            <p className="mt-2 text-sm text-ink-soft">{styleDescription}</p>
          )}

          {showingLabel && (
            <p className="mt-3 text-sm text-ink-soft">
              Showing: <span className="font-medium text-ink">{showingLabel}</span>{" "}
              <Link href="/discover" className="text-oxblood underline underline-offset-4">
                Clear filters
              </Link>
            </p>
          )}

          <div className="mt-5 flex flex-wrap justify-center gap-2">
            {ITEM_TYPE_CATEGORIES.map((type) => {
              const active = type.slug === typeSlug;
              return (
                <Link
                  key={type.slug}
                  href={typeHref(active ? null : type.slug)}
                  aria-pressed={active}
                  className={`rounded-pill border px-4 py-1.5 text-sm font-medium transition-colors ${
                    active
                      ? "border-oxblood bg-oxblood text-white"
                      : "border-border bg-surface text-ink-soft hover:border-oxblood hover:text-ink"
                  }`}
                >
                  {type.label}
                </Link>
              );
            })}
          </div>

          <div className="mt-5 flex flex-col items-center gap-2">
            {photoSearchActive ? (
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
            ) : (
              <>
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
                  className="inline-flex items-center gap-2 rounded-pill border border-border bg-surface px-4 py-1.5 text-sm font-medium text-ink-soft transition-colors hover:border-oxblood hover:text-ink disabled:opacity-60"
                >
                  {photoSearchLoading ? (
                    <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2} />
                  ) : (
                    <Camera className="h-4 w-4" strokeWidth={1.75} />
                  )}
                  {photoSearchLoading ? "Searching..." : "Search by photo"}
                </button>
              </>
            )}
          </div>
        </div>

        {listings.length > 0 ? (
          <>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
              {listings.map((listing) => (
                <ListingCard
                  key={listing.id}
                  listing={listing}
                  isAdmin={isAdmin}
                  showSaveButton
                  initialSaved={savedListingIds.has(listing.id)}
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
