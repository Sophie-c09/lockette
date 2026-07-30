"use server";

import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isCurrentUserAdmin } from "@/lib/admin";

// How long a listing stays held for a specific order before it's treated
// as available again — see supabase/schema.sql's listings.reservation_*
// columns.
const RESERVATION_DURATION_MS = 15 * 60 * 1000;

/**
 * Reserves the given listings for `orderId` — called by createOrder.ts
 * right after its order_items commit successfully, and BEFORE payment is
 * authorized (see createOrder.ts). Best-effort (logged, never thrown): a
 * failed reservation shouldn't be able to fail the checkout that already
 * committed. Not exported as a standalone action — only createOrder.ts
 * calls this, always with an order it just created.
 *
 * The UPDATE is scoped to `status = 'active'` and reports back exactly
 * which ids it actually touched (`.select("id")`) — this is what makes it
 * the atomic checkout-time availability check: Postgres's own row-level
 * locking on this single UPDATE...WHERE means a listing that's already
 * sold/unavailable (or gets flipped by a concurrent buyer or the
 * check-listing-status cron job at the same moment) simply won't appear
 * in reservedListingIds, with no separate locking primitive needed.
 * createOrder.ts uses the gap between what was requested and what's
 * returned here to fail those specific order_items as
 * "failed_unavailable" rather than letting checkout proceed to charge for
 * an item that's actually gone.
 *
 * status may not exist on the live DB yet (see supabase/schema.sql) —
 * falls back to the pre-status UPDATE (reserving everything requested,
 * same as before this feature) rather than silently reserving nothing.
 */
export async function reserveListings(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- matching createClient()'s own untyped default (see supabase/server.ts)
  supabase: SupabaseClient<any>,
  orderId: string,
  listingIds: string[],
): Promise<{ reservedListingIds: string[] }> {
  if (listingIds.length === 0) return { reservedListingIds: [] };

  const now = new Date();
  const expiresAt = new Date(now.getTime() + RESERVATION_DURATION_MS);

  const update = {
    reserved_by_order_id: orderId,
    reserved_at: now.toISOString(),
    reservation_expires_at: expiresAt.toISOString(),
  };

  const statusChecked = await supabase
    .from("listings")
    .update(update)
    .in("id", listingIds)
    .eq("status", "active")
    .select("id");

  if (statusChecked.error) {
    console.error(
      "[reservations] status-checked reservation failed, falling back to unchecked reservation:",
      statusChecked.error,
    );
    const fallback = await supabase.from("listings").update(update).in("id", listingIds).select("id");

    if (fallback.error) {
      console.error("[reservations] Failed to reserve listings:", fallback.error);
      return { reservedListingIds: [] };
    }

    return { reservedListingIds: (fallback.data ?? []).map((row) => row.id) };
  }

  return { reservedListingIds: (statusChecked.data ?? []).map((row) => row.id) };
}

/**
 * Builds the `.or(...)` filter string PostgREST expects, for excluding
 * reserved-and-not-yet-expired listings from a browsing query (Discover/
 * Feed/Match) — except listings reserved by the CURRENT user's own
 * (not-yet-completed) order, who should still see their own in-progress
 * purchase. Fails open (no extra "it's mine too" clause) if the "my
 * orders" lookup errors — worst case a signed-in user's own reservation
 * is hidden from themselves too, which is safe, just not ideal, and never
 * blocks anyone else's browsing.
 */
export async function buildAvailabilityFilter(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- matching createClient()'s own untyped default (see supabase/server.ts)
  supabase: SupabaseClient<any>,
  userId: string | null,
): Promise<string> {
  const nowIso = new Date().toISOString();
  const conditions = ["reserved_by_order_id.is.null", `reservation_expires_at.lte.${nowIso}`];

  if (userId) {
    const { data: myOrders, error } = await supabase
      .from("orders")
      .select("id")
      .eq("user_id", userId)
      .neq("status", "completed");

    if (error) {
      console.error("[reservations] Failed to fetch user's own active orders:", error);
    } else {
      const myOrderIds = (myOrders ?? []).map((row) => row.id);
      if (myOrderIds.length > 0) {
        conditions.push(`reserved_by_order_id.in.(${myOrderIds.join(",")})`);
      }
    }
  }

  return conditions.join(",");
}

