"use server";

// Payment service layer. Stripe is now genuinely wired in (manual-capture
// PaymentIntents) behind the exact same public interface this file always
// had — authorizePayment/capturePayment/refundPayment still take just an
// orderId and return { success, paymentStatus }, so nothing that calls
// these (admin UI, future integrations) needs to change. capturePayment's
// actual Stripe-plus-DB logic also lives behind capturePaymentInternal, a
// second, trusted-caller-only entry point with no cookie/session
// dependency — see its own doc comment for why (src/lib/paymentRetry.ts
// needs to capture payments with no user session available at all).
//
// Every Stripe call is wrapped in try/catch: this file must NEVER throw —
// a Stripe outage or a bad/missing STRIPE_SECRET_KEY degrades to
// { success: false, paymentStatus: "failed" }, never an unhandled
// rejection. createOrder.ts calls authorizePayment immediately after every
// order it creates (best-effort, itself wrapped in a try/catch there too)
// so most orders arrive already authorized — a Stripe failure there just
// leaves the order's payment_status at "unpaid" instead of blocking
// checkout. capturePayment/refundPayment are the separate, later steps an
// admin triggers (or, for capture, the retry sweep triggers automatically
// via capturePaymentInternal).
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { isCurrentUserAdmin } from "@/lib/admin";
import { stripe } from "@/lib/stripe";

export type PaymentStatus = "unpaid" | "authorized" | "captured" | "failed" | "refunded";

export interface PaymentResult {
  success: boolean;
  paymentStatus: string;
}

function toSafeNumber(value: unknown): number {
  const num = Number(value ?? 0);
  return Number.isFinite(num) ? num : 0;
}

// capturePayment/refundPayment are admin-gated (see spec's SECURITY
// section: only admins can move money further once a hold exists).
// authorizePayment has its own, more permissive check below — it's the
// one payment action a customer's own checkout session legitimately
// triggers itself.
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

// Reads just enough of an order to drive the Stripe call — never throws;
// a missing/misconfigured payment_status/payment_provider_id column (this
// infrastructure not having been migrated onto the live DB yet) surfaces
// as `null` here, same as an order that simply doesn't exist, so every
// caller's existing "fail softly if not found" branch already covers it
// without needing a separate fallback query shape.
async function fetchOrderPaymentState(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- matching createClient()'s own untyped default (see supabase/server.ts)
  supabase: SupabaseClient<any>,
  orderId: string,
): Promise<{ userId: string; paymentStatus: string; paymentProviderId: string | null; totalAmount: number } | null> {
  const { data, error } = await supabase
    .from("orders")
    .select("user_id, payment_status, payment_provider_id, total_amount")
    .eq("id", orderId)
    .maybeSingle();

  if (error || !data) {
    console.error("[payment] Failed to fetch order:", error);
    return null;
  }

  return {
    userId: data.user_id,
    paymentStatus: data.payment_status ?? "unpaid",
    paymentProviderId: data.payment_provider_id ?? null,
    totalAmount: toSafeNumber(data.total_amount),
  };
}

/**
 * Creates a manual-capture Stripe PaymentIntent for this order and stamps
 * orders.payment_status = "authorized" (plus payment_provider_id/
 * payment_authorized_at). No-op (not an error) if the order isn't
 * currently "unpaid" — never creates a second PaymentIntent for an order
 * that already has one.
 *
 * Unlike capturePayment/refundPayment (admin-only), this one also allows
 * the order's own owner — createOrder.ts calls this immediately after
 * checkout, on behalf of the customer who just placed the order, not an
 * admin. Creating an authorization hold is the customer's own action
 * (equivalent to entering their card at checkout); only moving money
 * further — capturing or refunding it — is restricted to admins.
 */
export async function authorizePayment(orderId: string): Promise<PaymentResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return { success: false, paymentStatus: "unpaid" };

  const order = await fetchOrderPaymentState(supabase, orderId);
  if (!order) return { success: false, paymentStatus: "unpaid" };

  if (!(await isCurrentUserAdmin(supabase, user.id)) && user.id !== order.userId) {
    return { success: false, paymentStatus: "unpaid" };
  }

  if (order.paymentStatus !== "unpaid") {
    return { success: order.paymentStatus === "authorized", paymentStatus: order.paymentStatus };
  }

  let intentId: string;
  try {
    const intent = await stripe.paymentIntents.create({
      amount: Math.round(order.totalAmount * 100),
      currency: "usd",
      capture_method: "manual",
      metadata: { orderId },
    });
    intentId = intent.id;
  } catch (error) {
    console.error("[payment] Stripe PaymentIntent creation failed:", error);
    return { success: false, paymentStatus: "failed" };
  }

  const { error: updateError } = await supabase
    .from("orders")
    .update({
      payment_status: "authorized",
      payment_provider_id: intentId,
      payment_authorized_at: new Date().toISOString(),
    })
    .eq("id", orderId);

  if (updateError) {
    console.error("[payment] Failed to persist authorized payment state:", updateError);
    return { success: false, paymentStatus: "failed" };
  }

  return { success: true, paymentStatus: "authorized" };
}

export interface CapturablePaymentOrder {
  id: string;
  paymentStatus: string;
  paymentProviderId: string | null;
}

