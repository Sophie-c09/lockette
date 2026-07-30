"use client";

import { useState } from "react";
import { ImageOff, Sparkles } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { Badge, tagVariantForIndex, type TagVariant } from "@/components/ui/Badge";
import { SwipeableCard, SWIPE_STACK_SIZE, type SwipeDirection } from "@/components/SwipeableCard";
import type { ModeratedListing } from "@/lib/listingModeration";

// Swipe-card review queue for /admin/listings' Flagged filter — same
// swipe-gesture primitive (SwipeableCard) match/MatchView.tsx uses for its
// own discovery deck, not a second, drifting copy of the drag/exit-
// animation mechanics. Content and actions are review-specific: approve
// (swipe right) / reject (swipe left) a flagged listing instead of like/
// skip a live one.
function qualityBadgeVariant(score: number): TagVariant {
  if (score >= 75) return "pink";
  if (score >= 40) return "teal";
  return "yellow";
}

// Same "images array, falling back to the single image_url" convention as
// AdminListingCard.tsx's own photosFor — just the first photo, since this
// card only ever shows one image at a time (matching MatchView's own
// single-image swipe card, not the full-gallery AdminImageGallery the list
// view uses).
function primaryImage(listing: Pick<ModeratedListing, "images" | "image_url">): string | null {
  if (Array.isArray(listing.images) && listing.images.length > 0) return listing.images[0];
  return listing.image_url;
}

function ReviewSwipeCard({
  listing,
  stackIndex,
  exitDirection,
  onSwiped,
  onExitComplete,
}: {
  listing: ModeratedListing;
  stackIndex: number;
  exitDirection: SwipeDirection | null;
  onSwiped: (direction: SwipeDirection) => void;
  onExitComplete: () => void;
}) {
  const image = primaryImage(listing);

  return (
    <SwipeableCard
      stackIndex={stackIndex}
      exitDirection={exitDirection}
      onSwiped={onSwiped}
      onExitComplete={onExitComplete}
    >
      {({ isTop, translateX }) => (
        <Card className="flex h-full cursor-grab select-none flex-col overflow-hidden p-0 active:cursor-grabbing">
          <div className="relative aspect-[3/4] shrink-0 bg-inner">
            {image ? (
              // eslint-disable-next-line @next/next/no-img-element -- arbitrary external marketplace domain, not known in advance
              <img
                src={image}
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
                APPROVE
              </span>
            )}
            {isTop && translateX < -20 && (
              <span className="absolute top-4 right-4 rounded-pill border-2 border-oxblood bg-white/90 px-3 py-1 text-sm font-semibold text-oxblood">
                REJECT
              </span>
            )}

            {listing.quality_score != null && (
              <Badge
                variant={qualityBadgeVariant(listing.quality_score)}
                className="absolute bottom-2 left-2 shadow-soft"
              >
                Quality {listing.quality_score}
              </Badge>
            )}
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

            {(listing.brand || listing.platform) && (
              <p className="text-xs text-ink-soft">
                {[listing.brand, listing.platform].filter(Boolean).join(" · ")}
              </p>
            )}

            {listing.flag_reason && (
              <p className="text-xs font-medium text-oxblood">Flagged: {listing.flag_reason}</p>
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

export function AdminPendingSwipeView({
  initialItems,
  onApprove,
  onReject,
}: {
  initialItems: ModeratedListing[];
  onApprove: (listingId: string) => void;
  onReject: (listingId: string) => void;
}) {
  // Seeded once from the Flagged filter's initial fetch, then managed
  // entirely by this view's own swipes — same "own queue, not re-derived
  // from a prop that changes shape mid-animation" posture as MatchView's
  // own `queue` state. AdminListingsView conditionally renders this
  // component only while filter === "flagged", so switching away and back
  // fully unmounts/remounts it — a fresh fetch always means a fresh queue,
  // with no extra sync logic needed here even though the parent's own
  // `items` array (which fed initialItems) keeps changing after mount as
  // each swipe's approve/reject call resolves.
  const [queue, setQueue] = useState(initialItems);
  const [exitDirection, setExitDirection] = useState<SwipeDirection | null>(null);

  const topItem = queue[0];
  const visible = queue.slice(0, SWIPE_STACK_SIZE);

  function handleSwiped(direction: SwipeDirection) {
    if (!topItem || exitDirection) return;
    setExitDirection(direction);

    if (direction === "right") {
      onApprove(topItem.id);
    } else {
      onReject(topItem.id);
    }
  }

  function handleExitComplete() {
    setQueue((current) => current.slice(1));
    setExitDirection(null);
  }

  return (
    <div className="flex flex-col items-center gap-6 py-4">
      <div className="relative h-[520px] w-full max-w-sm">
        {topItem ? (
          visible.map((listing, index) => (
            <ReviewSwipeCard
              key={listing.id}
              listing={listing}
              stackIndex={index}
              exitDirection={index === 0 ? exitDirection : null}
              onSwiped={handleSwiped}
              onExitComplete={handleExitComplete}
            />
          ))
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-4 rounded-card border border-dashed border-border-button bg-highlight-cream px-8 text-center">
            <Sparkles className="h-8 w-8 text-oxblood" strokeWidth={1.5} />
            <p className="max-w-xs text-sm text-ink-soft">
              Nothing left to review — every flagged listing has been approved or rejected.
            </p>
          </div>
        )}
      </div>

      {topItem && (
        <div className="flex items-center gap-6">
          <button
            type="button"
            onClick={() => handleSwiped("left")}
            aria-label="Reject"
            className="flex h-16 w-16 cursor-pointer items-center justify-center rounded-full border-2 border-border bg-surface text-ink-soft shadow-soft transition-transform hover:scale-105 hover:border-oxblood hover:text-oxblood active:scale-95"
          >
            <span className="text-xs font-semibold uppercase tracking-wide">Reject</span>
          </button>
          <button
            type="button"
            onClick={() => handleSwiped("right")}
            aria-label="Approve"
            className="flex h-16 w-16 cursor-pointer items-center justify-center rounded-full bg-oxblood text-white shadow-card transition-transform hover:scale-105 active:scale-95"
          >
            <span className="text-xs font-semibold uppercase tracking-wide">Approve</span>
          </button>
        </div>
      )}
    </div>
  );
}