/**
 * True when a listing is currently held for someone else's order — the
 * exact rule spec section "AVAILABILITY RULE" describes, plus the
 * "except the reservation's own owner" carve-out for the listing detail
 * page (Discover/Feed/Match instead filter this out of their queries
 * entirely via buildAvailabilityFilter above).
 */
export async function isReservedByAnotherUser(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- matching createClient()'s own untyped default (see supabase/server.ts)
  supabase: SupabaseClient<any>,
  listing: { reserved_by_order_id: string | null; reservation_expires_at: string | null },
  currentUserId: string | null,
): Promise<boolean> {
  if (!listing.reserved_by_order_id || !listing.reservation_expires_at) return false;
  if (new Date(listing.reservation_expires_at).getTime() <= Date.now()) return false;

  if (!currentUserId) return true;

  const { data: order, error } = await supabase
    .from("orders")
    .select("user_id")
    .eq("id", listing.reserved_by_order_id)
    .maybeSingle();

  if (error) {
    console.error("[reservations] Failed to check reservation owner:", error);
    return true;
  }

  return order?.user_id !== currentUserId;
}

/**
 * Sweeps every listing whose reservation has expired and clears it —
 * called opportunistically at the top of Discover/Feed/Match/admin
 * fulfillment page loads (there's no cron/background job in this app),
 * so stale reservations don't linger and incorrectly hide listings.
 * Best-effort: a failed sweep just means expired reservations clear a
 * little later, on the next successful call.
 *
 * SAFETY — why this must use createAdminClient() (service-role) and NOT
 * the cookie/session-scoped createClient(): this runs on public pages
 * (Discover/Feed/Match, and the listing detail page) that don't require a
 * signed-in session, so the caller is frequently a genuinely anonymous
 * visitor. `listings` only grants public SELECT (see supabase/schema.sql
 * and src/lib/supabase/admin.ts's own comment) — anonymous requests have
 * no UPDATE grant on it at all, so under the session client, RLS silently
 * blocked every one of these updates (0 rows affected, no thrown error),
 * meaning expired reservations never actually cleared and kept
 * incorrectly hiding listings. The service-role client bypasses RLS
 * entirely, exactly like the Stripe webhook and /api/import-listing
 * already do for their own no-user-session writes.
 *
 * Never throws: createAdminClient() itself can throw synchronously (e.g.
 * SUPABASE_SERVICE_ROLE_KEY unset) and the query can reject — both are
 * caught below and turned into a plain returned error rather than an
 * unhandled rejection reaching Discover/Feed/Match's page render.
 */
export async function releaseExpiredReservations(): Promise<{ success: true } | { error: string }> {
  try {
    const supabase = createAdminClient();

    const { error } = await supabase
      .from("listings")
      .update({ reserved_by_order_id: null, reserved_at: null, reservation_expires_at: null })
      .not("reserved_by_order_id", "is", null)
      .lte("reservation_expires_at", new Date().toISOString())
      .select("id");

    if (error) {
      console.error("[release-expired-reservations-error]", {
        message: error?.message,
        code: error?.code,
        details: error?.details,
        hint: error?.hint,
      });
      return { error: error.message };
    }

    return { success: true };
  } catch (error) {
    const err = error as { message?: string; code?: string; details?: string; hint?: string } | undefined;
    console.error("[release-expired-reservations-error]", {
      message: err?.message,
      code: err?.code,
      details: err?.details,
      hint: err?.hint,
    });
    return { error: err?.message ?? "Failed to release expired reservations." };
  }
}

/**
 * Admin-only "Extend Reservation" action — pushes reservation_expires_at
 * another 15 minutes out from now (not from the original expiry), giving
 * the admin a fresh full window rather than stacking durations.
 */
export async function extendReservation(listingId: string): Promise<{ error?: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user || !(await isCurrentUserAdmin(supabase, user.id))) {
    return { error: "Not authorized." };
  }

  const nextExpiry = new Date(Date.now() + RESERVATION_DURATION_MS).toISOString();

  const { error } = await supabase
    .from("listings")
    .update({ reservation_expires_at: nextExpiry })
    .eq("id", listingId);

  if (error) {
    console.error("[extend-reservation-error]", error);
    return { error: error.message };
  }

  return {};
}
