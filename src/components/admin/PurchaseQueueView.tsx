"use client";

import { useEffect, useRef, useState } from "react";
import { ImageOff } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { PlatformBadge } from "@/components/ui/PlatformBadge";
import { updateOrderItemStatus, markOrderItemOpened } from "@/lib/orderActions";
import { getPurchaseQueueItems, type PurchaseQueueItem } from "@/lib/purchaseQueue";

// How often the queue quietly re-fetches in the background, to surface
// items other admins (or a fresh order) have added since the page loaded —
// there's no realtime/websocket infrastructure anywhere in this app, so
// polling is the same "opportunistic refresh" approach already used
// elsewhere (e.g. releaseExpiredReservations being swept on page loads).
const POLL_INTERVAL_MS = 15000;
const HOT_LABEL = "🔥 Hot - Buy First";

// Client-side-only "HOT item" concept — display emphasis to make admins act
// faster on high-risk/high-value items. Never fed back into the backend
// sort (src/lib/purchaseQueue.ts's sortQueueItems, untouched) — purely
// changes how an already-correctly-ordered queue is *displayed*.
const HOT_URGENCY_THRESHOLD = 80;
const HOT_RESERVATION_WINDOW_MS = 5 * 60 * 1000;
const HOT_MATCH_BONUS_THRESHOLD = 85;

function isHot(item: PurchaseQueueItem, now: number): boolean {
  if (item.urgencyScore >= HOT_URGENCY_THRESHOLD) return true;

  if (item.reservationExpiresAt) {
    const remainingMs = new Date(item.reservationExpiresAt).getTime() - now;
    if (remainingMs > 0 && remainingMs <= HOT_RESERVATION_WINDOW_MS) return true;
  }

  return false;
}

// Display-only ranking for the "Up next" list (spec section 5): 0 for a
// non-hot item, 1 for hot, 2 for hot *and* a great match. Used as a stable
// sort key — ties (e.g. two non-hot items, or two equally-ranked hot ones)
// keep their original (backend-sorted) relative order, so this only ever
// promotes hot items above non-hot ones, never reorders within a tier.
function hotRank(item: PurchaseQueueItem, now: number): number {
  if (!isHot(item, now)) return 0;
  return item.matchPercent != null && item.matchPercent >= HOT_MATCH_BONUS_THRESHOLD ? 2 : 1;
}

