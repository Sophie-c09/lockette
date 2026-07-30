// Style Me's status is a scripted reveal-pacing device, not a real
// fulfillment timeline — this app has no real shipping/delivery concept
// anywhere (orders/order_items stop at "we finished sourcing," see
// supabase/schema.sql's own comment on this feature). Status auto-
// advances on read rather than via a new cron job, mirroring this
// codebase's own established "no cron/background job in this app, so
// this is the opportunistic substitute" idiom (releaseExpiredReservations,
// called opportunistically from /feed's own page load).
import { createAdminClient } from "@/lib/supabase/admin";

export type StyleMeStatus = "pending" | "in_progress" | "shipped" | "delivered";

// Explicit, documented, arbitrary pacing for the reveal experience — not
// derived from any real fulfillment timing, since nothing's actually
// being shipped. Tune freely.
const IN_PROGRESS_AFTER_MS = 30_000; // 30s
const SHIPPED_AFTER_MS = 3 * 60_000; // 3 min
const DELIVERED_AFTER_MS = 8 * 60_000; // 8 min

const STAGE_ORDER: StyleMeStatus[] = ["pending", "in_progress", "shipped", "delivered"];

/** Pure function of elapsed time since submission — never regresses. */
export function computeStyleMeStatus(createdAt: string): StyleMeStatus {
  const elapsedMs = Date.now() - new Date(createdAt).getTime();

  if (elapsedMs >= DELIVERED_AFTER_MS) return "delivered";
  if (elapsedMs >= SHIPPED_AFTER_MS) return "shipped";
  if (elapsedMs >= IN_PROGRESS_AFTER_MS) return "in_progress";
  return "pending";
}

function stageIndex(status: StyleMeStatus): number {
  return STAGE_ORDER.indexOf(status);
}

/**
 * If the computed stage has moved past what's stored, persists the
 * advance (via the service-role client — this table has no end-user
 * update policy, same admin/service-role-only convention as
 * style_requests) and returns the new status; otherwise returns the
 * stored status unchanged. Called opportunistically from every read
 * (getStyleMeRequest/getMyStyleMeRequests), never a lone cron job.
 */
export async function advanceStatusIfDue(
  requestId: string,
  storedStatus: StyleMeStatus,
  createdAt: string,
): Promise<StyleMeStatus> {
  const computed = computeStyleMeStatus(createdAt);

  if (stageIndex(computed) <= stageIndex(storedStatus)) {
    return storedStatus;
  }

  const adminSupabase = createAdminClient();
  const { error } = await adminSupabase
    .from("style_me_requests")
    .update({ status: computed })
    .eq("id", requestId);

  if (error) {
    console.error("[style-me-status] Failed to advance status:", error);
    return storedStatus;
  }

  return computed;
}
