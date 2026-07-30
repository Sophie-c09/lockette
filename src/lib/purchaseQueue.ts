"use server";

// Read-only data layer for /admin/purchase-queue — a dedicated, single-item
// -at-a-time speed workflow, separate from the full order-table dashboard
// at /admin/orders (untouched by this file). Reuses the exact same urgency/
// match-percent helpers that dashboard already uses (calculateUrgencyScore,
// buildMatchPercentLookup/computeMatchPercentForListing) rather than
// inventing a second notion of either.
import { createClient } from "@/lib/supabase/server";
import { isCurrentUserAdmin } from "@/lib/admin";
import { calculateUrgencyScore } from "@/lib/urgency-scoring";
import { buildMatchPercentLookup, computeMatchPercentForListing } from "@/lib/order-match-percent";

function toSafeNumber(value: unknown): number {
  const num = Number(value ?? 0);
  return Number.isFinite(num) ? num : 0;
}

const UNRESOLVED_STATUSES = ["pending_purchase", "securing"];

export interface PurchaseQueueItem {
  id: string;
  orderId: string;
  orderCreatedAt: string;
  listingId: string | null;
  title: string | null;
  brand: string | null;
  size: string | null;
  imageUrl: string | null;
  platform: string | null;
  productUrl: string | null;
  price: number;
  status: "pending_purchase" | "securing";
  matchPercent: number | null;
  urgencyScore: number;
  urgencyLabel: string;
  openedAt: string | null;
  // Non-null only while this order (not some other one) still holds the
  // listing's reservation — same convention as AdminOrdersView's
  // FulfillmentItem.reservationExpiresAt.
  reservationExpiresAt: string | null;
}

// Spec order: soonest-expiring reservation first (no reservation sorts
// last), then highest urgency score, then oldest order as the final
// tie-break.
function sortQueueItems(items: PurchaseQueueItem[]): PurchaseQueueItem[] {
  return [...items].sort((a, b) => {
    const aExpiry = a.reservationExpiresAt ? new Date(a.reservationExpiresAt).getTime() : null;
    const bExpiry = b.reservationExpiresAt ? new Date(b.reservationExpiresAt).getTime() : null;

    if (aExpiry != null && bExpiry != null && aExpiry !== bExpiry) return aExpiry - bExpiry;
    if (aExpiry != null && bExpiry == null) return -1;
    if (aExpiry == null && bExpiry != null) return 1;

    if (a.urgencyScore !== b.urgencyScore) return b.urgencyScore - a.urgencyScore;

    return new Date(a.orderCreatedAt).getTime() - new Date(b.orderCreatedAt).getTime();
  });
}

/**
 * Fetches every unresolved order_item (pending_purchase/securing) across
 * every order, enriched with its listing, match %, urgency, and reservation
 * countdown, sorted per spec. Called both by the page's initial server
 * render and, directly from the client, by PurchaseQueueView's polling
 * refresh — same "use server" function either way, no separate API route.
 */
export async function getPurchaseQueueItems(): Promise<{ items: PurchaseQueueItem[]; error?: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user || !(await isCurrentUserAdmin(supabase, user.id))) {
    return { items: [], error: "Not authorized." };
  }

  // opened_at (this task's purchase-timer column) may not exist on the
  // live DB yet — selecting a missing column fails the *entire* query,
  // which would otherwise hide the whole queue. Same try-then-fallback
  // convention as admin/orders/page.tsx.
  let itemsData: {
    id: string;
    order_id: string;
    listing_id: string | null;
    platform: string | null;
    product_url: string | null;
    price: number | string | null;
    status: string;
    opened_at: string | null;
  }[] = [];

  {
    const { data, error } = await supabase
      .from("order_items")
      .select("id, order_id, listing_id, platform, product_url, price, status, opened_at")
      .in("status", UNRESOLVED_STATUSES);

    if (error) {
      console.error("[purchase-queue] Falling back without opened_at:", error);
      const fallback = await supabase
        .from("order_items")
        .select("id, order_id, listing_id, platform, product_url, price, status")
        .in("status", UNRESOLVED_STATUSES);

      if (fallback.error) {
        console.error("[purchase-queue-error]", fallback.error);
        return { items: [], error: fallback.error.message };
      }

      itemsData = (fallback.data ?? []).map((item) => ({ ...item, opened_at: null }));
    } else {
      itemsData = data ?? [];
    }
  }

  if (itemsData.length === 0) return { items: [] };

  const orderIds = [...new Set(itemsData.map((item) => item.order_id))];
  const { data: ordersData, error: ordersError } = await supabase
    .from("orders")
    .select("id, user_id, created_at")
    .in("id", orderIds);

  if (ordersError) {
    console.error("[purchase-queue-error] Failed to fetch orders:", ordersError);
  }

  const orderById = new Map((ordersData ?? []).map((order) => [order.id, order]));

  // Two-step fetch, no FK join — same convention as admin/orders/page.tsx.
  const listingIds = [
    ...new Set(itemsData.map((item) => item.listing_id).filter((id): id is string => Boolean(id))),
  ];

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
    // reserved_by_order_id/reservation_expires_at may not exist on the live
    // DB yet — same fallback pattern as admin/orders/page.tsx.
    const { data, error } = await supabase
      .from("listings")
      .select("id, image_url, brand, title, size, aesthetic_tags, reserved_by_order_id, reservation_expires_at")
      .in("id", listingIds);

    let listingsData = data;

    if (error) {
      console.error("[purchase-queue] Falling back without reservation columns:", error);
      const fallback = await supabase
        .from("listings")
        .select("id, image_url, brand, title, size, aesthetic_tags")
        .in("id", listingIds);

      if (fallback.error) {
        console.error("[purchase-queue-error]", fallback.error);
      }

      listingsData = (fallback.data ?? []).map((listing) => ({
        ...listing,
        reserved_by_order_id: null,
        reservation_expires_at: null,
      }));
    }

    listingById = new Map((listingsData ?? []).map((listing) => [listing.id, listing]));
  }

  // Best-effort match percentage — reuses match-scoring.ts (unmodified) via
  // order-match-percent.ts, batched by the distinct users who placed these
  // orders, same as admin/orders/page.tsx.
  const matchProfiles = await buildMatchPercentLookup([...orderById.values()].map((order) => order.user_id));

  const items: PurchaseQueueItem[] = itemsData.map((item) => {
    const order = orderById.get(item.order_id);
    const listing = item.listing_id ? listingById.get(item.listing_id) : undefined;
    const profile = order ? matchProfiles.get(order.user_id) : undefined;

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

    return {
      id: item.id,
      orderId: item.order_id,
      orderCreatedAt: order?.created_at ?? new Date(0).toISOString(),
      listingId: item.listing_id,
      title: listing?.title ?? null,
      brand: listing?.brand ?? null,
      size: listing?.size ?? null,
      imageUrl: listing?.image_url ?? null,
      platform: item.platform,
      productUrl: item.product_url,
      price,
      status: item.status as "pending_purchase" | "securing",
      matchPercent,
      urgencyScore: urgency.score,
      urgencyLabel: urgency.label,
      openedAt: item.opened_at,
      reservationExpiresAt:
        listing?.reserved_by_order_id === item.order_id ? listing.reservation_expires_at : null,
    };
  });

  return { items: sortQueueItems(items) };
}
