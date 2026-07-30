"use server";

import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isCurrentUserAdmin } from "@/lib/admin";
import { createNotification } from "@/lib/notifications";
import { syncOrderStatus } from "@/lib/orderLifecycle";

export type OrderStatus = "pending_purchase" | "processing" | "completed";
export type OrderItemStatus = "purchased" | "failed_unavailable";

// App-level gate before even attempting a query, in addition to (not
// instead of) the is_admin() RLS policies in supabase/schema.sql, which
// are the actual enforcement boundary — a non-admin caller would just get
// a 0-row, silently-ignored update from Postgres, which isn't a useful
// error message on its own.
async function requireAdmin(): Promise<{ error?: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user || !(await isCurrentUserAdmin(supabase, user.id))) {
    return { error: "Not authorized." };
  }

  return {};
}

export async function updateOrderStatus(
  orderId: string,
  status: OrderStatus,
): Promise<{ error?: string }> {
  const authCheck = await requireAdmin();
  if (authCheck.error) return authCheck;

  const supabase = await createClient();

  const { data, error } = await supabase
    .from("orders")
    .update({ status })
    .eq("id", orderId)
    .select("id");

  if (error) {
    console.error("[update-order-status-error]", error);
    return { error: error.message };
  }

  // RLS silently hides rows a caller isn't allowed to touch rather than
  // erroring — a 0-row result here means "not allowed" or "doesn't
  // exist," not success.
  if (!data || data.length === 0) {
    return { error: "Order not found or not allowed." };
  }

  // Stamped once, the first time an order moves into "processing" — a
  // separate, conditional update (rather than folding into the one
  // above) so re-asserting "processing" on an order that's already past
  // that point still succeeds without pushing this timestamp forward,
  // since it feeds the fulfillment dashboard's speed analytics.
  if (status === "processing") {
    const { error: stampError } = await supabase
      .from("orders")
      .update({ processing_started_at: new Date().toISOString() })
      .eq("id", orderId)
      .is("processing_started_at", null);

    if (stampError) {
      console.error("[update-order-status-error] Failed to stamp processing_started_at:", stampError);
    }
  }

  return {};
}

export async function updateOrderItemStatus(
  orderItemId: string,
  status: OrderItemStatus,
): Promise<{ error?: string }> {
  const authCheck = await requireAdmin();
  if (authCheck.error) return authCheck;

  const supabase = await createClient();

  const { data: item, error: itemError } = await supabase
    .from("order_items")
    .select("id, order_id, listing_id, price, shipping_cost, status")
    .eq("id", orderItemId)
    .maybeSingle();

  if (itemError || !item) {
    console.error("[update-order-item-status-error]", itemError);
    return { error: itemError?.message ?? "Order item not found." };
  }

  // Only a not-yet-resolved item can transition — "pending_purchase" or
  // the newer "securing" state (an admin has opened its order, but hasn't
  // bought/failed it yet) both count; "purchased"/"failed_unavailable" are
  // terminal. Without this, a double-click, a retried request, or
  // clicking "Mark Failed" on an already-resolved item would re-run the
  // refund step below and double (or wrongly re-)count it against
  // orders.refunded_amount.
  if (item.status !== "pending_purchase" && item.status !== "securing") {
    return { error: `This item is already "${item.status}".` };
  }

  const { data: updated, error: updateError } = await supabase
    .from("order_items")
    .update({ status })
    .eq("id", orderItemId)
    // Belt-and-suspenders against the same double-refund risk: if another
    // request resolved this item between the read above and this write,
    // this condition simply matches zero rows instead of overwriting it.
    .in("status", ["pending_purchase", "securing"])
    .select("id");

  if (updateError) {
    console.error("[update-order-item-status-error]", updateError);
    return { error: updateError.message };
  }

  if (!updated || updated.length === 0) {
    return { error: "This item was already resolved by another request." };
  }

  // Fetched once, reused by the notifications below — both need to know
  // which customer to notify (item_secured/item_failed are admin-
  // triggered, on behalf of the order's owner, not the signed-in admin).
  const { data: orderRow, error: orderFetchError } = await supabase
    .from("orders")
    .select("user_id")
    .eq("id", item.order_id)
    .maybeSingle();

  if (orderFetchError || !orderRow) {
    console.error("[update-order-item-status-error] Failed to read order:", orderFetchError);
  }

  // A separate, best-effort write — deliberately not folded into the
  // status update above. purchased_at only feeds dashboard analytics; it
  // must never be able to fail (or block on) the core status transition
  // itself, which is the part every existing caller actually depends on.
  if (status === "purchased") {
    const { error: stampError } = await supabase
      .from("order_items")
      .update({ purchased_at: new Date().toISOString() })
      .eq("id", orderItemId);

    if (stampError) {
      console.error("[update-order-item-status-error] Failed to stamp purchased_at:", stampError);
    }

    if (orderRow) {
      const { error: notifyError } = await createNotification({
        userId: orderRow.user_id,
        orderId: item.order_id,
        orderItemId: item.id,
        type: "item_secured",
        title: "Item secured",
        message: "Your item has been secured ✅",
      });

      if (notifyError) {
        console.error("[update-order-item-status-error] Failed to create item_secured notification:", notifyError);
      }
    }

    // Best-effort — this is the one and only place an order_item reaches a
    // terminal "bought" state, so it's the single hook point for marking
    // the underlying listing permanently gone everywhere it's browsed (see
    // supabase/schema.sql's listings.status). Uses the service-role client:
    // status/last_checked_at are deliberately NOT part of the narrow
    // `grant update (...) to authenticated` (see schema.sql) — even an
    // admin session has no column-level privilege to write them directly.
    if (item.listing_id) {
      const adminSupabase = createAdminClient();
      const { error: soldError } = await adminSupabase
        .from("listings")
        .update({ status: "sold" })
        .eq("id", item.listing_id);

      if (soldError) {
        console.error("[update-order-item-status-error] Failed to mark listing sold:", soldError);
      }
    }
  }

  if (status === "failed_unavailable") {
    // Best-effort — release this listing's reservation (see
    // src/lib/reservations.ts) now that it's confirmed unavailable, so
    // another customer can see/buy it again instead of it staying stuck
    // "held" for an order that's no longer trying to buy it. Scoped to
    // this specific order via reserved_by_order_id so it can never
    // accidentally clear a different order's (newer) reservation on the
    // same listing.
    if (item.listing_id) {
      const { error: releaseError } = await supabase
        .from("listings")
        .update({ reserved_by_order_id: null, reserved_at: null, reservation_expires_at: null })
        .eq("id", item.listing_id)
        .eq("reserved_by_order_id", item.order_id);

      if (releaseError) {
        console.error("[update-order-item-status-error] Failed to release reservation:", releaseError);
      }
    }

    if (orderRow) {
      const { error: notifyError } = await createNotification({
        userId: orderRow.user_id,
        orderId: item.order_id,
        orderItemId: item.id,
        type: "item_failed",
        title: "Item unavailable",
        message: "This item was unavailable. Your refund has been processed.",
      });

      if (notifyError) {
        console.error("[update-order-item-status-error] Failed to create item_failed notification:", notifyError);
      }
    }
  }

  // Order status, refunded_amount, and the order_completed notification
  // are all derived from order_items' current statuses in one place —
  // see src/lib/orderLifecycle.ts. Best-effort: the item status transition
  // above already committed and is the part every caller depends on.
  const syncResult = await syncOrderStatus(item.order_id);
  if (syncResult.error) {
    console.error("[update-order-item-status-error] syncOrderStatus failed:", syncResult.error);
  }

  return {};
}

