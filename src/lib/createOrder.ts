"use server";

import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createNotification } from "@/lib/notifications";
import { reserveListings } from "@/lib/reservations";
import { syncOrderStatus } from "@/lib/orderLifecycle";
import { authorizePayment } from "@/lib/payment";
import { retryPendingCaptures } from "@/lib/paymentRetry";
import { calculateCartTotal } from "@/lib/pricing";

// Turns whatever value a numeric DB column round-tripped as (PostgREST
// commonly serializes Postgres `numeric` columns as strings, not JS
// numbers, to avoid floating-point precision loss) into a safe, finite
// number — never NaN, even if the value is missing, null, or unparseable.
function toSafeNumber(value: unknown): number {
  const num = Number(value ?? 0);
  return Number.isFinite(num) ? num : 0;
}

// An order_item still in one of these statuses hasn't been resolved
// (purchased or sold out) yet — see also isUnresolved() in
// AdminOrdersView.tsx, the client-side equivalent of this same concept.
const ACTIVE_ITEM_STATUSES = ["pending_purchase", "securing"];

// Collected by the /checkout form (see CheckoutView.tsx) and saved as-is
// into orders.shipping_address (jsonb) — this column has existed since
// the very first orders migration, unlike most of the fields this order
// system has grown since, so it needs none of the "might not exist yet"
// defensiveness the rest of this file uses.
export interface ShippingAddress {
  fullName: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  country: string;
}

// Best-effort — payment_status defaults to 'unpaid' at the DB level (see
// supabase/schema.sql) once that migration is applied, so this stamp is
// really just for the (unlikely) case a row was inserted before the
// column existed. Never thrown: see both callers' comments for why this
// has to be a separate write, not part of the orders insert itself.
async function markOrderUnpaid(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- matching createClient()'s own untyped default (see supabase/server.ts)
  supabase: SupabaseClient<any>,
  orderId: string,
): Promise<void> {
  const { error } = await supabase.from("orders").update({ payment_status: "unpaid" }).eq("id", orderId);
  if (error) {
    console.error("[create-order] Failed to stamp payment_status:", error);
  }
}

/**
 * Best-effort — immediately tries to authorize payment for a just-created
 * order (see authorizePayment in src/lib/payment.ts), so most orders
 * arrive already authorized by the time the customer reaches
 * /orders/[id]. Never allowed to block or fail checkout: authorizePayment
 * itself never throws, but this catch is defense-in-depth regardless.
 * Falls back to whatever markOrderUnpaid already set — payment_status
 * simply stays "unpaid" — if authorization doesn't succeed.
 */
async function tryAuthorizePayment(orderId: string): Promise<void> {
  try {
    const result = await authorizePayment(orderId);
    if (!result.success) {
      console.error("[create-order] authorizePayment did not succeed, order remains unpaid:", result.paymentStatus);
    }
  } catch (error) {
    console.error("[create-order] authorizePayment threw unexpectedly:", error);
  }
}

// Fire-and-forget — nudges the payment-capture retry sweep (see
// src/lib/paymentRetry.ts) to run as a side effect of ordinary checkout
// traffic, so orders whose auto-capture failed still get retried even
// when no admin has opened the fulfillment dashboard in a while (there's
// no cron/background job in this app). Deliberately NOT awaited: this
// order has already fully committed by the time either caller reaches
// this line, and nothing about checkout should ever wait on — or be able
// to fail because of — some *other* order's payment retry. The
// `.catch(...)` only guards against an unhandled promise rejection;
// retryPendingCaptures itself is already written to never throw.
function nudgeCaptureRetrySweep(): void {
  retryPendingCaptures().catch((error) => {
    console.error("[create-order] retryPendingCaptures failed:", error);
  });
}

interface InsertedOrderItem {
  id: string;
  listing_id: string | null;
  price: number | null;
  shipping_cost: number | null;
}

