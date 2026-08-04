"use client";

import { memo, useState, type KeyboardEvent, type MouseEvent } from "react";
import { useRouter } from "next/navigation";
import { MoreVertical } from "lucide-react";
import { Badge, tagVariantForIndex } from "@/components/ui/Badge";
import { PlatformBadge } from "@/components/ui/PlatformBadge";
import { SaveButton } from "@/components/SaveButton";
import { ImageCarousel } from "@/components/ImageCarousel";
import { removeListing, markListingLowQuality } from "@/lib/adminListingRemoval";
import { useToast } from "@/components/ToastProvider";
import type { Listing } from "@/lib/supabase/listings.types";

// Bespoke match-score badge — deliberately NOT the shared Badge/TagVariant
// system just below (that's for aesthetic tags, cycling pink/teal/yellow;
// still untouched). Match-score has its own display rule from the
// Discover redesign brief: translucent brand teal for a genuinely good
// match, soft neutral cream for a so-so one, and no badge at all for a
// bare 0% — never emphasized/bright regardless of score. Purely a display
// bucketing of the ALREADY-computed matchScore prop; scoring itself
// (match-scoring.ts) is completely untouched.
function MatchBadge({ score }: { score: number }) {
  if (score <= 0) return null;

  // Threshold re-tuned for the normalized 25-99 display scale
  // (normalizeMatchPercentForDisplay, src/lib/match-percent-display.ts) —
  // 70 on the old raw 0-100 scale is ~77 once rescaled, same relative
  // "how good is this match" meaning as before.
  const isHighMatch = score >= 77;

  return (
    <span
      className={`inline-flex items-center rounded-pill px-2.5 py-1 text-[11px] font-semibold backdrop-blur-sm ${
        isHighMatch ? "bg-teal/20 text-teal-deep" : "bg-highlight-cream/70 text-ink-soft"
      }`}
    >
      {score}% match
    </span>
  );
}

