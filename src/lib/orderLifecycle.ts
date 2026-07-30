"use server";

import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { createNotification } from "@/lib/notifications";
import { capturePayment } from "@/lib/payment";

const CAPTURE_RETRY_INITIAL_DELAY_MS = 5 * 60 * 1000;
const CAPTURE_RETRY_MAX_DELAY_MS = 60 * 60 * 1000;

/**
 * Best-effort — stamps capture_retry_at after a failed automatic capture,
 * so retryPendingCaptures() (src/lib/paymentRetry.ts) knows when it's
 * safe to try again. Exponential backoff: 5m, then double each
 * subsequent failure for the same order (10m, 20m, 40m), capped at 1h —
 * called both from syncOrderStatus below (first failure) and from
 * retryPendingCaptures (every failure after that).
 *
 * capture_retry_at is the only piece of state this feature is allowed to
 * add (no separate "delay" or "attempt count" column) — so the previous
 * delay is *approximated* from how far the existing capture_retry_at
 * still is from right now, floored at the initial delay so a reschedule
 * can never come out shorter than 5 minutes. This is exact when
 * consecutive failures happen close together in wall-clock time relative
 * to the delay (the common case for a retry storm); if real time drifts
 * far enough that the gap collapses to near-zero, it floors back to the
 * base delay rather than under- or over-shooting — never violates "don't
 * retry immediately," even though it can't guarantee the exact 5/10/20/40
 * rung on every single call in every timing scenario.
 *
 * Never thrown: a missing capture_retry_at column (not yet migrated onto
 * the live DB) just means the retry sweep falls back to retrying every
 * "authorized" + "completed" order it finds every time it runs, instead
 * of respecting the delay — degraded, not broken.
 */
export async function scheduleCaptureRetry(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- matching createClient()'s own untyped default (see supabase/server.ts)
  supabase: SupabaseClient<any>,
  orderId: string,
): Promise<void> {
  const { data, error: fetchError } = await supabase
    .from("orders")
    .select("capture_retry_at")
    .eq("id", orderId)
    .maybeSingle();

  if (fetchError) {
    console.error("[order-lifecycle] Failed to read capture_retry_at (column may not exist yet):", fetchError);
    return;
  }

  const now = Date.now();
  const previousRetryAt: string | null | undefined = data?.capture_retry_at;

  let nextDelayMs: number;
  if (!previousRetryAt) {
    nextDelayMs = CAPTURE_RETRY_INITIAL_DELAY_MS;
  } else {
    const impliedPreviousDelayMs = Math.max(CAPTURE_RETRY_INITIAL_DELAY_MS, Math.abs(now - new Date(previousRetryAt).getTime()));
    nextDelayMs = Math.min(CAPTURE_RETRY_MAX_DELAY_MS, impliedPreviousDelayMs * 2);
  }

  const retryAt = new Date(now + nextDelayMs).toISOString();
  const { error: updateError } = await supabase.from("orders").update({ capture_retry_at: retryAt }).eq("id", orderId);

  if (updateError) {
    console.error("[order-lifecycle] Failed to schedule capture retry:", updateError);
  }
}

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
  // Stricter than allResolved: a fully successful order, not just a
  // finished one — an order with even one failed_unavailable item is
  // "resolved" but should never auto-capture (it likely needs a partial
  // refund instead, not a full capture).
  const allPurchased = items.every((item) => item.status === "purchased");
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

      // Automatically capture payment once fulfillment is fully
      // successful — every item purchased, none failed_unavailable (see
      // allPurchased above). Only fires on this same one-time transition
      // into "completed" as the notification above, so a completed order
      // is never captured twice. Checking payment_status === "authorized"
      // first (rather than always calling capturePayment and letting its
      // own internal guard no-op) avoids calling it — and logging a
      // result — for orders that were never authorized in the first
      // place. capturePayment itself (src/lib/payment.ts, untouched) is
      // also already safe to call more than once: it no-ops unless
      // payment_status is exactly "authorized", so it can never capture
      // an already-"captured" order either.
      if (allPurchased && order.payment_status === "authorized") {
        try {
          const captureResult = await capturePayment(orderId);
          if (!captureResult.success) {
            // Logged, payment_status deliberately left untouched here —
            // capturePayment already leaves it exactly as it found it on
            // failure, and this file has no business overriding that.
            // Instead, schedule a later retry rather than requiring an
            // admin to notice and re-trigger it manually.
            console.error("[order-lifecycle] capturePayment did not succeed:", captureResult.paymentStatus);
            await scheduleCaptureRetry(supabase, orderId);
          }
        } catch (error) {
          console.error("[order-lifecycle] capturePayment threw unexpectedly:", error);
          await scheduleCaptureRetry(supabase, orderId);
        }
      }
    }
  }

  return {};
}
