"use client";

import { useRef, useState } from "react";
import { AdminListingCard } from "@/components/AdminListingCard";
import { AdminPendingSwipeView } from "@/components/admin/AdminPendingSwipeView";
import { removeListing, restoreListing } from "@/lib/adminListingRemoval";
import {
  approveListing,
  rejectListing,
  getListingsForModeration,
  type ModeratedListing,
  type ModerationFilter,
} from "@/lib/listingModeration";

const FILTER_OPTIONS: { value: ModerationFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "flagged", label: "Flagged" },
  { value: "approved", label: "Approved" },
  { value: "unavailable", label: "Unavailable" },
];

/**
 * /admin/listings — moderation dashboard for every imported listing,
 * filterable by All/Flagged/Approved (default: Flagged, so what actually
 * needs a decision is what an admin sees first). Since the "scraped
 * listings go live automatically" ingestion change, most imports never
 * appear here at all (they insert straight to 'active') — this dashboard
 * is now purely for the minority flagListing() flagged. Flagged renders as
 * a one-at-a-time swipe deck (AdminPendingSwipeView — swipe right/Approve,
 * left/Reject, same gesture primitive match/MatchView.tsx uses), since
 * that's the actual review decision this dashboard exists for; All/
 * Approved stay the full list/grid (AdminListingCard, with its full photo
 * gallery, source URL, import date, and Approve/Delete actions) since
 * those are for browsing what's already been decided, not deciding.
 */
