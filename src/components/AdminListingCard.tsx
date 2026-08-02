"use client";

import { useState } from "react";
import { AdminImageGallery } from "@/components/admin/AdminImageGallery";
import { updateListingImages, type ModeratedListing } from "@/lib/listingModeration";

function formatCreatedAt(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function statusLabel(status: ModeratedListing["status"]): string {
  if (status === "flagged") return "Flagged";
  if (status === "unavailable") return "Unavailable";
  return "Approved";
}

function statusClass(status: ModeratedListing["status"]): string {
  if (status === "flagged") return "bg-tag-yellow text-tag-yellow-ink";
  if (status === "unavailable") return "bg-tag-pink text-tag-pink-ink";
  return "bg-tag-teal text-tag-teal-ink";
}

function photosFor(listing: Pick<ModeratedListing, "images" | "image_url">): string[] {
  if (Array.isArray(listing.images) && listing.images.length > 0) return listing.images;
  return listing.image_url ? [listing.image_url] : [];
}

// One row in the /admin/listings moderation dashboard (AdminListingsView.tsx)
// — the full-photo-gallery counterpart to ListingCard.tsx's Discover-grid
// card, showing everything an admin needs to decide whether a listing
// should go live: every source photo (via the Swiper-based
// AdminImageGallery — main + synced thumbnail strip, per-photo delete),
// platform, price, source URL, import date, and current status, plus
// whole-listing Approve/Delete actions. One instance per listing, stays
// mounted for that listing's whole lifetime in the list (unlike the old
// one-at-a-time review queue), so its own `images` state never needs to
// be reset mid-flight.
export function AdminListingCard({
  listing,
  onApprove,
  onDelete,
  onRestore,
  onPhotosSaved,
  onError,
  busy = false,
}: {
  listing: ModeratedListing;
  onApprove: () => void;
  onDelete: () => void;
  // Undoes check-listing-status marking this listing 'unavailable' (or a
  // past manual removal) — only ever rendered for that status below.
  onRestore: () => void;
  onPhotosSaved: (images: string[]) => void;
  onError: (message: string) => void;
  busy?: boolean;
}) {
  const [images, setImages] = useState<string[]>(() => photosFor(listing));
  const [isDeletingPhoto, setIsDeletingPhoto] = useState(false);

  // Deleting a photo persists immediately — no separate "Save" step
  // anymore. Optimistic: the gallery updates the instant the admin clicks
  // delete, then this fires the Supabase write in the background; if that
  // write fails, the photo is put back and the admin is told why, rather
  // than leaving the UI showing a state that was never actually saved.
  async function handleDeleteImage(index: number) {
    const previous = images;
    const next = images.filter((_, i) => i !== index);
    setImages(next);
    setIsDeletingPhoto(true);

    const result = await updateListingImages(listing.id, next);
    setIsDeletingPhoto(false);

    if (result.error) {
      setImages(previous);
      onError(`Couldn't delete photo — ${result.error}`);
      return;
    }

    onPhotosSaved(next);
  }

  return (
    <div className="overflow-hidden rounded-card border border-border bg-surface shadow-card">
      <div className="relative w-full">
        <AdminImageGallery images={images} alt={listing.title} onDeleteImage={handleDeleteImage} />
        {isDeletingPhoto && (
          <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/20">
            <span className="rounded-pill bg-black/70 px-3 py-1 text-xs font-medium text-white">Deleting...</span>
          </div>
        )}
      </div>

      <div className="p-5">
        <div className="flex items-start justify-between gap-2">
          <h2 className="font-display text-lg font-semibold text-ink">{listing.title}</h2>
          <span className={`shrink-0 rounded-pill px-3 py-1 text-xs font-medium ${statusClass(listing.status)}`}>
            {statusLabel(listing.status)}
          </span>
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-ink-soft">
          {listing.platform && <span className="font-medium text-ink">{listing.platform}</span>}
          {listing.price != null && (
            <span className="font-display font-semibold text-oxblood">${listing.price.toFixed(2)}</span>
          )}
          <span>
            {images.length} photo{images.length === 1 ? "" : "s"}
          </span>
          <span>Imported {formatCreatedAt(listing.created_at)}</span>
        </div>

        {listing.product_url && (
          <a
            href={listing.product_url}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-1 block truncate text-xs text-ink-soft underline decoration-border hover:text-oxblood"
          >
            {listing.product_url}
          </a>
        )}

        {listing.aesthetic_tags.length > 0 && (
          <p className="mt-2 text-xs text-ink-soft">{listing.aesthetic_tags.join(" · ")}</p>
        )}

        {listing.status === "flagged" && listing.flag_reason && (
          <p className="mt-2 text-xs font-medium text-oxblood">Flagged: {listing.flag_reason}</p>
        )}

        {listing.status === "unavailable" && (
          <p className="mt-2 text-xs font-medium text-oxblood">
            Marked unavailable{listing.removal_reason ? `: ${listing.removal_reason}` : ""} — confirm on the source
            listing before restoring.
          </p>
        )}

        <div className="mt-4 flex gap-2">
          {listing.status === "flagged" && (
            <button
              type="button"
              onClick={onApprove}
              disabled={busy}
              className="flex-1 cursor-pointer rounded-pill bg-green-600 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-green-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Approve
            </button>
          )}
          {listing.status === "unavailable" && (
            <button
              type="button"
              onClick={onRestore}
              disabled={busy}
              className="flex-1 cursor-pointer rounded-pill bg-green-600 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-green-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Restore
            </button>
          )}
          <button
            type="button"
            onClick={onDelete}
            disabled={busy}
            className="flex-1 cursor-pointer rounded-pill bg-red-600 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}
