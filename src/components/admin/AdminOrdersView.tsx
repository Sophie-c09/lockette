"use client";

import { useEffect, useMemo, useState } from "react";
import {
  updateOrderStatus,
  updateOrderItemStatus,
  markOrderItemOpened,
  markOrderItemsSecuring,
} from "@/lib/orderActions";
import { extendReservation } from "@/lib/reservations";

export interface FulfillmentItem {
  id: string;
  orderId: string;
  listingId: string | null;
  platform: string | null;
  productUrl: string | null;
  price: number;
  shippingCost: number;
  status: "pending_purchase" | "securing" | "purchased" | "failed_unavailable";
  openedAt: string | null;
  purchasedAt: string | null;
  imageUrl: string | null;
  brand: string | null;
  title: string | null;
  size: string | null;
  matchPercent: number | null;
  urgencyScore: number;
  urgencyLabel: string;
  // Non-null only while this order (not some other one) still holds the
  // listing's reservation — see src/lib/reservations.ts.
  reservationExpiresAt: string | null;
}

// "securing" (an admin has opened this item's order, but hasn't
// bought/failed it yet) is still actionable, same as "pending_purchase" —
// only "purchased"/"failed_unavailable" are terminal. Centralized here so
// every pending_purchase-only check from before this status existed
// consistently also covers it.
function isUnresolved(status: FulfillmentItem["status"]): boolean {
  return status === "pending_purchase" || status === "securing";
}

export interface FulfillmentOrder {
  id: string;
  status: "pending_purchase" | "processing" | "completed";
  totalAmount: number;
  refundedAmount: number;
  processingStartedAt: string | null;
  // Real Stripe payment system — see src/lib/payment.ts. Nothing in this
  // dashboard triggers a payment transition itself; this is purely a
  // badge. The first group (unpaid/authorized/captured/failed) are
  // historical values from the old fake-payment flow, kept only so old
  // orders still display correctly — new orders only ever use the second
  // group (pending/awaiting_payment/processing/paid/payment_failed/
  // canceled/refunded is shared by both eras).
  paymentStatus:
    | "unpaid"
    | "authorized"
    | "captured"
    | "failed"
    | "refunded"
    | "pending"
    | "awaiting_payment"
    | "processing"
    | "paid"
    | "payment_failed"
    | "canceled";
  createdAt: string;
  items: FulfillmentItem[];
}

const PAYMENT_BADGES: Record<FulfillmentOrder["paymentStatus"], string> = {
  unpaid: "💳 Unpaid",
  authorized: "🔒 Authorized",
  captured: "✅ Paid",
  failed: "⚠️ Failed",
  refunded: "↩️ Refunded",
  pending: "💳 Unpaid",
  awaiting_payment: "⏳ Awaiting payment",
  processing: "⏳ Processing",
  paid: "✅ Paid",
  payment_failed: "⚠️ Failed",
  canceled: "✖️ Canceled",
};

type SortMode = "newest" | "oldest-pending" | "urgency";

const ITEM_STATUS_LABELS: Record<FulfillmentItem["status"], string> = {
  pending_purchase: "🔄 Need to Buy",
  securing: "🔒 Securing",
  purchased: "✅ Purchased",
  failed_unavailable: "❌ Sold Out",
};

