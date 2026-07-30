import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { calculateUrgencyScore } from "@/lib/urgency-scoring";
import { buildMatchPercentLookup, computeMatchPercentForListing } from "@/lib/order-match-percent";
import { retryPendingCaptures } from "@/lib/paymentRetry";
import { AdminOrdersView, type FulfillmentOrder, type FulfillmentItem } from "@/components/admin/AdminOrdersView";

// Internal tool — same "not linked from anywhere in the app's nav" posture
// as /admin/import, gated by src/app/admin/layout.tsx (simple email
// allowlist, see src/lib/admin.ts) rather than a real role system for now.
export const metadata: Metadata = {
  title: "Fulfillment — Lockette admin",
};

function toSafeNumber(value: unknown): number {
  const num = Number(value ?? 0);
  return Number.isFinite(num) ? num : 0;
}

export default async function AdminOrdersPage() {
  const supabase = await createClient();

  // Best-effort — retries any order whose automatic capture (see
  // syncOrderStatus in src/lib/orderLifecycle.ts) previously failed. No
  // cron/background job in this app, so this dashboard's own page load is
  // the opportunistic substitute (same pattern as releaseExpiredReservations
  // being swept on Discover/Feed/Match page loads).
  const retryResult = await retryPendingCaptures();
  if (retryResult.error) {
    console.error("[admin-orders-page] retryPendingCaptures failed:", retryResult.error);
  }

  // processing_started_at/opened_at/purchased_at (this task's new time-
  // tracking columns) may not exist on the live DB yet — selecting a
  // missing column fails the *entire* query, which would otherwise hide
  // every order. Falls back to the reduced column list so the dashboard's
  // core functionality (list, urgency, buy actions) works either way; only
  // the speed analytics themselves degrade to "not available" until the
  // migration lands.
  let orders: {
    id: string;
    user_id: string;
    status: string;
    total_amount: number | string | null;
    refunded_amount: number | string | null;
    processing_started_at: string | null;
    payment_status: string | null;
    created_at: string;
  }[] = [];

  {
    const { data, error } = await supabase
      .from("orders")
      .select(
        "id, user_id, status, total_amount, refunded_amount, processing_started_at, payment_status, created_at",
      )
      .order("created_at", { ascending: false });

    if (error) {
      console.error("[admin-orders-query-error] Falling back without processing_started_at/payment_status:", error);
      const fallback = await supabase
        .from("orders")
        .select("id, user_id, status, total_amount, refunded_amount, created_at")
        .order("created_at", { ascending: false });

      if (fallback.error) {
        console.error("[admin-orders-query-error]", fallback.error);
      }

      orders = (fallback.data ?? []).map((order) => ({
        ...order,
        processing_started_at: null,
        payment_status: "unpaid",
      }));
    } else {
      orders = data ?? [];
    }
  }

  const orderIds = orders.map((order) => order.id);

  let orderItemsData: {
    id: string;
    order_id: string;
    listing_id: string | null;
    platform: string | null;
    product_url: string | null;
    price: number | string | null;
    shipping_cost: number | string | null;
    status: string;
    opened_at: string | null;
    purchased_at: string | null;
  }[] = [];

  if (orderIds.length > 0) {
    const { data, error } = await supabase
      .from("order_items")
      .select(
        "id, order_id, listing_id, platform, product_url, price, shipping_cost, status, opened_at, purchased_at",
      )
      .in("order_id", orderIds)
      .order("created_at", { ascending: true });

    if (error) {
      console.error("[admin-orders-query-error] Falling back without opened_at/purchased_at:", error);
      const fallback = await supabase
        .from("order_items")
        .select("id, order_id, listing_id, platform, product_url, price, shipping_cost, status")
        .in("order_id", orderIds)
        .order("created_at", { ascending: true });

      if (fallback.error) {
        console.error("[admin-orders-query-error]", fallback.error);
      }

      orderItemsData = (fallback.data ?? []).map((item) => ({ ...item, opened_at: null, purchased_at: null }));
    } else {
      orderItemsData = data ?? [];
    }
  }

  // Two-step fetch, no FK join — same convention as /likes and /cart.
  const listingIds = [...new Set(orderItemsData.map((item) => item.listing_id).filter((id): id is string => Boolean(id)))];

  let listingById = new Map<
    string,
    {
      image_url: string | null;
      brand: string | null;
      title: string;
      size: string | null;
      aesthetic_tags: string[];
      reserved_by_order_id: string | null;
      reservation_expires_at: string | null;
    }
  >();

  if (listingIds.length > 0) {
    // reserved_by_order_id/reservation_expires_at (this task's new
    // columns) may not exist on the live DB yet — same fallback pattern
    // as processing_started_at/opened_at/purchased_at above.
    const { data, error } = await supabase
      .from("listings")
      .select("id, image_url, brand, title, size, aesthetic_tags, reserved_by_order_id, reservation_expires_at")
      .in("id", listingIds);

    let listingsData = data;

    if (error) {
      console.error("[admin-orders-query-error] Falling back without reservation columns:", error);
      const fallback = await supabase
        .from("listings")
        .select("id, image_url, brand, title, size, aesthetic_tags")
        .in("id", listingIds);

      if (fallback.error) {
        console.error("[admin-orders-query-error]", fallback.error);
      }

      listingsData = (fallback.data ?? []).map((listing) => ({
        ...listing,
        reserved_by_order_id: null,
        reservation_expires_at: null,
      }));
    }

    listingById = new Map((listingsData ?? []).map((listing) => [listing.id, listing]));
  }

  // Best-effort match percentage — reuses match-scoring.ts (unmodified),
  // batched by the distinct users who placed these orders.
  const matchProfiles = await buildMatchPercentLookup(orders.map((order) => order.user_id));
  const orderUserById = new Map(orders.map((order) => [order.id, order.user_id]));

  const itemsByOrderId = new Map<string, FulfillmentItem[]>();
  for (const item of orderItemsData) {
    const listing = item.listing_id ? listingById.get(item.listing_id) : undefined;
    const userId = orderUserById.get(item.order_id);
    const profile = userId ? matchProfiles.get(userId) : undefined;

    const matchPercent = listing
      ? computeMatchPercentForListing(profile, {
          aesthetic_tags: listing.aesthetic_tags ?? [],
          brand: listing.brand,
          category: null,
          color: null,
          size: listing.size,
        })
      : null;

    const price = toSafeNumber(item.price);
    const urgency = calculateUrgencyScore({
      price,
      aestheticTags: listing?.aesthetic_tags ?? [],
      matchPercent,
    });

    const fulfillmentItem: FulfillmentItem = {
      id: item.id,
      orderId: item.order_id,
      listingId: item.listing_id,
      platform: item.platform,
      productUrl: item.product_url,
      price,
      shippingCost: toSafeNumber(item.shipping_cost),
      status: item.status as FulfillmentItem["status"],
      openedAt: item.opened_at,
      purchasedAt: item.purchased_at,
      imageUrl: listing?.image_url ?? null,
      brand: listing?.brand ?? null,
      title: listing?.title ?? null,
      size: listing?.size ?? null,
      matchPercent,
      urgencyScore: urgency.score,
      urgencyLabel: urgency.label,
      // Only meaningful when the reservation on this listing actually
      // belongs to *this* order — a listing can only ever be reserved by
      // one order at a time, so any other value means it's someone
      // else's (already-superseded, from this order's own point of view)
      // reservation.
      reservationExpiresAt:
        listing?.reserved_by_order_id === item.order_id ? listing.reservation_expires_at : null,
    };

    const list = itemsByOrderId.get(item.order_id) ?? [];
    list.push(fulfillmentItem);
    itemsByOrderId.set(item.order_id, list);
  }

  const fulfillmentOrders: FulfillmentOrder[] = orders.map((order) => ({
    id: order.id,
    status: order.status as FulfillmentOrder["status"],
    totalAmount: toSafeNumber(order.total_amount),
    refundedAmount: toSafeNumber(order.refunded_amount),
    processingStartedAt: order.processing_started_at,
    paymentStatus: (order.payment_status ?? "unpaid") as FulfillmentOrder["paymentStatus"],
    createdAt: order.created_at,
    items: itemsByOrderId.get(order.id) ?? [],
  }));

  return <AdminOrdersView orders={fulfillmentOrders} />;
}