function formatCountdown(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

// Section 3's exact copy tiers: expired, under 2 minutes ("almost gone"),
// under 5 minutes ("selling fast"), otherwise the plain countdown.
function reservationCountdownMessage(remainingMs: number): string {
  if (remainingMs <= 0) return "Reservation expired";
  if (remainingMs < 2 * 60 * 1000) return "🚨 Almost gone";
  if (remainingMs < HOT_RESERVATION_WINDOW_MS) return `⏳ ${formatCountdown(remainingMs)} left — selling fast`;
  return `Reservation expires in ${formatCountdown(remainingMs)}`;
}

// "2m 14s" below a minute rounds down to whole seconds; under a minute is
// just "Ns" — this only ever needs to read as "roughly how long has this
// been open," not a stopwatch-precise value.
function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${seconds}s`;
}

function itemLabel(item: PurchaseQueueItem): string {
  return item.brand ?? item.title ?? "an item";
}

export function PurchaseQueueView({ initialItems }: { initialItems: PurchaseQueueItem[] }) {
  const [items, setItems] = useState(initialItems);
  const [currentItemId, setCurrentItemId] = useState<string | null>(initialItems[0]?.id ?? null);
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set());
  const [alertMessage, setAlertMessage] = useState<string | null>(null);
  // Spec section 4's "sound/attention" flash — deliberately separate from
  // alertMessage above (which covers "a new item entered the queue" from
  // the polling refresh only). This one fires for the broader isHot()
  // definition (urgency OR an imminent reservation) and re-checks on every
  // clock tick too, so an item that becomes hot purely because its
  // reservation countdown crossed the 5-minute mark — with no poll
  // involved — still gets flashed.
  const [flashMessage, setFlashMessage] = useState<string | null>(null);
  // Ticks every second purely to force a re-render of the reservation
  // countdown and the "time spent securing" timer — the actual timestamps
  // live on each item.
  const [now, setNow] = useState(() => Date.now());

  // Every item id ever seen, across the initial load and every poll —
  // pre-seeded with the initial items so the very first poll doesn't treat
  // everything already on-screen as "new." Only ids that show up *after*
  // that count as a genuinely new item for the alert banner.
  const seenIdsRef = useRef<Set<string>>(new Set(initialItems.map((item) => item.id)));
  const alertTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Every item id already flashed as HOT — pre-seeded with whatever's
  // already hot on first load, so the page opening doesn't immediately
  // flash for every already-hot item; only an item newly *becoming* hot
  // after that triggers it, and only once per item ever (spec section 4).
  const hotAlertedIdsRef = useRef<Set<string>>(
    new Set(initialItems.filter((item) => isHot(item, now)).map((item) => item.id)),
  );
  const flashTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);

  // Background refresh — merges in items other admins have resolved
  // elsewhere and surfaces brand-new ones. Skipped while an action for
  // this admin is in flight, so a poll can't clobber an optimistic update
  // before its own server action has actually resolved.
  useEffect(() => {
    const interval = setInterval(async () => {
      if (pendingIds.size > 0) return;

      const result = await getPurchaseQueueItems();
      if (result.error) {
        console.error("[purchase-queue] Poll refresh failed:", result.error);
        return;
      }

      const freshItems = result.items;
      const newHotItems = freshItems.filter(
        (item) => !seenIdsRef.current.has(item.id) && item.urgencyLabel === HOT_LABEL,
      );

      for (const item of freshItems) {
        seenIdsRef.current.add(item.id);
      }

      if (newHotItems.length > 0) {
        setAlertMessage(
          newHotItems.length === 1
            ? `🚨 New item needs securing — ${itemLabel(newHotItems[0])}`
            : `🚨 ${newHotItems.length} new items need securing`,
        );
        if (alertTimeoutRef.current) clearTimeout(alertTimeoutRef.current);
        alertTimeoutRef.current = setTimeout(() => setAlertMessage(null), 8000);
      }

      setItems(freshItems);
      setCurrentItemId((current) => {
        if (current && freshItems.some((item) => item.id === current)) return current;
        return freshItems[0]?.id ?? null;
      });
    }, POLL_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [pendingIds]);

  useEffect(() => {
    return () => {
      if (alertTimeoutRef.current) clearTimeout(alertTimeoutRef.current);
      if (flashTimeoutRef.current) clearTimeout(flashTimeoutRef.current);
    };
  }, []);

  // Detects items newly crossing into "hot" — either just arrived via a
  // poll, or already in the queue but whose reservation countdown just
  // ticked under the 5-minute window. Re-runs on every clock tick (`now`)
  // as well as every item-list change, but hotAlertedIdsRef guarantees
  // each item id can only ever trigger this once.
  useEffect(() => {
    const newlyHot = items.filter((item) => isHot(item, now) && !hotAlertedIdsRef.current.has(item.id));
    if (newlyHot.length === 0) return;

    for (const item of newlyHot) {
      hotAlertedIdsRef.current.add(item.id);
    }

    setFlashMessage(`🔥 HOT ITEM — BUY NOW — ${itemLabel(newlyHot[0])}`);
    if (flashTimeoutRef.current) clearTimeout(flashTimeoutRef.current);
    flashTimeoutRef.current = setTimeout(() => setFlashMessage(null), 4000);
  }, [items, now]);

  const currentItem = items.find((item) => item.id === currentItemId) ?? null;

  function withPending<T>(id: string, run: () => Promise<T>): Promise<T> {
    setPendingIds((prev) => new Set(prev).add(id));
    return run().finally(() => {
      setPendingIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    });
  }

  // Manual "skip to next" (N key / button) — cycles through the current
  // queue without resolving anything.
  function focusNext() {
    if (items.length === 0) {
      setCurrentItemId(null);
      return;
    }
    const index = items.findIndex((item) => item.id === currentItemId);
    const next = index === -1 ? items[0] : items[(index + 1) % items.length];
    setCurrentItemId(next.id);
  }

  function handleOpen(item: PurchaseQueueItem) {
    if (item.productUrl) {
      window.open(item.productUrl, "_blank", "noopener,noreferrer");
    }

    if (!item.openedAt) {
      const openedAt = new Date().toISOString();
      setItems((current) => current.map((row) => (row.id === item.id ? { ...row, openedAt } : row)));
      // opened_at is an analytics timestamp, not user-facing correctness
      // state — not worth rolling back over; the tab already opened
      // regardless of whether this write succeeds.
      markOrderItemOpened(item.id).catch(() => {});
    }
  }

  async function handleResolve(item: PurchaseQueueItem, status: "purchased" | "failed_unavailable") {
    if (status === "purchased") {
      const confirmed = window.confirm("Did you successfully purchase this item?");
      if (!confirmed) return;
    }

    const previousItems = items;
    const index = items.findIndex((row) => row.id === item.id);
    const remaining = items.filter((row) => row.id !== item.id);

    setItems(remaining);
    // Auto-advance (spec section 5) — only moves focus if the item being
    // resolved was actually the focused one; the item that shifts into its
    // old slot becomes the new focus, or the first remaining item if it
    // was last.
    setCurrentItemId((current) => {
      if (current !== item.id) return current;
      if (remaining.length === 0) return null;
      return remaining[Math.min(index, remaining.length - 1)].id;
    });

    await withPending(item.id, async () => {
      const result = await updateOrderItemStatus(item.id, status);
      if (result.error) {
        console.error("[purchase-queue] updateOrderItemStatus failed:", result.error);
        setItems(previousItems);
        setCurrentItemId(item.id);
        alert(result.error);
      }
    });
  }

  // Keyboard shortcuts: N (next), O (open marketplace), P (mark purchased),
  // F (mark failed) — ignored while a modifier key is held (so real
  // browser shortcuts still work) or while focus is on a form control.
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) {
        return;
      }

      const key = event.key.toLowerCase();

      if (key === "n") {
        event.preventDefault();
        focusNext();
        return;
      }

      if (!currentItem) return;

      if (key === "o") {
        event.preventDefault();
        handleOpen(currentItem);
      } else if (key === "p") {
        event.preventDefault();
        handleResolve(currentItem, "purchased");
      } else if (key === "f") {
        event.preventDefault();
        handleResolve(currentItem, "failed_unavailable");
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentItem, items]);

  const reservationRemainingMs = currentItem?.reservationExpiresAt
    ? new Date(currentItem.reservationExpiresAt).getTime() - now
    : null;
  const securingElapsedMs = currentItem?.openedAt ? now - new Date(currentItem.openedAt).getTime() : null;
  const isCurrentPending = currentItem ? pendingIds.has(currentItem.id) : false;
  const isCurrentHot = currentItem ? isHot(currentItem, now) : false;

  // Client-side-only visual nudge (spec section 5) — stable-sorts HOT
  // items above non-hot ones (and great-match HOT items above plain HOT
  // ones) in the "Up next" list only. Never touches `items` itself, which
  // stays exactly in the backend's reservation -> urgency -> order-age
  // order for focusNext()/currentItem/keyboard navigation.
  const upNextItems = [...items]
    .filter((item) => item.id !== currentItem?.id)
    .sort((a, b) => hotRank(b, now) - hotRank(a, now));

  return (
    <div className="min-h-screen px-6 py-10 pb-16">
      <div className="mx-auto max-w-3xl">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="font-display text-2xl font-semibold text-ink">Purchase Queue</h1>
            <p className="mt-1 text-sm text-ink-soft">
              {items.length} unresolved item{items.length === 1 ? "" : "s"}
            </p>
          </div>
          <p className="text-xs text-ink-soft/70">
            <kbd className="rounded border border-border px-1.5 py-0.5">N</kbd> next ·{" "}
            <kbd className="rounded border border-border px-1.5 py-0.5">O</kbd> open ·{" "}
            <kbd className="rounded border border-border px-1.5 py-0.5">P</kbd> purchased ·{" "}
            <kbd className="rounded border border-border px-1.5 py-0.5">F</kbd> failed
          </p>
        </div>

        {alertMessage && (
          <div className="mt-4 flex items-center justify-between gap-3 rounded-card border border-oxblood bg-highlight-cream px-4 py-3 text-sm font-medium text-ink">
            <span>{alertMessage}</span>
            <button
              type="button"
              onClick={() => setAlertMessage(null)}
              aria-label="Dismiss alert"
              className="cursor-pointer text-ink-soft hover:text-ink"
            >
              ✕
            </button>
          </div>
        )}

        {flashMessage && (
          <div className="mt-4 animate-pulse rounded-card bg-oxblood px-4 py-3 text-center text-sm font-bold text-white">
            {flashMessage}
          </div>
        )}

        {!currentItem ? (
          <div className="mt-10 rounded-card border border-border bg-inner/50 p-10 text-center text-sm text-ink-soft">
            Queue is empty. Nothing needs securing right now. 🎉
          </div>
        ) : (
          <div className="mt-6 flex flex-col gap-4">
            <div className="overflow-hidden rounded-card border border-border bg-surface">
              {isCurrentHot && (
                <div className="animate-pulse bg-oxblood px-4 py-2.5 text-center text-sm font-bold tracking-wide text-white">
                  🔥 HOT ITEM — BUY NOW
                </div>
              )}
              <div className="relative h-72 w-full bg-inner">
                {currentItem.imageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element -- arbitrary external marketplace domain, not known in advance
                  <img
                    src={currentItem.imageUrl}
                    alt={currentItem.title ?? ""}
                    className="absolute inset-0 h-full w-full object-cover"
                  />
                ) : (
                  <div className="flex h-full w-full items-center justify-center">
                    <ImageOff className="h-10 w-10 text-muted" strokeWidth={1.5} />
                  </div>
                )}
                {currentItem.platform && (
                  <PlatformBadge platform={currentItem.platform} size="md" className="absolute bottom-3 right-3" />
                )}
              </div>

              <div className="flex flex-col gap-3 p-5">
                <div>
                  <h2 className="font-display text-xl font-semibold text-ink">
                    {currentItem.title ?? "Untitled listing"}
                  </h2>
                  <p className="text-sm text-ink-soft">
                    {[currentItem.brand, currentItem.size].filter(Boolean).join(" · ") || "No brand/size on file"}
                  </p>
                </div>

                <p className="font-display text-2xl font-semibold text-oxblood">${currentItem.price.toFixed(2)}</p>

                <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-ink-soft">
                  <span>{currentItem.urgencyLabel}</span>
                  {currentItem.matchPercent != null && <span>{currentItem.matchPercent}% match</span>}
                  {reservationRemainingMs != null && (
                    <span className={reservationRemainingMs < 2 * 60 * 1000 ? "font-semibold text-oxblood" : undefined}>
                      {reservationCountdownMessage(reservationRemainingMs)}
                    </span>
                  )}
                  <span>
                    {securingElapsedMs != null
                      ? `Time spent securing: ${formatDuration(securingElapsedMs)}`
                      : "Not opened yet"}
                  </span>
                </div>

                {currentItem.productUrl && (
                  <a
                    href={currentItem.productUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="truncate text-sm text-ink underline"
                  >
                    {currentItem.productUrl}
                  </a>
                )}

                <div className="mt-2 flex flex-wrap gap-3">
                  <Button type="button" variant="secondary" onClick={() => handleOpen(currentItem)}>
                    Open Listing
                  </Button>
                  <Button
                    type="button"
                    variant="primary"
                    disabled={isCurrentPending}
                    onClick={() => handleResolve(currentItem, "purchased")}
                    className={
                      isCurrentHot
                        ? "animate-pulse !bg-oxblood px-8 py-4 text-base shadow-lg shadow-oxblood/40 hover:!bg-oxblood/90"
                        : undefined
                    }
                  >
                    Mark Purchased
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={isCurrentPending}
                    onClick={() => handleResolve(currentItem, "failed_unavailable")}
                  >
                    Mark Failed
                  </Button>
                </div>
              </div>
            </div>

            {upNextItems.length > 0 && (
              <div className="flex flex-col gap-2">
                <p className="text-xs font-medium uppercase tracking-[0.1em] text-ink-soft">Up next</p>
                {upNextItems.map((item) => {
                  const itemIsHot = isHot(item, now);
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => setCurrentItemId(item.id)}
                      className={`flex cursor-pointer items-center justify-between gap-3 rounded-card border bg-surface px-4 py-2.5 text-left text-sm hover:border-oxblood ${
                        itemIsHot ? "border-oxblood" : "border-border/60"
                      }`}
                    >
                      <span className="flex flex-wrap items-center gap-2">
                        {itemIsHot && (
                          <span className="rounded-pill bg-oxblood px-2 py-0.5 text-[11px] font-bold text-white">
                            🔥 HOT
                          </span>
                        )}
                        <span className="font-medium text-ink">{itemLabel(item)}</span>
                        <span className="text-ink-soft">${item.price.toFixed(2)}</span>
                        <span className="text-ink-soft">{item.urgencyLabel}</span>
                      </span>
                      {item.reservationExpiresAt && (
                        <span className="shrink-0 text-xs text-ink-soft">
                          {formatCountdown(Math.max(0, new Date(item.reservationExpiresAt).getTime() - now))}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
