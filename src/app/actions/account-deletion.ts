"use server";

// In-app account deletion — required for App Store submission (Apple
// guideline 5.1.1(v)). Server-only: never accepts a client-submitted user
// id, always derives the account to delete from the current server-side
// session (see deleteAccount below) — a user can only ever delete their
// own account, whether they signed up with email/password or Google (the
// deletion flow itself never asks for a password, so a Google-only user
// — who has none — is never blocked).
//
// Deletion order (deliberate, matches this feature's own report):
//   1. authenticate user (server-side session, never a client-passed id)
//   2. classify this user's orders: paid/refunded ones are RETAINED
//      (anonymized), everything else is deleted outright
//   3. anonymize retained orders (user_id -> null; see the
//      2026-08-02 "add_orders_retention_support" migration for why this
//      doesn't cascade-delete them once the auth user is gone)
//   4. delete unpaid/never-charged orders (order_items cascade from
//      their own order_id FK, unaffected by the change above)
//   5. delete this user's uploaded files from every private storage
//      bucket (avatars, style-request-images, outfit-photos,
//      style-me-images, discover-search-photos)
//   6. delete the Supabase Auth user via the admin API LAST — this
//      cascades profiles and everything that references it (style_
//      profiles, saved_items, disliked_items, user_style_feedback,
//      cart_items, style_requests -> styled_bundles -> styled_bundle_
//      items, style_me_requests -> style_me_bundles -> style_me_bundle_
//      items, notifications) automatically via existing FK constraints,
//      plus outfit_recreations (its own direct auth.users FK). No new
//      column/migration was needed for any of these — they already
//      cascade correctly; only orders needed a schema change, since it's
//      the one table that must NOT vanish along with the account.
//   7. sign out / clear the session
//
// No Stripe Customer objects exist anywhere in this app (see
// src/lib/payment.ts — PaymentIntents are created without one, guest-
// checkout style), so there is nothing to delete/detach on Stripe's side;
// see this feature's own report for that decision.
//
// Idempotent by construction, not by a special-cased check: every step
// operates on "whatever this user still has left" — a retried call after
// a partial failure just finds fewer (or zero) rows/files remaining and
// no-ops through those steps harmlessly, rather than erroring on
// something already gone.
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

const RETAINED_PAYMENT_STATUSES = new Set(["authorized", "captured", "paid", "refunded"]);

const USER_STORAGE_BUCKETS = [
  "avatars",
  "style-request-images",
  "outfit-photos",
  "style-me-images",
  "discover-search-photos",
];

