"use server";

import { createClient } from "@/lib/supabase/server";

export type NotificationType =
  | "order_created"
  | "item_secured"
  | "item_failed"
  | "order_completed"
  | "style_request_completed";

export interface Notification {
  id: string;
  order_id: string | null;
  order_item_id: string | null;
  type: NotificationType;
  title: string;
  message: string;
  read: boolean;
  created_at: string;
}

export interface CreateNotificationInput {
  userId: string;
  type: NotificationType;
  title: string;
  message: string;
  orderId?: string | null;
  orderItemId?: string | null;
}

/**
 * Inserts one notification row. Called from createOrder.ts (on behalf of
 * the customer's own session) and orderActions.ts (on behalf of an admin
 * acting on someone else's order) — never directly from a client
 * component. Deliberately swallows its own errors into a returned
 * `{error}` rather than throwing: a failed notification should never take
 * down the checkout/fulfillment action that triggered it.
 *
 * Columns match the live `notifications` table exactly (id, user_id,
 * order_id, order_item_id, type, title, message, read, created_at) — no
 * `style_request_id` column exists there, so a 'style_request_completed'
 * notification is just a plain row like any other; NotificationBell.tsx
 * routes the click by `type` instead of by a stored request id.
 */
export async function createNotification(input: CreateNotificationInput): Promise<{ error?: string }> {
  const supabase = await createClient();

  const { error } = await supabase.from("notifications").insert({
    user_id: input.userId,
    order_id: input.orderId ?? null,
    order_item_id: input.orderItemId ?? null,
    type: input.type,
    title: input.title,
    message: input.message,
  });

  if (error) {
    console.error("[create-notification-error]", error);
    return { error: error.message };
  }

  return {};
}

/**
 * Marks one of the current user's own notifications read. Scoped to
 * `user_id = auth.uid()` both here and via RLS (which additionally only
 * grants UPDATE on the `read` column — see supabase/schema.sql) — a
 * notification_id that doesn't belong to the caller simply matches zero
 * rows rather than erroring.
 */
export async function markNotificationRead(notificationId: string): Promise<{ error?: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { error: "Not signed in." };
  }

  const { error } = await supabase
    .from("notifications")
    .update({ read: true })
    .eq("id", notificationId)
    .eq("user_id", user.id);

  if (error) {
    console.error("[mark-notification-read-error]", error);
    return { error: error.message };
  }

  return {};
}

// PostgrestError's own fields (message/details/hint/code) are what actually
// carry the diagnostic info — logging the raw object can print as `{}` in
// some console/runtime setups (e.g. its properties round-tripping through a
// non-enumerable-dropping serializer), which is exactly what made this
// failure impossible to diagnose. Pulling the fields out explicitly means
// there's always a real message on the console, whatever shape `error`
// turns out to be (a genuine PostgrestError, a plain thrown Error, or
// something else entirely).
function describeSupabaseError(error: unknown): string {
  if (error && typeof error === "object") {
    const { message, code, details, hint } = error as {
      message?: string;
      code?: string;
      details?: string | null;
      hint?: string | null;
    };
    const parts = [
      code && `code=${code}`,
      message && `message=${message}`,
      details && `details=${details}`,
      hint && `hint=${hint}`,
    ].filter(Boolean);
    if (parts.length > 0) return parts.join(" ");
  }
  return String(error);
}

// Every real caller (the navbar's initial SSR render, NotificationBell's
// 30s poll, and its on-open refresh) always needs the recent-notifications
// list and the unread count together — this used to be two separate
// functions, each running its own auth.getUser() + notifications query, so
// every call site paid for two round trips instead of one. Must never
// throw, since Nav.tsx/layout.tsx don't wrap this call in a try/catch and
// an uncaught rejection here would take down the whole page, not just the
// bell icon — the try/catch below is the real backstop. Column list
// matches the live `notifications` table exactly (see createNotification's
// own comment above) — no style_request_id fallback needed since that
// column is never selected in the first place.
export async function getNotificationsWithUnreadCount(
  limit = 20,
): Promise<{ notifications: Notification[]; unreadCount: number }> {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) return { notifications: [], unreadCount: 0 };

    const [{ data, error }, { count, error: countError }] = await Promise.all([
      supabase
        .from("notifications")
        .select("id, order_id, order_item_id, type, title, message, read, created_at")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false })
        .limit(limit),
      supabase
        .from("notifications")
        .select("id", { count: "exact", head: true })
        .eq("user_id", user.id)
        .eq("read", false),
    ]);

    if (error) {
      console.error("[get-recent-notifications-error]", describeSupabaseError(error));
    }
    if (countError) {
      console.error("[get-unread-notification-count-error]", describeSupabaseError(countError));
    }

    return { notifications: data ?? [], unreadCount: count ?? 0 };
  } catch (err) {
    console.error("[get-notifications-with-unread-count-error]", describeSupabaseError(err));
    return { notifications: [], unreadCount: 0 };
  }
}