/**
 * The actual Stripe-capture core of capturePayment — no cookie/session
 * read, no requireAdmin() call of its own. NOT part of this file's public
 * interface: it exists only so a trusted, already-server-side caller that
 * has no user session to check against (see retryPendingCaptures in
 * src/lib/paymentRetry.ts, which runs the checkout-triggered retry sweep
 * via the service-role client) can still perform a real capture, without
 * reintroducing a cookie dependency or duplicating the Stripe call in a
 * second place. The only other caller is capturePayment below, which
 * still fully gates access via requireAdmin() before ever reaching this
 * function — this function itself trusts whoever calls it to have already
 * done that.
 *
 * Deliberately does NOT write payment_status = "captured" itself.
 * Stripe's payment_intent.succeeded webhook (src/app/api/stripe/webhook/
 * route.ts) is the single source of truth for that transition — this
 * function's job ends the moment Stripe accepts the capture request;
 * payment_status stays "authorized" until the webhook confirms it
 * asynchronously. That also means a caller seeing { success: true } here
 * only means "Stripe accepted the capture," not "the DB already reflects
 * it" — by design, so there's never a window where the DB claims
 * "captured" before Stripe has actually said so.
 *
 * The `supabase` parameter is kept (unused in the body) rather than
 * dropped, to avoid changing this function's signature now that it no
 * longer needs to write anything — every caller (capturePayment,
 * retryPendingCaptures) still passes one in unchanged.
 *
 * Reuses the exact same guard capturePayment always had: no-ops (returns
 * success: false, not an error) unless payment_status is exactly
 * "authorized" and a payment_provider_id exists — so this can never
 * attempt to capture an order twice, or one that was never authorized,
 * regardless of who calls it or how many times. On top of that,
 * capturing the same PaymentIntent a second time (e.g. a retry that fires
 * before the webhook has caught up — see src/lib/paymentRetry.ts) is
 * itself rejected by Stripe, not by anything in this file — Stripe is the
 * actual enforcement against a double capture.
 */
export async function capturePaymentInternal(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- matching createClient()'s own untyped default (see supabase/server.ts)
  supabase: SupabaseClient<any>,
  order: CapturablePaymentOrder,
): Promise<PaymentResult> {
  if (order.paymentStatus !== "authorized" || !order.paymentProviderId) {
    return { success: false, paymentStatus: order.paymentStatus };
  }

  try {
    await stripe.paymentIntents.capture(order.paymentProviderId);
  } catch (error) {
    console.error("[payment] Stripe PaymentIntent capture failed:", error);
    return { success: false, paymentStatus: "failed" };
  }

  return { success: true, paymentStatus: "authorized" };
}

/**
 * Requests a capture of the order's existing PaymentIntent from Stripe.
 * Admin-only. Fails (not an error, just success: false) if the order
 * isn't currently "authorized" or has no payment_provider_id to capture —
 * a real payment gateway can't capture funds that were never authorized
 * either (see capturePaymentInternal, which actually enforces this).
 *
 * A successful { success: true } result means Stripe accepted the
 * capture request, not that payment_status has already moved to
 * "captured" — see capturePaymentInternal's doc comment for why that
 * transition now only ever happens via the Stripe webhook.
 */
export async function capturePayment(orderId: string): Promise<PaymentResult> {
  const authCheck = await requireAdmin();
  if (authCheck.error) return { success: false, paymentStatus: "unpaid" };

  const supabase = await createClient();

  const order = await fetchOrderPaymentState(supabase, orderId);
  if (!order) return { success: false, paymentStatus: "unpaid" };

  return capturePaymentInternal(supabase, {
    id: orderId,
    paymentStatus: order.paymentStatus,
    paymentProviderId: order.paymentProviderId,
  });
}

/**
 * Issues a Stripe refund against the order's PaymentIntent, moving it to
 * "refunded". Admin-only. Fails softly if there's no payment_provider_id
 * to refund, or if the order was never authorized/captured in the first
 * place (an "unpaid" or already-"refunded" order has nothing to refund).
 */
export async function refundPayment(orderId: string): Promise<PaymentResult> {
  const authCheck = await requireAdmin();
  if (authCheck.error) return { success: false, paymentStatus: "unpaid" };

  const supabase = await createClient();

  const order = await fetchOrderPaymentState(supabase, orderId);
  if (!order) return { success: false, paymentStatus: "unpaid" };

  if (!order.paymentProviderId || (order.paymentStatus !== "authorized" && order.paymentStatus !== "captured")) {
    return { success: false, paymentStatus: order.paymentStatus };
  }

  try {
    await stripe.refunds.create({ payment_intent: order.paymentProviderId });
  } catch (error) {
    console.error("[payment] Stripe refund failed:", error);
    return { success: false, paymentStatus: "failed" };
  }

  const { error: updateError } = await supabase
    .from("orders")
    .update({ payment_status: "refunded" })
    .eq("id", orderId);

  if (updateError) {
    console.error("[payment] Failed to persist refunded payment state:", updateError);
    return { success: false, paymentStatus: "failed" };
  }

  return { success: true, paymentStatus: "refunded" };
}
