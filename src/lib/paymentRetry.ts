"use server";

// Opportunistic retry sweep for orders whose automatic capture (see
// syncOrderStatus in src/lib/orderLifecycle.ts) failed. There's no cron/
// background-job infrastructure anywhere in this app — same situation as
// releaseExpiredReservations in src/lib/reservations.ts — so this is meant
// to be called opportunistically, from *any* frequently-hit code path, not
// on a schedule. It's called both from /admin/orders' own page load and
// from createOrder.ts/createOrderForListing.ts (fire-and-forget, right
// after every checkout) — checkout traffic is far more frequent than an
// admin opening the fulfillment dashboard, so this is what actually makes
// retries happen "even with zero admin activity."
//
// Uses the service-role client (createAdminClient, same one the Stripe
// webhook route already uses) rather than the cookie-scoped one: a
// customer's own session can only ever see their own orders under RLS
// ("Orders are viewable by their owner or public.is_admin()" — see
// supabase/schema.sql), so finding *every* order due for a retry — not
// just whichever customer happens to trigger this — requires bypassing
// that. Captures now go through capturePaymentInternal (src/lib/
// payment.ts) directly, rather than the cookie/session-gated
// capturePayment — this is what lets a capture triggered by ordinary
// checkout traffic actually succeed with zero admin session present,
// instead of only ever keeping the order queued until an admin happens to
// check. Admin-level security is preserved because this whole module runs
// server-side only, never reachable directly from a request the way a
// Server Action a browser calls is: nothing here is exposed to, or
// triggerable by, a client with an arbitrary orderId the way the old
// capturePayment(orderId) signature would be.
import { createAdminClient } from "@/lib/supabase/admin";
import { capturePaymentInternal } from "@/lib/payment";
import { scheduleCaptureRetry } from "@/lib/orderLifecycle";

export interface RetryPendingCapturesResult {
  attempted: number;
  succeeded: number;
  error?: string;
}

/**
 * Finds orders that are fully "completed" but still only "authorized"
 * (their automatic capture never succeeded) and due for a retry, then
 * re-attempts a capture for each via capturePaymentInternal.
 *
 * Safety — all via existing guards, nothing new to duplicate here:
 * - Never retries an already-"captured"/"refunded"/"failed" order: the
 *   payment_status = "authorized" filter below excludes them outright.
 * - Never retries out from under a payment_status that changed between
 *   this query and the attempt: capturePaymentInternal re-checks the
 *   payment_status it's handed immediately before capturing, and no-ops
 *   if it isn't "authorized".
 * - Never throws: every attempt is individually wrapped, so one order's
 *   failure can't stop the sweep from trying the rest, and a failure here
 *   can't propagate to whatever page/action called this (including a
 *   fire-and-forget checkout call site that never even awaits the
 *   result).
 */
export async function retryPendingCaptures(): Promise<RetryPendingCapturesResult> {
  const supabase = createAdminClient();
  const nowIso = new Date().toISOString();

  // capture_retry_at may not exist on the live DB yet — falls back to
  // every "completed" + "authorized" order (no due-time filter) rather
  // than failing the sweep outright; capturePaymentInternal's own guard is
  // still the real safety net either way.
  let candidates: { id: string; payment_status: string; payment_provider_id: string | null }[] = [];
  {
    const { data, error } = await supabase
      .from("orders")
      .select("id, payment_status, payment_provider_id")
      .eq("status", "completed")
      .eq("payment_status", "authorized")
      .or(`capture_retry_at.is.null,capture_retry_at.lte.${nowIso}`);

    if (error) {
      console.error("[payment-retry] Falling back without capture_retry_at filter:", error);
      const fallback = await supabase
        .from("orders")
        .select("id, payment_status, payment_provider_id")
        .eq("status", "completed")
        .eq("payment_status", "authorized");

      if (fallback.error) {
        console.error("[payment-retry-error]", fallback.error);
        return { attempted: 0, succeeded: 0, error: fallback.error.message };
      }

      candidates = fallback.data ?? [];
    } else {
      candidates = data ?? [];
    }
  }

  let succeeded = 0;
  for (const order of candidates) {
    try {
      const result = await capturePaymentInternal(supabase, {
        id: order.id,
        paymentStatus: order.payment_status,
        paymentProviderId: order.payment_provider_id,
      });
      if (result.success) {
        succeeded += 1;
      } else {
        // Push the next attempt further out (exponential backoff — see
        // scheduleCaptureRetry) rather than leaving it due immediately
        // again, which would otherwise let every future sweep re-attempt
        // (and likely re-fail against) the same still-broken order.
        console.error(`[payment-retry] capture did not succeed for order ${order.id}:`, result.paymentStatus);
        await scheduleCaptureRetry(supabase, order.id);
      }
    } catch (error) {
      console.error(`[payment-retry] capture threw unexpectedly for order ${order.id}:`, error);
      await scheduleCaptureRetry(supabase, order.id);
    }
  }

  return { attempted: candidates.length, succeeded };
}