function formatElapsedSince(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatSeconds(ms: number): string {
  return `${Math.round(ms / 1000)} seconds`;
}

// "Reservation expires in 08:42" — MM:SS, floored at 00:00 rather than
// going negative once it's actually expired (releaseExpiredReservations
// clears it shortly after anyway).
function formatCountdown(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

// Order-age indicator (spec section 6) — purely a display concern layered
// onto the existing order card, doesn't touch any mutation/business logic.
function orderAgeIndicator(createdAt: string): string {
  const minutes = (Date.now() - new Date(createdAt).getTime()) / 60000;
  if (minutes < 5) return "🔥 New";
  if (minutes < 30) return "⚡ Action needed";
  return "🚨 Urgent";
}

function orderUrgency(order: FulfillmentOrder): number {
  const pendingScores = order.items.filter((item) => isUnresolved(item.status)).map((item) => item.urgencyScore);
  return pendingScores.length > 0 ? Math.max(...pendingScores) : -1;
}

function sortOrders(orders: FulfillmentOrder[], mode: SortMode): FulfillmentOrder[] {
  const copy = [...orders];
  if (mode === "newest") {
    return copy.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }
  if (mode === "oldest-pending") {
    return copy.sort((a, b) => {
      const aPending = a.status !== "completed";
      const bPending = b.status !== "completed";
      if (aPending !== bPending) return aPending ? -1 : 1;
      const aTime = new Date(a.createdAt).getTime();
      const bTime = new Date(b.createdAt).getTime();
      // Pending orders: oldest first. Completed orders (sorted after all
      // pending ones): most recently completed first.
      return aPending ? aTime - bTime : bTime - aTime;
    });
  }
  return copy.sort((a, b) => orderUrgency(b) - orderUrgency(a));
}

// Pending items first (highest urgency first, per spec section 8),
// resolved items after — a stable presentation regardless of which
// order-level sort mode is active.
function sortItemsForDisplay(items: FulfillmentItem[]): FulfillmentItem[] {
  return [...items].sort((a, b) => {
    const aPending = isUnresolved(a.status);
    const bPending = isUnresolved(b.status);
    if (aPending !== bPending) return aPending ? -1 : 1;
    if (aPending) return b.urgencyScore - a.urgencyScore;
    return 0;
  });
}

function applyOrderProcessingOptimistically(orders: FulfillmentOrder[], orderId: string): FulfillmentOrder[] {
  return orders.map((order) => {
    if (order.id !== orderId || order.status !== "pending_purchase") return order;
    return {
      ...order,
      status: "processing",
      processingStartedAt: order.processingStartedAt ?? new Date().toISOString(),
    };
  });
}

// New, additive alongside applyOrderProcessingOptimistically above — moves
// every still-pending item on an order into "securing" (mirrors
// markOrderItemsSecuring's server-side behavior).
function applyItemsSecuringOptimistically(orders: FulfillmentOrder[], orderId: string): FulfillmentOrder[] {
  return orders.map((order) => {
    if (order.id !== orderId) return order;
    return {
      ...order,
      items: order.items.map((item) => (item.status === "pending_purchase" ? { ...item, status: "securing" } : item)),
    };
  });
}

function applyItemStatusOptimistically(
  orders: FulfillmentOrder[],
  itemId: string,
  status: "purchased" | "failed_unavailable",
): FulfillmentOrder[] {
  return orders.map((order) => {
    const itemIndex = order.items.findIndex((item) => item.id === itemId);
    if (itemIndex === -1) return order;

    const item = order.items[itemIndex];
    if (!isUnresolved(item.status)) return order;

    const updatedItems = [...order.items];
    updatedItems[itemIndex] = {
      ...item,
      status,
      purchasedAt: status === "purchased" ? new Date().toISOString() : item.purchasedAt,
    };

    const refundedAmount =
      status === "failed_unavailable" ? order.refundedAmount + item.price + item.shippingCost : order.refundedAmount;

    const allResolved = updatedItems.every(
      (row) => row.status === "purchased" || row.status === "failed_unavailable",
    );

    return {
      ...order,
      items: updatedItems,
      refundedAmount,
      status: allResolved ? "completed" : order.status,
    };
  });
}

const RESERVATION_EXTEND_MS = 15 * 60 * 1000;

function applyReservationExtendedOptimistically(orders: FulfillmentOrder[], itemId: string): FulfillmentOrder[] {
  return orders.map((order) => ({
    ...order,
    items: order.items.map((item) =>
      item.id === itemId
        ? { ...item, reservationExpiresAt: new Date(Date.now() + RESERVATION_EXTEND_MS).toISOString() }
        : item,
    ),
  }));
}

function applyOpenedOptimistically(orders: FulfillmentOrder[], itemId: string): FulfillmentOrder[] {
  return orders.map((order) => ({
    ...order,
    items: order.items.map((item) =>
      item.id === itemId && !item.openedAt ? { ...item, openedAt: new Date().toISOString() } : item,
    ),
  }));
}

function copyDetailsText(item: FulfillmentItem): string {
  return [
    item.brand ? `Brand: ${item.brand}` : null,
    item.title ? `Title: ${item.title}` : null,
    item.size ? `Size: ${item.size}` : null,
    `Price: $${item.price.toFixed(2)}`,
    item.platform ? `Platform: ${item.platform}` : null,
    item.productUrl ? `Product URL: ${item.productUrl}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

// Fulfillment-focused admin dashboard — deliberately unstyled beyond basic
// spacing/borders, per spec ("no styling required"). Optimistic throughout:
// every action updates local state immediately and calls the matching
// server action in the background, rolling back only on an actual error —
// there's no router.refresh()/full-page-reload anywhere in this file.
export function AdminOrdersView({ orders: initialOrders }: { orders: FulfillmentOrder[] }) {
  const [orders, setOrders] = useState(initialOrders);
  const [sortMode, setSortMode] = useState<SortMode>("urgency");
  const [speedMode, setSpeedMode] = useState(false);
  const [expandedOrderIds, setExpandedOrderIds] = useState<Set<string>>(new Set());
  const [currentItemId, setCurrentItemId] = useState<string | null>(null);
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set());
  // Ticks every second purely to force a re-render of any visible
  // reservation countdowns — the actual expiry values live on `orders`.
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);

  const displayOrders = useMemo(
    () => sortOrders(orders, sortMode).map((order) => ({ ...order, items: sortItemsForDisplay(order.items) })),
    [orders, sortMode],
  );

  const flatItems = useMemo(() => displayOrders.flatMap((order) => order.items), [displayOrders]);
  const unresolvedItems = useMemo(
    () => flatItems.filter((item) => isUnresolved(item.status)),
    [flatItems],
  );

  const visibleOrders = useMemo(() => {
    if (!speedMode) return displayOrders;
    return displayOrders
      .map((order) => ({ ...order, items: order.items.filter((item) => isUnresolved(item.status)) }))
      .filter((order) => order.items.length > 0);
  }, [displayOrders, speedMode]);

  const currentItem = flatItems.find((item) => item.id === currentItemId) ?? null;

  const topUrgentItem = useMemo(() => {
    return [...unresolvedItems].sort((a, b) => b.urgencyScore - a.urgencyScore)[0] ?? null;
  }, [unresolvedItems]);

  const purchaseDurationsMs = useMemo(() => {
    return flatItems
      .filter((item) => item.openedAt && item.purchasedAt)
      .map((item) => new Date(item.purchasedAt as string).getTime() - new Date(item.openedAt as string).getTime())
      .filter((ms) => ms >= 0);
  }, [flatItems]);

  const averageDurationMs =
    purchaseDurationsMs.length > 0
      ? purchaseDurationsMs.reduce((sum, ms) => sum + ms, 0) / purchaseDurationsMs.length
      : null;
  const fastestDurationMs = purchaseDurationsMs.length > 0 ? Math.min(...purchaseDurationsMs) : null;

  function isPending(id: string): boolean {
    return pendingIds.has(id);
  }

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

  function focusNextUnresolved(afterItemId?: string | null) {
    const list = flatItems.filter((item) => isUnresolved(item.status));
    if (list.length === 0) {
      setCurrentItemId(null);
      return;
    }
    if (!afterItemId) {
      setCurrentItemId(list[0].id);
      return;
    }
    const index = list.findIndex((item) => item.id === afterItemId);
    const next = index === -1 ? list[0] : (list[(index + 1) % list.length] ?? list[0]);
    setCurrentItemId(next.id);
  }

  async function handleToggleOrderExpanded(order: FulfillmentOrder) {
    const alreadyExpanded = expandedOrderIds.has(order.id);

    setExpandedOrderIds((prev) => {
      const next = new Set(prev);
      if (alreadyExpanded) next.delete(order.id);
      else next.add(order.id);
      return next;
    });

    // Additive alongside the existing "mark the order processing"
    // behavior below, not a replacement for it — opening an order also
    // moves its still-pending items into "securing" (spec section 2).
    if (!alreadyExpanded) {
      await handleMarkSecuring(order.id);
    }

    if (!alreadyExpanded && order.status === "pending_purchase") {
      await handleMarkProcessing(order.id);
    }
  }

  async function handleMarkProcessing(orderId: string) {
    const previous = orders;
    setOrders((current) => applyOrderProcessingOptimistically(current, orderId));

    await withPending(orderId, async () => {
      const result = await updateOrderStatus(orderId, "processing");
      if (result.error) {
        console.error("[admin-orders] updateOrderStatus failed:", result.error);
        setOrders(previous);
        alert(result.error);
      }
    });
  }

  async function handleMarkSecuring(orderId: string) {
    const previous = orders;
    setOrders((current) => applyItemsSecuringOptimistically(current, orderId));

    await withPending(orderId, async () => {
      const result = await markOrderItemsSecuring(orderId);
      if (result.error) {
        console.error("[admin-orders] markOrderItemsSecuring failed:", result.error);
        setOrders(previous);
      }
    });
  }

  async function handleExtendReservation(item: FulfillmentItem) {
    if (!item.listingId) return;

    const previous = orders;
    setOrders((current) => applyReservationExtendedOptimistically(current, item.id));

    await withPending(item.id, async () => {
      const result = await extendReservation(item.listingId as string);
      if (result.error) {
        console.error("[admin-orders] extendReservation failed:", result.error);
        setOrders(previous);
        alert(result.error);
      }
    });
  }

  async function handleOpenItem(item: FulfillmentItem) {
    if (item.productUrl) {
      window.open(item.productUrl, "_blank", "noopener,noreferrer");
      try {
        await navigator.clipboard.writeText(item.productUrl);
      } catch {
        // Clipboard access can be denied/unavailable — the tab already
        // opened, which is the important part; copying is a bonus.
      }
    }

    if (!item.openedAt) {
      setOrders((current) => applyOpenedOptimistically(current, item.id));
      // opened_at is an analytics timestamp, not user-facing correctness
      // state — not worth rolling back over; the tab already opened
      // regardless of whether this write succeeds.
      markOrderItemOpened(item.id).catch(() => {});
    }
  }

  function handleOpenAllPending() {
    for (const item of unresolvedItems) {
      if (item.productUrl) {
        window.open(item.productUrl, "_blank", "noopener,noreferrer");
      }
    }
    setOrders((current) => {
      let next = current;
      for (const item of unresolvedItems) {
        if (!item.openedAt) next = applyOpenedOptimistically(next, item.id);
      }
      return next;
    });
    for (const item of unresolvedItems) {
      if (!item.openedAt) markOrderItemOpened(item.id).catch(() => {});
    }
  }

  async function handleCopyDetails(item: FulfillmentItem) {
    try {
      await navigator.clipboard.writeText(copyDetailsText(item));
    } catch (error) {
      console.error("[admin-orders] Clipboard write failed:", error);
      alert("Could not copy to clipboard.");
    }
  }

  async function handleItemStatus(item: FulfillmentItem, status: "purchased" | "failed_unavailable") {
    if (!isUnresolved(item.status)) return;

    const previous = orders;
    setOrders((current) => applyItemStatusOptimistically(current, item.id, status));

    await withPending(item.id, async () => {
      const result = await updateOrderItemStatus(item.id, status);
      if (result.error) {
        console.error("[admin-orders] updateOrderItemStatus failed:", result.error);
        setOrders(previous);
        alert(result.error);
        return;
      }
      // After completing an item, automatically focus the next unresolved
      // one (spec section 5).
      focusNextUnresolved(item.id);
    });
  }

  function handleToggleSpeedMode() {
    setSpeedMode((prev) => {
      const next = !prev;
      if (next && unresolvedItems.length > 0) {
        setCurrentItemId(unresolvedItems[0].id);
      }
      return next;
    });
  }

  // Keyboard shortcuts: O (open), C (copy), P (purchased), F (failed), N
  // (next unresolved) — ignored while a modifier key is held (so real
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
        focusNextUnresolved(currentItemId);
        return;
      }

      if (!currentItem) return;

      if (key === "o") {
        event.preventDefault();
        handleOpenItem(currentItem);
      } else if (key === "c") {
        event.preventDefault();
        handleCopyDetails(currentItem);
      } else if (key === "p") {
        event.preventDefault();
        handleItemStatus(currentItem, "purchased");
      } else if (key === "f") {
        event.preventDefault();
        handleItemStatus(currentItem, "failed_unavailable");
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentItem, currentItemId, flatItems]);

  return (
    <div className="px-6 py-12 pb-28">
      <h1 className="text-xl font-semibold">Fulfillment</h1>

      <div className="mt-4 flex flex-wrap items-center gap-4 text-sm">
        <label className="flex items-center gap-2">
          Sort:
          <select
            value={sortMode}
            onChange={(event) => setSortMode(event.target.value as SortMode)}
            className="border border-border rounded-md px-2 py-1"
          >
            <option value="newest">Newest orders first</option>
            <option value="oldest-pending">Oldest pending orders first</option>
            <option value="urgency">Highest urgency first</option>
          </select>
        </label>

        <label className="flex items-center gap-2 cursor-pointer">
          <input type="checkbox" checked={speedMode} onChange={handleToggleSpeedMode} />
          Speed Mode
        </label>

        <button
          type="button"
          onClick={handleOpenAllPending}
          disabled={unresolvedItems.length === 0}
          className="cursor-pointer border border-border rounded-md px-3 py-1.5 disabled:opacity-50"
        >
          Open All Pending Items ({unresolvedItems.length})
        </button>
      </div>

      <div className="mt-3 flex flex-wrap gap-4 text-xs text-ink-soft">
        <span>Average purchase time: {averageDurationMs != null ? formatSeconds(averageDurationMs) : "—"}</span>
        <span>Fastest: {fastestDurationMs != null ? formatSeconds(fastestDurationMs) : "—"}</span>
      </div>

      {topUrgentItem && (
        <div className="mt-4 border border-oxblood rounded-md p-3 text-sm">
          🔥 Buy First: {topUrgentItem.brand ?? "Unknown brand"} — {topUrgentItem.title ?? "Untitled"} — $
          {topUrgentItem.price.toFixed(2)}{" "}
          <button
            type="button"
            onClick={() => setCurrentItemId(topUrgentItem.id)}
            className="cursor-pointer underline"
          >
            Focus
          </button>
        </div>
      )}

      {speedMode ? (
        <div className="mt-6 flex flex-col gap-3">
          {unresolvedItems.length === 0 ? (
            <p className="text-sm text-ink-soft">Nothing pending. 🎉</p>
          ) : (
            unresolvedItems.map((item) => (
              <ItemCard
                key={item.id}
                item={item}
                speedMode
                focused={item.id === currentItemId}
                pending={isPending(item.id)}
                now={now}
                onFocus={() => setCurrentItemId(item.id)}
                onOpen={() => handleOpenItem(item)}
                onCopy={() => handleCopyDetails(item)}
                onPurchased={() => handleItemStatus(item, "purchased")}
                onFailed={() => handleItemStatus(item, "failed_unavailable")}
                onExtend={() => handleExtendReservation(item)}
              />
            ))
          )}
        </div>
      ) : (
        <div className="mt-6 flex flex-col gap-3">
          {visibleOrders.length === 0 ? (
            <p className="text-sm text-ink-soft">No orders yet.</p>
          ) : (
            visibleOrders.map((order) => {
              const expanded = expandedOrderIds.has(order.id);
              const pendingCount = order.items.filter((item) => isUnresolved(item.status)).length;

              return (
                <div key={order.id} className="border border-border rounded-md p-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <button
                      type="button"
                      onClick={() => handleToggleOrderExpanded(order)}
                      className="cursor-pointer text-left"
                    >
                      <div className="text-sm font-medium">
                        {order.id} {order.status !== "completed" && orderAgeIndicator(order.createdAt)}{" "}
                        {PAYMENT_BADGES[order.paymentStatus] ?? order.paymentStatus}
                      </div>
                      <div className="text-xs text-ink-soft">
                        {formatElapsedSince(order.createdAt)} · {order.items.length} item
                        {order.items.length === 1 ? "" : "s"} ({pendingCount} pending) · status: {order.status}
                      </div>
                      <div className="text-xs text-ink-soft">
                        total: ${order.totalAmount.toFixed(2)} · refunded: ${order.refundedAmount.toFixed(2)}
                      </div>
                    </button>

                    <button
                      type="button"
                      disabled={isPending(order.id)}
                      onClick={() => handleMarkProcessing(order.id)}
                      className="cursor-pointer border border-border rounded-md px-3 py-1.5 text-xs disabled:opacity-50"
                    >
                      Mark Processing
                    </button>
                  </div>

                  {expanded && (
                    <div className="mt-4 flex flex-col gap-2 border-t border-border/60 pt-4">
                      {order.items.length === 0 ? (
                        <p className="text-xs text-ink-soft">No items on this order.</p>
                      ) : (
                        order.items.map((item) => (
                          <ItemCard
                            key={item.id}
                            item={item}
                            speedMode={false}
                            focused={item.id === currentItemId}
                            pending={isPending(item.id)}
                            now={now}
                            onFocus={() => setCurrentItemId(item.id)}
                            onOpen={() => handleOpenItem(item)}
                            onCopy={() => handleCopyDetails(item)}
                            onPurchased={() => handleItemStatus(item, "purchased")}
                            onFailed={() => handleItemStatus(item, "failed_unavailable")}
                            onExtend={() => handleExtendReservation(item)}
                          />
                        ))
                      )}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      )}

      {currentItem && (
        <div className="fixed bottom-0 left-0 right-0 border-t border-border bg-surface p-4">
          <div className="mx-auto flex max-w-3xl flex-wrap items-center justify-between gap-3">
            <span className="text-sm font-medium">
              {currentItem.brand ?? "Unknown brand"} — ${currentItem.price.toFixed(2)}
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => handleOpenItem(currentItem)}
                className="cursor-pointer border border-border rounded-md px-4 py-2 text-sm"
              >
                OPEN
              </button>
              <button
                type="button"
                onClick={() => handleCopyDetails(currentItem)}
                className="cursor-pointer border border-border rounded-md px-4 py-2 text-sm"
              >
                COPY
              </button>
              <button
                type="button"
                disabled={!isUnresolved(currentItem.status) || isPending(currentItem.id)}
                onClick={() => handleItemStatus(currentItem, "purchased")}
                className="cursor-pointer border border-border rounded-md px-4 py-2 text-sm disabled:opacity-50"
              >
                PURCHASED
              </button>
              <button
                type="button"
                disabled={!isUnresolved(currentItem.status) || isPending(currentItem.id)}
                onClick={() => handleItemStatus(currentItem, "failed_unavailable")}
                className="cursor-pointer border border-border rounded-md px-4 py-2 text-sm disabled:opacity-50"
              >
                FAILED
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ItemCard({
  item,
  speedMode,
  focused,
  pending,
  now,
  onFocus,
  onOpen,
  onCopy,
  onPurchased,
  onFailed,
  onExtend,
}: {
  item: FulfillmentItem;
  speedMode: boolean;
  focused: boolean;
  pending: boolean;
  now: number;
  onFocus: () => void;
  onOpen: () => void;
  onCopy: () => void;
  onPurchased: () => void;
  onFailed: () => void;
  onExtend: () => void;
}) {
  const isResolved = !isUnresolved(item.status);
  const buttonSizeClass = speedMode ? "px-5 py-3 text-base" : "px-3 py-1.5 text-xs";
  const reservationRemainingMs = item.reservationExpiresAt
    ? new Date(item.reservationExpiresAt).getTime() - now
    : null;

  return (
    <div
      onClick={onFocus}
      className={`flex flex-wrap items-center gap-3 rounded-md border p-3 text-sm cursor-pointer ${
        focused ? "border-oxblood" : "border-border/60"
      }`}
    >
      {!speedMode && item.imageUrl && (
        // eslint-disable-next-line @next/next/no-img-element -- arbitrary external marketplace domain, not known in advance
        <img src={item.imageUrl} alt={item.title ?? ""} className="h-16 w-16 shrink-0 rounded object-cover" />
      )}

      <div className="flex flex-1 flex-col gap-0.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{item.brand ?? "Unknown brand"}</span>
          {!speedMode && item.title && <span className="text-ink-soft">{item.title}</span>}
          {item.platform && <span className="text-ink-soft">· {item.platform}</span>}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs text-ink-soft">
          <span>${item.price.toFixed(2)}</span>
          <span>{ITEM_STATUS_LABELS[item.status] ?? item.status}</span>
          {item.matchPercent != null && <span>{item.matchPercent}% match</span>}
          <span>{item.urgencyLabel}</span>
          {reservationRemainingMs != null && (
            <span>
              {reservationRemainingMs > 0
                ? `Reservation expires in ${formatCountdown(reservationRemainingMs)}`
                : "Reservation expired"}
            </span>
          )}
          {item.productUrl && (
            <a
              href={item.productUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(event) => event.stopPropagation()}
              className="underline"
            >
              product link
            </a>
          )}
        </div>
      </div>

      <div className="flex flex-wrap gap-2" onClick={(event) => event.stopPropagation()}>
        <button type="button" onClick={onOpen} className={`cursor-pointer border border-border rounded-md ${buttonSizeClass}`}>
          Open Item
        </button>
        <button type="button" onClick={onCopy} className={`cursor-pointer border border-border rounded-md ${buttonSizeClass}`}>
          Copy Details
        </button>
        {reservationRemainingMs != null && (
          <button
            type="button"
            disabled={pending}
            onClick={onExtend}
            className={`cursor-pointer border border-border rounded-md disabled:opacity-50 ${buttonSizeClass}`}
          >
            Extend Reservation
          </button>
        )}
        <button
          type="button"
          disabled={isResolved || pending}
          onClick={onPurchased}
          className={`cursor-pointer border border-border rounded-md disabled:opacity-50 ${buttonSizeClass}`}
        >
          Mark Purchased
        </button>
        <button
          type="button"
          disabled={isResolved || pending}
          onClick={onFailed}
          className={`cursor-pointer border border-border rounded-md disabled:opacity-50 ${buttonSizeClass}`}
        >
          Mark Failed
        </button>
      </div>
    </div>
  );
}
