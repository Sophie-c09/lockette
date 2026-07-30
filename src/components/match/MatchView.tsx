"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Heart, ImageOff, Sparkles, X } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { Badge, tagVariantForIndex, type TagVariant } from "@/components/ui/Badge";
import { SwipeableCard, SWIPE_STACK_SIZE, type SwipeDirection } from "@/components/SwipeableCard";
import { saveListing } from "@/app/actions/saved-items";
import { dislikeListing } from "@/app/actions/dislikes";
import { superLikeListing } from "@/app/actions/cart";
import { loadMoreMatchListings } from "@/app/actions/match-feed";
import { MATCH_BATCH_SIZE, MATCH_PREFETCH_THRESHOLD } from "@/lib/pagination-constants";
import { useCart } from "@/components/CartProvider";
import { FlyingImage, type FlyingItem } from "@/components/match/FlyingImage";
import { StyleFeaturesPromo } from "@/components/StyleFeaturesPromo";
import type { Listing } from "@/lib/supabase/listings.types";

// Lightweight subset of Listing — matches exactly what /match's Supabase
// query selects (see src/app/(app)/match/page.tsx), not the full row.
// category/color aren't rendered on the card but are needed by
// attachMatchPercent's onboarding-quiz comparison (match-scoring.ts).
// Both are optional on the shared Listing type (the listing detail page's
// query doesn't select them) — overridden back to required here since
// /match's own query always does, and attachMatchPercent's generic
// constraint needs them non-optional.
export type MatchListing = Pick<
  Listing,
  "id" | "title" | "price" | "image_url" | "brand" | "size" | "aesthetic_tags" | "platform" | "product_url"
> & {
  category: string | null;
  color: string | null;
};

// What MatchView actually renders — the base listing shape plus the
// display-only matchPercent attached server-side by attachMatchPercent
// (src/lib/match-scoring.ts), *after* filtering/sorting has already run on
// the base MatchListing shape.
export type ScoredMatchListing = MatchListing & { matchPercent: number };

// Same tiers ListingCard/DiscoverView use for their own match-score badge.
function matchBadgeVariant(score: number): TagVariant {
  if (score >= 75) return "pink";
  if (score >= 40) return "teal";
  return "yellow";
}

type Direction = SwipeDirection;

// Thin content wrapper over the shared SwipeableCard gesture primitive
// (src/components/SwipeableCard.tsx, extracted from this exact function) —
// same drag/exit/tap-detection behavior as before, just no longer
// duplicated when the admin pending-review queue needed its own swipe
// deck (see AdminPendingSwipeView.tsx).
function SwipeCard({
  listing,
  stackIndex,
  exitDirection,
  onSwiped,
  onExitComplete,
  onSuperLike,
  onTap,
}: {
  listing: ScoredMatchListing;
  stackIndex: number;
  exitDirection: Direction | null;
  onSwiped: (direction: Direction) => void;
  onExitComplete: () => void;
  onSuperLike: (imageRect?: DOMRect) => void;
  onTap: () => void;
}) {
  const imageWrapperRef = useRef<HTMLDivElement>(null);

  return (
    <SwipeableCard
      stackIndex={stackIndex}
      exitDirection={exitDirection}
      onSwiped={onSwiped}
      onExitComplete={onExitComplete}
      onTap={onTap}
      onDoubleTap={onSuperLike}
      doubleTapRectRef={imageWrapperRef}
    >
      {({ isTop, translateX }) => (
        <Card className="flex h-full cursor-grab select-none flex-col overflow-hidden p-0 active:cursor-grabbing">
          <div ref={imageWrapperRef} className="relative aspect-[3/4] shrink-0 bg-inner">
            {listing.image_url ? (
              // eslint-disable-next-line @next/next/no-img-element -- arbitrary external marketplace domain, not known in advance
              <img
                src={listing.image_url}
                alt={listing.title}
                draggable={false}
                className="pointer-events-none absolute inset-0 h-full w-full object-cover"
              />
            ) : (
              <div className="flex h-full w-full items-center justify-center">
                <ImageOff className="h-8 w-8 text-muted" strokeWidth={1.5} />
              </div>
            )}

            {isTop && translateX > 20 && (
              <span className="absolute top-4 left-4 rounded-pill border-2 border-teal bg-white/90 px-3 py-1 text-sm font-semibold text-teal">
                LIKE
              </span>
            )}
            {isTop && translateX < -20 && (
              <span className="absolute top-4 right-4 rounded-pill border-2 border-oxblood bg-white/90 px-3 py-1 text-sm font-semibold text-oxblood">
                SKIP
              </span>
            )}

            <Badge
              variant={matchBadgeVariant(listing.matchPercent)}
              className="absolute bottom-2 left-2 shadow-soft"
            >
              {listing.matchPercent}% match
            </Badge>
          </div>

          <div className="flex flex-1 flex-col gap-2 p-4">
            <div className="flex items-start justify-between gap-2">
              <h3 className="font-display text-sm font-semibold leading-tight text-ink">
                {listing.title}
              </h3>
              {listing.price != null && (
                <span className="shrink-0 font-display text-sm font-semibold text-oxblood">
                  ${listing.price.toFixed(2)}
                </span>
              )}
            </div>

            {(listing.brand || listing.size) && (
              <p className="text-xs text-ink-soft">
                {[listing.brand, listing.size].filter(Boolean).join(" · ")}
              </p>
            )}

            {listing.aesthetic_tags.length > 0 && (
              <div className="mt-auto flex flex-wrap gap-1.5 pt-2">
                {listing.aesthetic_tags.map((tag, index) => (
                  <Badge key={tag} variant={tagVariantForIndex(index)} className="text-[11px]">
                    {tag}
                  </Badge>
                ))}
              </div>
            )}
          </div>
        </Card>
      )}
    </SwipeableCard>
  );
}