export interface DeleteAccountResult {
  success: boolean;
  error?: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- matching createAdminClient()'s own untyped default
type AnyAdminClient = ReturnType<typeof createAdminClient<any>>;

// Recursively removes every file under `prefix` in `bucket` — Supabase
// Storage's list() only returns one level at a time, and a "folder"
// (rather than a real file) comes back as an entry with id: null (its
// own documented convention, since folders aren't real objects) — this
// walks into those instead of trying to remove them as files. The
// starting prefix is always exactly this authenticated user's own id
// (never anything client-supplied), so this can structurally never
// reach another user's files; already-empty/missing prefixes just
// return zero entries and no-op.
async function deleteAllUnderPrefix(admin: AnyAdminClient, bucket: string, prefix: string, correlationId: string): Promise<void> {
  const { data: entries, error } = await admin.storage.from(bucket).list(prefix, { limit: 1000 });

  if (error) {
    console.error(`[account-deletion:${correlationId}] Failed to list ${bucket}/${prefix}:`, error.message);
    return;
  }
  if (!entries || entries.length === 0) return;

  const filePaths: string[] = [];
  for (const entry of entries) {
    if (entry.id === null) {
      await deleteAllUnderPrefix(admin, bucket, `${prefix}/${entry.name}`, correlationId);
    } else {
      filePaths.push(`${prefix}/${entry.name}`);
    }
  }

  if (filePaths.length > 0) {
    const { error: removeError } = await admin.storage.from(bucket).remove(filePaths);
    if (removeError) {
      console.error(`[account-deletion:${correlationId}] Failed to remove files under ${bucket}/${prefix}:`, removeError.message);
    }
  }
}

/**
 * Deletes the current user's account and all associated data (except the
 * minimum transactional record retention law/dispute handling requires —
 * see this file's own header comment). Requires the user to have typed
 * "DELETE" client-side first (src/components/profile/DeleteAccountSection.tsx)
 * — deliberate confirmation, not a password re-entry, so this works
 * identically for email/password and Google-authenticated users.
 */
export async function deleteAccount(confirmation: string): Promise<DeleteAccountResult> {
  if (confirmation !== "DELETE") {
    return { success: false, error: "Please type DELETE to confirm." };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { success: false, error: "You must be signed in to delete your account." };
  }

  const userId = user.id;
  // Correlation id only — never anything about the user themselves —
  // logged alongside every step below so a failure can be traced across
  // log lines without exposing (or needing) sensitive detail.
  const correlationId = `del_${userId.slice(0, 8)}_${Math.random().toString(36).slice(2, 8)}`;
  const admin = createAdminClient();

  try {
    const { data: orders, error: ordersError } = await admin
      .from("orders")
      .select("id, payment_status")
      .eq("user_id", userId);

    if (ordersError) {
      console.error(`[account-deletion:${correlationId}] Failed to fetch orders:`, ordersError.message);
      return { success: false, error: "Something went wrong. Please try again." };
    }

    const retainedOrderIds = (orders ?? [])
      .filter((order) => RETAINED_PAYMENT_STATUSES.has(order.payment_status))
      .map((order) => order.id);
    const deletableOrderIds = (orders ?? [])
      .filter((order) => !RETAINED_PAYMENT_STATUSES.has(order.payment_status))
      .map((order) => order.id);

    // Retained orders keep their amounts, statuses, Stripe identifiers,
    // and shipping address (legitimate dispute/chargeback/fraud-
    // prevention evidence) — only the link back to this identity is
    // severed. Style preferences, likes, and uploaded photos are never
    // part of an order row at all, so there's nothing of that kind to
    // strip here.
    if (retainedOrderIds.length > 0) {
      const { error } = await admin.from("orders").update({ user_id: null }).in("id", retainedOrderIds);
      if (error) {
        console.error(`[account-deletion:${correlationId}] Failed to anonymize retained orders:`, error.message);
        return { success: false, error: "Something went wrong. Please try again." };
      }
    }

    // Never charged (or charge failed/canceled) — nothing to retain.
    // order_items cascade from their own order_id FK (untouched by the
    // retention migration, which only changed orders.user_id).
    if (deletableOrderIds.length > 0) {
      const { error } = await admin.from("orders").delete().in("id", deletableOrderIds);
      if (error) {
        console.error(`[account-deletion:${correlationId}] Failed to delete unpaid orders:`, error.message);
        return { success: false, error: "Something went wrong. Please try again." };
      }
    }

    for (const bucket of USER_STORAGE_BUCKETS) {
      await deleteAllUnderPrefix(admin, bucket, userId, correlationId);
    }

    // Last — cascades everything else (see this file's own header
    // comment for the full list). Not-found here (e.g. a retried call
    // after the user row was already deleted) is treated as success, not
    // a failure — the end state ("this auth user no longer exists") is
    // exactly what was asked for either way.
    const { error: deleteUserError } = await admin.auth.admin.deleteUser(userId);
    if (deleteUserError && !/not.*found/i.test(deleteUserError.message)) {
      console.error(`[account-deletion:${correlationId}] Failed to delete auth user:`, deleteUserError.message);
      return { success: false, error: "Something went wrong. Please try again." };
    }
  } catch (error) {
    console.error(`[account-deletion:${correlationId}] Unexpected error:`, error);
    return { success: false, error: "Something went wrong. Please try again." };
  }

  // Best-effort — the auth user is already gone at this point either
  // way; this just clears the now-invalid session cookie from this
  // response so a stale cookie can't linger client-side.
  await supabase.auth.signOut();

  return { success: true };
}