/**
 * Reached when reserveListings' atomic, status-checked UPDATE (see its own
 * doc comment in src/lib/reservations.ts) reports that one or more
 * just-inserted order_items' listings are no longer 'active' — already
 * sold, or flipped to 'unavailable' by the check-listing-status cron, in
 * the moment between fetching them for checkout and reserving them here.
 *
 * Marks each affected order_item 'failed_unavailable' — the exact same
 * terminal state updateOrderItemStatus (src/lib/orderActions.ts) already
 * produces for a LATER-discovered failure — then deducts what those items
 * would have cost from the order's own total_amount *before* payment is
 * ever authorized, so the PaymentIntent createOrder creates right after
 * this only ever holds funds for what's actually still being purchased,
 * rather than authorizing the full original total and leaving an admin to
 * sort out a partial capture later. syncOrderStatus (given the same
 * client) then derives the resulting order status/refunded_amount and
 * powers the existing "item unavailable" customer notification the same
 * way it already does for the admin-triggered version of this state.
 *
 * Uses a service-role client throughout: order_items/orders only grant
 * UPDATE to admins via RLS (see supabase/schema.sql), and this whole path
 * runs on the purchasing customer's own session — same reasoning as
 * releaseExpiredReservations() in src/lib/reservations.ts, this is the
 * system asserting an availability fact, not the customer editing their
 * own order. Best-effort throughout (logged, never thrown): the order
 * itself already committed by the time this runs, and checkout must still
 * be able to proceed with whatever legitimately is still available.
 */
async function failUnavailableOrderItems(
  orderId: string,
  userId: string,
  insertedItems: InsertedOrderItem[],
  unavailableListingIds: string[],
): Promise<void> {
  const unavailableListingIdSet = new Set(unavailableListingIds);
  const unavailableItems = insertedItems.filter(
    (item) => item.listing_id && unavailableListingIdSet.has(item.listing_id),
  );
  if (unavailableItems.length === 0) return;

  const adminSupabase = createAdminClient();
  const unavailableItemIds = unavailableItems.map((item) => item.id);

  const { error: failError } = await adminSupabase
    .from("order_items")
    .update({ status: "failed_unavailable" })
    .in("id", unavailableItemIds)
    .eq("status", "pending_purchase");

  if (failError) {
    console.error("[create-order] Failed to mark unavailable order_items failed_unavailable:", failError);
  }

  const deduction = unavailableItems.reduce(
    (sum, item) => sum + toSafeNumber(item.price) + toSafeNumber(item.shipping_cost),
    0,
  );

  if (deduction > 0) {
    const { data: orderRow, error: fetchError } = await adminSupabase
      .from("orders")
      .select("total_amount")
      .eq("id", orderId)
      .maybeSingle();

    if (fetchError || !orderRow) {
      console.error("[create-order] Failed to fetch order total_amount for adjustment:", fetchError);
    } else {
      const adjustedTotal = Math.max(0, toSafeNumber(orderRow.total_amount) - deduction);
      const { error: totalUpdateError } = await adminSupabase
        .from("orders")
        .update({ total_amount: adjustedTotal })
        .eq("id", orderId);

      if (totalUpdateError) {
        console.error("[create-order] Failed to adjust order total_amount:", totalUpdateError);
      }
    }
  }

  const syncResult = await syncOrderStatus(orderId, adminSupabase);
  if (syncResult.error) {
    console.error("[create-order] syncOrderStatus failed after marking items unavailable:", syncResult.error);
  }

  for (const item of unavailableItems) {
    const { error: notifyError } = await createNotification({
      userId,
      orderId,
      orderItemId: item.id,
      type: "item_failed",
      title: "Item unavailable",
      message: "This item was unavailable. Your refund has been processed.",
    });

    if (notifyError) {
      console.error("[create-order] Failed to create item_failed notification:", notifyError);
    }
  }
}

/**
 * Finds this user's existing active order for each of the given listingIds
 * — an order_item still pending_purchase/securing, on an order that isn't
 * "completed" yet. Two-step (no FK join), same convention as the rest of
 * this codebase: order_items has no user_id column of its own, so "this
 * user's orders" has to be resolved via a separate query against orders
 * first, not a single joined one.
 *
 * Fails open (returns an empty map, logged) if either query errors —
 * a failed duplicate-check shouldn't be able to block checkout outright;
 * worst case, it falls through to creating a new order like before this
 * check existed.
 */
