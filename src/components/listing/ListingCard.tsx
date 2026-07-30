"use client";

import { useState, type KeyboardEvent, type MouseEvent } from "react";
import { useRouter } from "next/navigation";
import { MoreVertical } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { Badge, tagVariantForIndex, type TagVariant } from "@/components/ui/Badge";
import { SaveButton } from "@/components/SaveButton";
import { ImageCarousel } from "@/components/ImageCarousel";
import { removeListing, markListingLowQuality } from "@/lib/adminListingRemoval";
import { useToast } from "@/components/ToastProvider";
import type { Listing } from "@/lib/supabase/listings.types";

function matchBadgeVariant(score: number): TagVariant {
  if (score >= 75) return "pink";
  if (score >= 40) return "teal";
  return "yellow";
}

// Shared by Discover (DiscoverView.tsx, the single unified browsing page
// — /feed was merged into it, see discover-feed.ts's own comment) and
// Match's "More Like This"-style surfaces. Uses a div + onClick/onKeyDown
// + "ignore clicks inside a button" pattern (rather than a bare `<Link>`)
// so the admin-only "..." menu's nested `<button>` composes safely with
// SaveButton and real navigation alike.
export function ListingCard({
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
    <Card
      className="flex cursor-pointer flex-col overflow-hidden p-0"
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
          <Badge variant={matchBadgeVariant(matchScore)} className="absolute left-2 top-2 shadow-soft">
            {matchScore}% match
          </Badge>
        )}

        {listing.platform && (
          <span className="absolute bottom-2 right-2 rounded-pill bg-darkgreen/45 px-2.5 py-1 text-xs font-medium text-white">
            {listing.platform}
          </span>
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
              className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-full bg-white/90 text-ink shadow-soft hover:bg-white"
            >
              <MoreVertical className="h-4 w-4" strokeWidth={2} />
            </button>

            {menuOpen && (
              <div
                onClick={(event) => event.stopPropagation()}
                className="absolute right-0 top-9 z-10 w-44 overflow-hidden rounded-2xl border border-border bg-surface shadow-card"
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

        {(listing.brand || listing.category || listing.size) && (
          <p className="text-xs text-ink-soft">
            {[listing.brand, listing.category, listing.size].filter(Boolean).join(" · ")}
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
  );
}