export function MatchView({
  initialListings,
  initialOffset,
  isSignedIn,
}: {
  initialListings: ScoredMatchListing[];
  initialOffset: number;
  isSignedIn: boolean;
}) {
  const router = useRouter();
  const { addToCart, cartLinkRef } = useCart();
  const [queue, setQueue] = useState(initialListings);
  const [exitDirection, setExitDirection] = useState<Direction | null>(null);
  const [flying, setFlying] = useState<FlyingItem | null>(null);
  // Which listing to drop from the deck once the in-flight fly-to-cart
  // animation for it finishes — kept separate from `flying` itself so the
  // dismiss only fires from FlyingImage's onDone, never before.
  const [pendingDismissId, setPendingDismissId] = useState<string | null>(null);

  // Refs, not state: these are read/written from inside an async prefetch
  // call and must never work off a stale snapshot the way a state closure
  // could — there's no need for them to trigger a re-render on their own.
  const offsetRef = useRef(initialOffset);
  const hasMoreRef = useRef(true);
  const loadingRef = useRef(false);
  const flyingIdRef = useRef(0);

  const topItem = queue[0];
  const visible = queue.slice(0, SWIPE_STACK_SIZE);

  // Prefetch the next batch once the queue runs low, well before the user
  // actually runs out — so swiping through the last few cards never has to
  // wait on a network round trip. Loops internally (rather than relying on
  // repeated effect re-runs) because a batch can come back with zero
  // survivors after filtering (already-liked / no tag overlap) even though
  // more raw rows exist — queue.length wouldn't change in that case, so an
  // effect keyed only on it would never fire again.
  useEffect(() => {
    if (queue.length >= MATCH_PREFETCH_THRESHOLD) return;
    if (!hasMoreRef.current || loadingRef.current) return;

    let cancelled = false;
    loadingRef.current = true;

    async function prefetchUntilQueueGrowsOrExhausted() {
      while (!cancelled && hasMoreRef.current) {
        try {
          const result = await loadMoreMatchListings(offsetRef.current);
          if (result.error) {
            hasMoreRef.current = false;
            break;
          }

          offsetRef.current += MATCH_BATCH_SIZE;
          if (result.rawCount < MATCH_BATCH_SIZE) hasMoreRef.current = false;

          if (result.listings.length > 0) {
            if (!cancelled) {
              setQueue((current) => [...current, ...result.listings]);
            }
            break;
          }
          // This batch's raw rows all got filtered out — try the next one.
        } catch {
          hasMoreRef.current = false;
          break;
        }
      }
      loadingRef.current = false;
    }

    prefetchUntilQueueGrowsOrExhausted();
    return () => {
      cancelled = true;
    };
  }, [queue.length]);

  function handleSwipe(direction: Direction) {
    if (!topItem || exitDirection) return;
    setExitDirection(direction);

    if (direction === "right") {
      // Fire-and-forget: persisting a like shouldn't block the swipe
      // animation, and signed-out browsing should still feel instant.
      saveListing(topItem.id).catch(() => {});
    } else {
      // Persist the skip (disliked_items) so this listing stays gone on
      // refresh/re-login/a new device, not just for the rest of this
      // in-memory queue — same fire-and-forget reasoning as the like above.
      dislikeListing(topItem.id).catch(() => {});
    }
  }

  function handleExitComplete() {
    setQueue((current) => current.slice(1));
    setExitDirection(null);
  }

  // A genuine single tap (not the first half of a double-tap) opens the
  // listing's full detail page — same destination Discover/Feed cards
  // link to.
  function handleTap(listingId: string) {
    router.push(`/listing/${listingId}`);
  }

  // Drops a superliked listing from the deck (advancing to the next one),
  // once its cart animation — or the lack of one — has finished playing.
  function dismissFromDeck(listingId: string) {
    setQueue((current) => {
      const next = current.filter((listing) => listing.id !== listingId);
      console.log("[super-like-dismiss]", {
        listingId,
        removedFromDeck: true,
        remainingCards: next.length,
      });
      return next;
    });
  }

  // Double tap on the top card: a super-like both likes and adds to cart,
  // then removes the card from the deck once the fly-to-cart animation
  // finishes (immediately if there's no animation to play). Signed-out taps
  // are sent to /login rather than failing silently — unlike a plain
  // swipe-right like, which stays a silent no-op for anonymous browsing.
  function handleSuperLike(imageRect?: DOMRect) {
    if (!topItem) return;

    if (!isSignedIn) {
      router.push("/login");
      return;
    }

    const listingId = topItem.id;

    addToCart({
      id: topItem.id,
      name: topItem.title,
      image: topItem.image_url,
      price: topItem.price ?? 0,
      brand: topItem.brand,
      platform: topItem.platform,
      productUrl: topItem.product_url,
      // shipping_cost isn't selected by /match's query (see match-feed.ts)
      // since the column doesn't exist on the live DB yet — omitted here
      // rather than passing a stale 0; CartItem.shippingCost is optional.
    });

    // Fire-and-forget, same reasoning as the plain swipe-right like above —
    // the animation/UI feedback is already optimistic and shouldn't wait on
    // the network round trip.
    superLikeListing(listingId).catch(() => {});

    const to = cartLinkRef.current?.getBoundingClientRect();
    if (imageRect && topItem.image_url && to) {
      flyingIdRef.current += 1;
      setPendingDismissId(listingId);
      setFlying({ id: flyingIdRef.current, image: topItem.image_url, from: imageRect, to });
    } else {
      // Nothing to animate (no image / no rect) — nothing to wait for.
      dismissFromDeck(listingId);
    }
  }

  return (
    <div className="flex min-h-[calc(100vh-137px)] flex-col items-center px-6 pt-12 pb-16">
      <div className="mb-8 text-center">
        <span className="font-display text-sm uppercase tracking-[0.2em] text-oxblood">
          Match
        </span>
        <h1 className="mt-2 font-display text-3xl font-semibold text-ink sm:text-4xl">
          Swipe your way to your next favorite find
        </h1>
      </div>

      <div className="relative h-[520px] w-full max-w-sm">
        {topItem ? (
          visible.map((listing, index) => (
            <SwipeCard
              key={listing.id}
              listing={listing}
              stackIndex={index}
              exitDirection={index === 0 ? exitDirection : null}
              onSwiped={handleSwipe}
              onExitComplete={handleExitComplete}
              onSuperLike={handleSuperLike}
              onTap={() => handleTap(listing.id)}
            />
          ))
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-4 rounded-card border border-dashed border-border-button bg-highlight-cream px-8 text-center">
            <Sparkles className="h-8 w-8 text-oxblood" strokeWidth={1.5} />
            <p className="max-w-xs text-sm text-ink-soft">
              No more matches — import more or like more items to improve your
              feed
            </p>
          </div>
        )}
      </div>

      {topItem && (
        <div className="mt-10 flex items-center gap-6">
          <button
            type="button"
            onClick={() => handleSwipe("left")}
            aria-label="Skip"
            className="flex h-16 w-16 cursor-pointer items-center justify-center rounded-full border-2 border-border bg-surface text-ink-soft shadow-soft transition-transform hover:scale-105 hover:border-oxblood hover:text-oxblood active:scale-95"
          >
            <X className="h-7 w-7" strokeWidth={2} />
          </button>
          <button
            type="button"
            onClick={() => handleSwipe("right")}
            aria-label="Like"
            className="flex h-16 w-16 cursor-pointer items-center justify-center rounded-full bg-oxblood text-white shadow-card transition-transform hover:scale-105 active:scale-95"
          >
            <Heart className="h-7 w-7" strokeWidth={2} />
          </button>
        </div>
      )}

      <StyleFeaturesPromo className="mt-10" />

      {flying && (
        <FlyingImage
          flying={flying}
          onDone={() => {
            setFlying(null);
            if (pendingDismissId) {
              dismissFromDeck(pendingDismissId);
              setPendingDismissId(null);
            }
          }}
        />
      )}
    </div>
  );
}