async function findActiveOrdersForListings(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- matching createClient()'s own untyped default (see supabase/server.ts)
  supabase: SupabaseClient<any>,
  userId: string,
  listingIds: string[],
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (listingIds.length === 0) return result;

  const { data: userOrders, error: ordersError } = await supabase
    .from("orders")
    .select("id")
    .eq("user_id", userId)
    .neq("status", "completed");

  if (ordersError) {
    console.error("[create-order] Failed to check for existing active orders:", ordersError);
    return result;
  }

  const orderIds = (userOrders ?? []).map((row) => row.id);
  if (orderIds.length === 0) return result;

  const { data: activeItems, error: itemsError } = await supabase
    .from("order_items")
    .select("order_id, listing_id")
    .in("order_id", orderIds)
    .in("listing_id", listingIds)
    .in("status", ACTIVE_ITEM_STATUSES);

  if (itemsError) {
    console.error("[create-order] Failed to check for existing active order_items:", itemsError);
    return result;
  }

  for (const row of activeItems ?? []) {
    if (row.listing_id && !result.has(row.listing_id)) {
      result.set(row.listing_id, row.order_id);
    }
  }

  return result;
}

/**
 * Converts a user's entire cart_items into a single order + order_items,
 * then clears the cart. Uses the request-scoped server client (not
 * service-role), so Postgres RLS — orders/order_items are scoped to
 * auth.uid() = user_id — is the real enforcement boundary: a userId that
 * doesn't match the actual signed-in session simply fails to insert,
 * regardless of what's passed in here.
 *
 * No charge ever happens here — every order is created straight into
 * "pending_purchase" (see supabase/schema.sql's orders/order_items
 * comment). It does immediately try to *authorize* payment (a hold, via
 * tryAuthorizePayment below) so most orders arrive already authorized;
 * that's best-effort and never blocks checkout if it fails.
 *
 * Listings that already have an active order elsewhere are skipped
 * (never double-ordered) rather than failing checkout — if every cart
 * listing turns out to already be actively ordered, this returns that
 * existing order's id instead of creating an empty one.
 *
 * shippingAddress is optional and purely additive — omitting it (as every
 * pre-/checkout caller still does) behaves exactly as before.
 */