// Fired by the fulfillment dashboard's "Open Item" action — stamps
// opened_at the first time an item is opened, feeding the "time to
// purchase" (opened_at -> purchased_at) speed metric. Deliberately a
// no-op (not an error) on a second call: re-opening the same listing's
// tab again shouldn't push the timer forward.
export async function markOrderItemOpened(orderItemId: string): Promise<{ error?: string }> {
  const authCheck = await requireAdmin();
  if (authCheck.error) return authCheck;

  const supabase = await createClient();

  const { error } = await supabase
    .from("order_items")
    .update({ opened_at: new Date().toISOString() })
    .eq("id", orderItemId)
    .is("opened_at", null);

  if (error) {
    console.error("[mark-order-item-opened-error]", error);
    return { error: error.message };
  }

  return {};
}

// Fired when an admin opens an order in the fulfillment dashboard — moves
// every still-pending item on that order into "securing" (see supabase/
// schema.sql's order_items_status_check). A new, additive transition
// alongside — not a replacement for — updateOrderStatus's existing
// "mark the order processing" behavior; items already past
// pending_purchase (securing/purchased/failed_unavailable) are untouched.
export async function markOrderItemsSecuring(orderId: string): Promise<{ error?: string }> {
  const authCheck = await requireAdmin();
  if (authCheck.error) return authCheck;

  const supabase = await createClient();

  const { error } = await supabase
    .from("order_items")
    .update({ status: "securing" })
    .eq("order_id", orderId)
    .eq("status", "pending_purchase");

  if (error) {
    console.error("[mark-order-items-securing-error]", error);
    return { error: error.message };
  }

  // Best-effort, separate from the core status write above — same
  // reasoning as processing_started_at/purchased_at elsewhere in this
  // file: an analytics timestamp must never be able to fail (or be
  // coupled to) the actual status transition.
  const { error: stampError } = await supabase
    .from("order_items")
    .update({ securing_started_at: new Date().toISOString() })
    .eq("order_id", orderId)
    .eq("status", "securing")
    .is("securing_started_at", null);

  if (stampError) {
    console.error("[mark-order-items-securing-error] Failed to stamp securing_started_at:", stampError);
  }

  return {};
}
