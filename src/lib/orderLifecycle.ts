"use server";

import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { createNotification } from "@/lib/notifications";

// Turns whatever value a numeric DB column round-tripped as into a safe,
// finite number — same reasoning as the identical helper in createOrder.ts
// and orderActions.ts.
function toSafeNumber(value: unknown): number {
  const num = Number(value ?? 0);
  return Number.isFinite(num) ? num : 0;
}

// An order_item still in one of these hasn't been resolved yet — same
// list as ACTIVE_ITEM_STATUSES in createOrder.ts.
const ACTIVE_ITEM_STATUSES = ["pending_purchase", "securing"];
const RESOLVED_ITEM_STATUSES = ["purchased", "failed_unavailable"];

/**
 * Derives an order's own status purely from its order_items' current
 * statuses, and applies the side effects that follow from that: the
 * refunded_amount total, and the one-time "order completed" notification.
 *
 * Called by orderActions.ts's updateOrderItemStatus after every item
 * status change, so a single source of truth (this function) keeps order
 * status, refunds, and the completion notification in sync — no call site
 * has to separately re-derive and update them itself. Also called by
 * createOrder.ts's checkout-time availability check (see reserveListings
 * in src/lib/reservations.ts) when a listing turns out to already be
 * sold/unavailable at the moment of purchase.
 *
 * The only payment_status transition triggered from here is an automatic
 * capturePayment() when every item was cleanly purchased (see below) —
 * everything else about an order's authorize/capture state is untouched,
 * unrelated fulfillment outcomes included.
 *
 * `client` is optional and defaults to the request-scoped session client
 * (orderActions.ts's existing behavior, where the caller has already
 * passed an admin auth check). orders/order_items only grant UPDATE to
 * admins via RLS (see supabase/schema.sql) — createOrder.ts runs as the
 * purchasing customer's own session, which that policy would silently
 * block, so it passes in a service-role client instead. Same reasoning as
 * releaseExpiredReservations() in src/lib/reservations.ts: this is the
 * system asserting a fact (the order didn't fully succeed), not the
 * customer editing their own order.
 */
export async function syncOrderStatus(
  orderId: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- matching createClient()'s own untyped default (see supabase/server.ts)
  client?: SupabaseClient<any>,
): Promise<{ error?: string }> {
  const supabase = client ?? (await createClient());

  const { data: items, error: itemsError } = await supabase
    .from("order_items")
    .select("status, price, shipping_cost")
    .eq("order_id", orderId);

  if (itemsError) {
    console.error("[order-lifecycle] Failed to fetch order_items:", itemsError);
    return { error: itemsError.message };
  }

  if (!items || items.length === 0) return {};

  // payment_status is fetched separately from the core user_id/status
  // columns below aren't allowed to depend on — a missing/misconfigured
  // payment_status column must never be able to break order status/refund
  // syncing, which every existing caller already relies on. Falls back to
  // null (skipping the auto-capture check further down) rather than
  // failing the whole function.
  let order: { user_id: string; status: string; payment_status: string | null } | null = null;
  {
    const { data, error } = await supabase
      .from("orders")
      .select("user_id, status, payment_status")
      .eq("id", orderId)
      .maybeSingle();

    if (error) {
      console.error("[order-lifecycle] payment_status query failed, falling back:", error);
      const fallback = await supabase.from("orders").select("user_id, status").eq("id", orderId).maybeSingle();

      if (fallback.error || !fallback.data) {
        console.error("[order-lifecycle] Failed to fetch order:", fallback.error);
        return { error: fallback.error?.message ?? "Order not found." };
      }

      order = { ...fallback.data, payment_status: null };
    } else if (!data) {
      return { error: "Order not found." };
    } else {
      order = data;
    }
  }

  const hasActiveItem = items.some((item) => ACTIVE_ITEM_STATUSES.includes(item.status));
  const allResolved = items.every((item) => RESOLVED_ITEM_STATUSES.includes(item.status));
  const nextStatus = hasActiveItem ? "processing" : allResolved ? "completed" : null;

  // Recomputed as a fresh total every call — never incremented — so this
  // is always correct regardless of how many times (or in what order)
  // this runs, rather than carrying the double-count risk an "add this
  // item's refund" style update would have if it ever ran twice for the
  // same item.
  const refundedAmount = items
    .filter((item) => item.status === "failed_unavailable")
    .reduce((sum, item) => sum + toSafeNumber(item.price) + toSafeNumber(item.shipping_cost), 0);

  const { error: refundError } = await supabase
    .from("orders")
    .update({ refunded_amount: refundedAmount })
    .eq("id", orderId);

  if (refundError) {
    console.error("[order-lifecycle] Failed to update refunded_amount:", refundError);
  }

  if (nextStatus && nextStatus !== order.status) {
    const { error: statusError } = await supabase.from("orders").update({ status: nextStatus }).eq("id", orderId);

    if (statusError) {
      console.error("[order-lifecycle] Failed to update order status:", statusError);
      return { error: statusError.message };
    }

    // Only fires on the actual transition into "completed" (guarded by
    // nextStatus !== order.status above) — never on a later no-op sync
    // call against an order that's already completed.
    if (nextStatus === "completed") {
      const { error: notifyError } = await createNotification({
        userId: order.user_id,
        orderId,
        type: "order_completed",
        title: "Order complete",
        message: "Your order is ready 🎉",
      });

      if (notifyError) {
        console.error("[order-lifecycle] Failed to create order_completed notification:", notifyError);
      }

      // Payment itself was already captured at checkout time (standard
      // automatic-capture PaymentIntents — see src/lib/payment.ts's own
      // header comment) — there is no separate "capture once fulfillment
      // finishes" step anymore. An order with one or more
      // failed_unavailable items still owes the customer a partial refund
      // for those items (refunded_amount, updated above, tracks exactly
      // how much) — issuing that Stripe refund is currently a manual,
      // admin-initiated step (see refundPayment in src/lib/payment.ts and
      // this feature's own report) rather than automated here.
    }
  }

  return {};
}