export async function createOrder(
  userId: string,
  shippingAddress?: ShippingAddress | null,
): Promise<string> {
  const supabase = await createClient();

  const { data: cartItems, error: cartError } = await supabase
    .from("cart_items")
    .select("listing_id")
    .eq("user_id", userId);

  if (cartError) {
    console.error("[create-order] Failed to fetch cart_items:", cartError);
    throw new Error("Could not load your cart. Please try again.");
  }

  const listingIds = (cartItems ?? [])
    .map((item) => item.listing_id)
    .filter((id): id is string => Boolean(id));

  if (listingIds.length === 0) {
    throw new Error("Your cart is empty.");
  }

  const activeOrderByListing = await findActiveOrdersForListings(supabase, userId, listingIds);
  const newListingIds = listingIds.filter((id) => !activeOrderByListing.has(id));

  if (newListingIds.length === 0) {
    // Every cart listing is already being tracked by an active order —
    // nothing new to check out. Still clear these out of the cart (they're
    // already accounted for elsewhere) and send the user to one of those
    // existing orders rather than creating an empty one.
    const { error: clearCartError } = await supabase.from("cart_items").delete().eq("user_id", userId);
    if (clearCartError) {
      console.error("[create-order] Failed to clear cart_items:", clearCartError);
    }
    return [...activeOrderByListing.values()][0];
  }

  const { data: listingsData, error: listingsError } = await supabase
    .from("listings")
    .select("id, price, platform, product_url")
    .in("id", newListingIds);

  if (listingsError) {
    console.error("[create-order] Failed to fetch listings:", listingsError);
    throw new Error("Could not load your cart items. Please try again.");
  }

  const listingById = new Map((listingsData ?? []).map((listing) => [listing.id, listing]));

  const orderItems = newListingIds.map((listingId) => {
    // A missing listing (e.g. deleted in the moment between the two reads
    // above) still produces a valid order_item — null-safe platform/
    // product_url, $0 price — rather than failing the whole checkout.
    // listing_id itself must also fall back to null here, not the
    // original id: order_items.listing_id is a real FK, and inserting a
    // value that no longer exists in listings would violate it (ON DELETE
    // SET NULL only rewrites *existing* rows when a listing is deleted —
    // it doesn't let a fresh insert reference an already-gone one).
    const listing = listingById.get(listingId);
    const price = toSafeNumber(listing?.price);
    const shippingCost = 0; // marketplace shipping isn't factored in yet

    return {
      listing_id: listing ? listingId : null,
      platform: listing?.platform ?? null,
      product_url: listing?.product_url ?? null,
      price,
      shipping_cost: shippingCost,
      status: "pending_purchase" as const,
    };
  });

  // Fee applies ONCE to the combined subtotal (see calculateCartTotal),
  // not once per item — the same shared calculation Cart/Checkout use for
  // display, so what the customer saw before placing the order matches
  // what's actually authorized/charged (see tryAuthorizePayment below).
  const shippingTotal = orderItems.reduce((sum, item) => sum + item.shipping_cost, 0);
  const { total: subtotalWithFee } = calculateCartTotal(orderItems);
  const totalAmount = subtotalWithFee + shippingTotal;

  const { data: order, error: orderError } = await supabase
    .from("orders")
    .insert({
      user_id: userId,
      total_amount: toSafeNumber(totalAmount),
      status: "pending_purchase",
      shipping_address: shippingAddress ?? null,
    })
    .select("id")
    .single();

  if (orderError || !order) {
    console.error("[create-order] Failed to create order:", orderError);
    throw new Error("Could not place your order. Please try again.");
  }

  // Separate, best-effort write — deliberately not folded into the insert
  // above. payment_status is new (this task's payment infrastructure) and
  // may not exist on the live DB yet; including it directly in the insert
  // would fail the *entire* order creation the moment that column is
  // missing, which is a far worse outcome than an order that's simply
  // missing its (still-unused) payment_status stamp.
  await markOrderUnpaid(supabase, order.id);

  const { data: insertedItems, error: itemsError } = await supabase
    .from("order_items")
    .insert(orderItems.map((item) => ({ ...item, order_id: order.id })))
    .select("id, listing_id, price, shipping_cost");

  if (itemsError) {
    console.error("[create-order] Failed to create order_items:", itemsError);
    throw new Error("Could not place your order. Please try again.");
  }

  // Best-effort — hold these listings for this order so another customer
  // can't also start buying them while this one's being fulfilled. Also
  // doubles as the atomic checkout-time availability check (see
  // reserveListings' own doc comment in src/lib/reservations.ts): any
  // listing NOT in reservedListingIds already sold or became unavailable
  // in this exact moment, and gets failed out below BEFORE payment is ever
  // authorized, rather than letting checkout charge for an item that's
  // already gone.
  const { reservedListingIds } = await reserveListings(supabase, order.id, newListingIds);
  const reservedListingIdSet = new Set(reservedListingIds);
  const unavailableListingIds = newListingIds.filter((id) => !reservedListingIdSet.has(id));

  if (unavailableListingIds.length > 0) {
    await failUnavailableOrderItems(order.id, userId, insertedItems ?? [], unavailableListingIds);
  }

  // Immediately try to put a payment hold on this order (see
  // tryAuthorizePayment above) — never blocks checkout if it fails. Only
  // reached after the availability check above, so an already-sold
  // listing's order_item (and the order's own total_amount) are already
  // corrected before any authorization attempt.
  await tryAuthorizePayment(order.id);

  // The whole original cart is cleared, not just newListingIds — the
  // skipped (duplicate) ones are already tracked by their existing order,
  // so there's nothing left to do with them in the cart either.
  const { error: clearCartError } = await supabase
    .from("cart_items")
    .delete()
    .eq("user_id", userId);

  if (clearCartError) {
    // The order itself already committed successfully — don't fail
    // checkout over cleanup; just log it so stale cart_items rows are
    // still discoverable.
    console.error("[create-order] Failed to clear cart_items:", clearCartError);
  }

  // Best-effort, same reasoning as the cart-clearing step above — the
  // order itself already committed; a failed notification insert isn't
  // worth failing checkout over.
  const { error: notifyError } = await createNotification({
    userId,
    orderId: order.id,
    type: "order_created",
    title: "Order placed",
    message: "Your order is being secured. We'll confirm availability shortly.",
  });

  if (notifyError) {
    console.error("[create-order] Failed to create order_created notification:", notifyError);
  }

  nudgeCaptureRetrySweep();

  return order.id;
}