// Shared by Discover (DiscoverView.tsx, the single unified browsing page
// — /feed was merged into it, see discover-feed.ts's own comment), Match's
// "More Like This"-style surfaces (MatchResultCard.tsx), and Style Me's
// reveal bundle (StyleMeRevealView.tsx) — a visual restyle here (Discover
// redesign brief: minimal chrome, image-first, softer overlay controls)
// intentionally applies to all three rather than forking a second
// Discover-only card, per that brief's own "do not create duplicate
// listing-card logic" instruction. Uses a div + onClick/onKeyDown +
// "ignore clicks inside a button" pattern (rather than a bare `<Link>`)
// so the admin-only "..." menu's nested `<button>` composes safely with
// SaveButton and real navigation alike.
function ListingCardImpl({
  listing,
  isAdmin = false,
  initialSaved = false,
  showSaveButton = false,
  matchScore = null,
}: {
  listing: Listing;
  // Admins see Remove/Hide options on EVERY card — this is an
  // admin-curated platform, users never own listings (Admin-Curated
  // Discovery Platform reversal).
  isAdmin?: boolean;
  initialSaved?: boolean;
  showSaveButton?: boolean;
  matchScore?: number | null;
}) {
  const router = useRouter();
  const { showToast } = useToast();
  const href = `/listing/${listing.id}`;

  const [menuOpen, setMenuOpen] = useState(false);
  const [deleted, setDeleted] = useState(false);

  function handleClick(event: MouseEvent<HTMLDivElement>) {
    if ((event.target as HTMLElement).closest("button")) return;
    router.push(href);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.target !== event.currentTarget) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      router.push(href);
    }
  }

  async function handleAdminRemove(event: MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    setMenuOpen(false);

    if (!window.confirm(`Remove "${listing.title}" from every feed in the app?`)) return;

    // Same "plain browser dialog over new modal infra" convention as
    // window.confirm just above — optional, so a cancelled prompt (null)
    // still proceeds with no reason recorded, it doesn't abort the removal.
    const reason = window.prompt("Why are you removing this? (optional)") ?? undefined;

    const result = await removeListing(listing.id, reason);
    if (result.error) {
      showToast(result.error);
      return;
    }

    setDeleted(true);
    showToast("Listing removed");
  }

  async function handleMarkLowQuality(event: MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    setMenuOpen(false);

    const result = await markListingLowQuality(listing.id);
    if (result.error) {
      showToast(result.error);
      return;
    }

    showToast("Listing hidden (low quality)");
  }

  // Gone the moment the delete succeeds — matches every other
  // owner-scoped action in this app (e.g. dislikeListing hiding a card),
  // rather than waiting on a full page refresh to disappear.
  if (deleted) return null;

  // Same "images array, falling back to the single image_url" pattern as
  // ListingDetailView.tsx — a listing saved before the images[] migration
  // (or by a query that doesn't select it) still shows its one photo.
  const photos =
    Array.isArray(listing.images) && listing.images.length > 0
      ? listing.images
      : listing.image_url
        ? [listing.image_url]
        : [];

  return (
    // Plain div, not the shared <Card> (src/components/ui/Card.tsx) — that
    // component is used by ~20 other, unrelated surfaces (auth panels,
    // admin dashboards, etc.) with its own always-on border/shadow, and a
    // Tailwind utility appended later in a class list doesn't reliably
    // override an earlier one with the same property. Rebuilding the
    // handful of classes Card actually contributed here (rounded-card,
    // bg-surface, the hover lift) keeps every other Card usage in the app
    // completely unaffected while letting this specific card go flatter/
    // lighter per the redesign brief (no border, no always-on shadow —
    // only a soft one on hover).
    <div
      className="group flex cursor-pointer flex-col overflow-hidden rounded-card bg-surface transition-transform duration-200 ease-out hover:-translate-y-0.5 hover:shadow-soft"
      role="link"
      tabIndex={0}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
    >
      <div className="relative aspect-[3/4] shrink-0">
        <ImageCarousel images={photos} alt={listing.title} />

        {showSaveButton && (
          <SaveButton listingId={listing.id} initialSaved={initialSaved} className="absolute left-2 top-2" />
        )}

        {matchScore != null && (
          <div className={showSaveButton ? "absolute left-2 top-14" : "absolute left-2 top-2"}>
            <MatchBadge score={matchScore} />
          </div>
        )}

        {listing.platform && (
          <PlatformBadge platform={listing.platform} className="absolute bottom-2 right-2" />
        )}

        {isAdmin && (
          <div className="absolute right-2 top-2">
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                setMenuOpen((prev) => !prev);
              }}
              aria-label="Listing options"
              aria-expanded={menuOpen}
              className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-full bg-surface/70 text-ink-soft backdrop-blur-sm transition-colors hover:bg-surface/90 hover:text-ink"
            >
              <MoreVertical className="h-4 w-4" strokeWidth={2} />
            </button>

            {menuOpen && (
              <div
                onClick={(event) => event.stopPropagation()}
                className="absolute right-0 top-8 z-10 w-44 overflow-hidden rounded-2xl border border-border bg-surface shadow-card"
              >
                <button
                  type="button"
                  onClick={handleMarkLowQuality}
                  className="block w-full cursor-pointer px-4 py-2.5 text-left text-sm text-ink hover:bg-inner"
                >
                  Hide (Low Quality)
                </button>
                <button
                  type="button"
                  onClick={handleAdminRemove}
                  className="block w-full cursor-pointer px-4 py-2.5 text-left text-sm text-oxblood hover:bg-inner"
                >
                  Remove Listing
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="flex flex-1 flex-col gap-1 p-3">
        <div className="flex items-start justify-between gap-2">
          <h3 className="min-w-0 line-clamp-2 font-display text-sm font-semibold leading-tight text-ink">
            {listing.title}
          </h3>
          {listing.price != null && (
            <span className="shrink-0 font-display text-sm font-bold text-oxblood">
              ${listing.price.toFixed(2)}
            </span>
          )}
        </div>

        {(listing.brand || listing.category || listing.size) && (
          <p className="text-[11px] text-ink-soft">
            {[listing.brand, listing.category, listing.size].filter(Boolean).join(" · ")}
          </p>
        )}

        {listing.aesthetic_tags.length > 0 && (
          <div className="mt-auto flex flex-wrap gap-1 pt-1">
            {listing.aesthetic_tags.map((tag, index) => (
              <Badge key={tag} variant={tagVariantForIndex(index)} className="px-2 py-0.5 text-[10px]">
                {tag}
              </Badge>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// Pre-submission perf fix — DiscoverView's infinite-scroll appends
// (setListings((current) => [...current, ...more])) and sort-dropdown
// changes both create a new listings array reference, which without this
// re-renders every already-loaded card in the grid, not just the new ones.
// Props here are stable per-item primitives/references, so memoizing
// cleanly skips that redundant work for a grid that can grow past 100
// cards across a scroll session.
export const ListingCard = memo(ListingCardImpl);