export function AdminListingsView({
  initialItems,
  initialFilter,
  initialError,
}: {
  initialItems: ModeratedListing[];
  initialFilter: ModerationFilter;
  // Set when the server-side fetch itself failed (e.g. the signed-in
  // account isn't actually admin, or a genuine DB error) — rendered as its
  // own distinct state below, never folded into "no listings match this
  // filter." Those look nothing alike on purpose: an empty result is
  // normal, a failed fetch is not.
  initialError?: string;
}) {
  const [items, setItems] = useState(initialItems);
  const [filter, setFilter] = useState(initialFilter);
  const [loadError, setLoadError] = useState<string | null>(initialError ?? null);
  const [isLoading, setIsLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; tone: "success" | "error" } | null>(null);
  const messageTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function showMessage(text: string, tone: "success" | "error") {
    setMessage({ text, tone });
    if (messageTimeoutRef.current) clearTimeout(messageTimeoutRef.current);
    messageTimeoutRef.current = setTimeout(() => setMessage(null), 4000);
  }

  // Changing the filter re-fetches from the server rather than filtering
  // the already-loaded `items` client-side — "all" only ever holds
  // flagged+active client-side too, so a straight client-side filter would
  // work for flagged/approved, but a fresh fetch also picks up anything
  // imported by the scraper since the page first loaded.
  async function handleFilterChange(next: ModerationFilter) {
    setFilter(next);
    setIsLoading(true);
    setLoadError(null);

    const result = await getListingsForModeration(next);
    setIsLoading(false);

    if (result.error) {
      setLoadError(result.error);
      setItems([]);
      return;
    }

    setItems(result.items);
  }

  // Whether a listing's (possibly just-changed) status still belongs under
  // the currently-selected filter — used to decide whether an approved/
  // deleted listing should disappear from the visible list or just update
  // its badge in place.
  function matchesCurrentFilter(status: ModeratedListing["status"]): boolean {
    if (filter === "flagged") return status === "flagged";
    if (filter === "approved") return status === "active";
    if (filter === "unavailable") return status === "unavailable";
    return true; // "all" already only ever holds flagged/active
  }

  async function handleApprove(listingId: string) {
    setBusyId(listingId);
    const result = await approveListing(listingId);
    setBusyId(null);

    if (result.error) {
      showMessage(`Couldn't approve — ${result.error}`, "error");
      return;
    }

    setItems((prev) =>
      prev
        .map((item) => (item.id === listingId ? { ...item, status: "active" as const } : item))
        .filter((item) => item.id !== listingId || matchesCurrentFilter(item.status)),
    );
    showMessage("Listing approved", "success");
  }

  // Swipe-left counterpart to handleApprove above, called by
  // AdminPendingSwipeView — same shape (busyId isn't set here since the
  // swipe view's own exit animation is the "this is being handled" signal,
  // not a disabled-button state the way the list view's Approve/Delete
  // buttons need).
  async function handleReject(listingId: string) {
    const result = await rejectListing(listingId);

    if (result.error) {
      showMessage(`Couldn't reject — ${result.error}`, "error");
      return;
    }

    // 'rejected' isn't part of ModeratedListing["status"] at all (that type
    // only ever covers flagged/active, the only two statuses this
    // dashboard fetches) — a rejected listing leaves every filter's scope
    // unconditionally, so this just drops it rather than trying to map it
    // to a status value the type doesn't have.
    setItems((prev) => prev.filter((item) => item.id !== listingId));
    showMessage("Listing rejected", "success");
  }

  async function handleDelete(listingId: string, title: string) {
    setBusyId(listingId);
    const result = await removeListing(listingId);
    setBusyId(null);

    if (result.error) {
      showMessage(`Couldn't delete "${title}" — ${result.error}`, "error");
      return;
    }

    setItems((prev) => prev.filter((item) => item.id !== listingId));
    showMessage("Listing deleted", "success");
  }

  // P0 launch-readiness dead-listing cleanup — undoes a check-listing-status
  // cron decision (or a past manual removal) an admin has confirmed was
  // wrong. Same shape as handleDelete above.
  async function handleRestore(listingId: string, title: string) {
    setBusyId(listingId);
    const result = await restoreListing(listingId);
    setBusyId(null);

    if (result.error) {
      showMessage(`Couldn't restore "${title}" — ${result.error}`, "error");
      return;
    }

    setItems((prev) =>
      prev
        .map((item) => (item.id === listingId ? { ...item, status: "active" as const, removal_reason: null } : item))
        .filter((item) => item.id !== listingId || matchesCurrentFilter(item.status)),
    );
    showMessage("Listing restored", "success");
  }

  function handlePhotosSaved(listingId: string, images: string[]) {
    setItems((prev) =>
      prev.map((item) => (item.id === listingId ? { ...item, images, image_url: images[0] ?? null } : item)),
    );
  }

  return (
    <div className="min-h-screen px-6 py-10 pb-16">
      <div className="mx-auto max-w-2xl">
        <div className="mb-6 flex items-center justify-between">
          <h1 className="font-display text-xl font-semibold text-ink">Admin Listings</h1>
          {items.length > 0 && <span className="text-sm text-ink-soft">{items.length} shown</span>}
        </div>

        <div className="mb-6 flex gap-2">
          {FILTER_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => handleFilterChange(option.value)}
              disabled={isLoading}
              className={`cursor-pointer rounded-pill px-4 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
                filter === option.value ? "bg-ink text-white" : "bg-inner text-ink-soft hover:bg-inner/70"
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>

        {message && (
          <div
            className={`mb-4 rounded-card border px-4 py-2.5 text-sm text-ink ${
              message.tone === "success" ? "border-green-600 bg-highlight-cream" : "border-oxblood bg-highlight-cream"
            }`}
          >
            {message.text}
          </div>
        )}

        {loadError ? (
          <div className="rounded-card border border-oxblood bg-highlight-cream p-8 text-center text-sm text-ink">
            <p className="font-medium">Couldn&apos;t load listings</p>
            <p className="mt-1 text-ink-soft">{loadError}</p>
          </div>
        ) : isLoading ? (
          <div className="rounded-card border border-border bg-inner/50 p-12 text-center text-sm text-ink-soft">
            Loading...
          </div>
        ) : items.length === 0 ? (
          <div className="rounded-card border border-border bg-inner/50 p-12 text-center text-sm text-ink-soft">
            No listings match this filter.
          </div>
        ) : filter === "flagged" ? (
          <AdminPendingSwipeView initialItems={items} onApprove={handleApprove} onReject={handleReject} />
        ) : (
          <div className="flex flex-col gap-6">
            {items.map((listing) => (
              <AdminListingCard
                key={listing.id}
                listing={listing}
                busy={busyId === listing.id}
                onApprove={() => handleApprove(listing.id)}
                onDelete={() => handleDelete(listing.id, listing.title)}
                onRestore={() => handleRestore(listing.id, listing.title)}
                onPhotosSaved={(images) => handlePhotosSaved(listing.id, images)}
                onError={(text) => showMessage(text, "error")}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