/**
 * "Buy Now" on the listing detail page — creates an order for exactly one
 * listing, independent of (and without touching) whatever's currently in
 * the user's cart_items. Same RLS-as-enforcement-boundary reasoning, same
 * "no payment processing, straight into pending_purchase" behavior as
 * createOrder above; deliberately a separate function rather than folded
 * into it, since a single-item purchase and a whole-cart checkout are
 * different actions that shouldn't affect each other's items.
 *
 * If this listing already has an active order (from a previous Buy Now,
 * a double-click, or it's also sitting in the cart and got ordered via
 * Buy All), returns that existing order's id instead of creating a
 * duplicate one.
 *
 * shippingAddress is optional and purely additive — see createOrder's
 * identical note above.
 */
export async function createOrderForListing(
  userId: string,
  listingId: string,
  shippingAddress?: ShippingAddress | null,
): Promise<string> {
  const supabase = await createClient();

  const existingOrderByListing = await findActiveOrdersForListings(supabase, userId, [listingId]);
  const existingOrderId = existingOrderByListing.get(listingId);
  if (existingOrderId) {
    return existingOrderId;
  }

  const { data: listing, error: listingError } = await supabase
    .from("listings")
    .select("id, price, platform, product_url")
    .eq("id", listingId)
    .maybeSingle();

  if (listingError) {
    console.error("[create-order] Failed to fetch listing:", listingError);
    throw new Error("Could not load this listing. Please try again.");
  }

  if (!listing) {
    throw new Error("This listing is no longer available.");
  }

  const price = toSafeNumber(listing.price);
  const shippingCost = 0; // marketplace shipping isn't factored in yet

  // Buy Now is a one-item cart — same shared calculation createOrder()
  // uses, so a single item bought here costs exactly the same as that
  // same item bought via Buy All.
  const { total: subtotalWithFee } = calculateCartTotal([{ price }]);
  const totalAmount = subtotalWithFee + shippingCost;

  const { data: order, error: orderError } = await supabase
    .from("orders")
    .insert({
      user_id: userId,
      total_amount: toSafeNumber(totalAmount),
      status: "pending_purchase",
      shipping_address: shippingAddress ?? null,
    })
    .select("id")
    .single();

  if (orderError || !order) {
    console.error("[create-order] Failed to create order:", orderError);
    throw new Error("Could not place your order. Please try again.");
  }

  // Separate, best-effort write — see createOrder's identical comment
  // above for why this can't be folded into the insert.
  await markOrderUnpaid(supabase, order.id);

  const { data: insertedItem, error: itemError } = await supabase
    .from("order_items")
    .insert({
      order_id: order.id,
      listing_id: listing.id,
      platform: listing.platform,
      product_url: listing.product_url,
      price,
      shipping_cost: shippingCost,
      status: "pending_purchase",
    })
    .select("id, listing_id, price, shipping_cost")
    .single();

  if (itemError) {
    console.error("[create-order] Failed to create order_item:", itemError);
    throw new Error("Could not place your order. Please try again.");
  }

  // Best-effort — hold this listing for this order so another customer
  // can't also start buying it while this one's being fulfilled. Also
  // doubles as the atomic checkout-time availability check — see
  // createOrder's identical comment above.
  const { reservedListingIds } = await reserveListings(supabase, order.id, [listingId]);

  if (!reservedListingIds.includes(listingId) && insertedItem) {
    await failUnavailableOrderItems(order.id, userId, [insertedItem], [listingId]);
  }

  // Immediately try to put a payment hold on this order (see
  // tryAuthorizePayment above) — never blocks checkout if it fails. Only
  // reached after the availability check above — see createOrder's
  // identical comment.
  await tryAuthorizePayment(order.id);

  const { error: notifyError } = await createNotification({
    userId,
    orderId: order.id,
    type: "order_created",
    title: "Order placed",
    message: "Your order is being secured. We'll confirm availability shortly.",
  });

  if (notifyError) {
    console.error("[create-order] Failed to create order_created notification:", notifyError);
  }

  nudgeCaptureRetrySweep();

  return order.id;
}
