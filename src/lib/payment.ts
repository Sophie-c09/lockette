"use server";

// Real Stripe payment system. Replaces the old fake flow, which called
// stripe.paymentIntents.create() with no payment_method ever attached
// (PaymentForm.tsx was a fully disabled placeholder) and then blindly
// stamped payment_status = "authorized" regardless of what Stripe actually
// returned — every order was marked "Payment secured" without a real card
// ever being charged.
//
// Standard automatic-capture PaymentIntents (Stripe's default — no
// capture_method override): the customer is genuinely charged the moment
// they confirm payment with the Payment Element, not on some later
// admin-triggered "capture" step. The old manual-capture/authorize-then-
// capture-later architecture never actually worked (no card was ever
// attached, so nothing was ever really authorized) — see
// src/lib/orderLifecycle.ts and the deleted src/lib/paymentRetry.ts for
// what it used to do. Order-level FULFILLMENT tracking (order_items'
// pending_purchase/securing/purchased/failed_unavailable states, and
// orders.status's own pending_purchase/processing/completed lifecycle —
// both untouched, unrelated systems) is completely separate from payment
// and is not affected by this file at all.
//
// The Stripe webhook (src/app/api/stripe/webhook/route.ts) is the ONLY
// writer of payment_status = "paid"/"payment_failed"/"canceled"/
// "refunded" — every function below either creates/updates a PaymentIntent
// (which only ever leaves it at "pending"/"awaiting_payment") or issues an
// admin-triggered refund request (which leaves the actual "refunded"
// stamp to the webhook's own charge.refunded handling). No function here,
// and no client code anywhere, can mark an order paid.
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { isCurrentUserAdmin } from "@/lib/admin";
import { stripe, requireStripeConfigured } from "@/lib/stripe";
import { calculateCartTotal } from "@/lib/pricing";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- matching createClient()'s own untyped default (see supabase/server.ts)
type AnySupabase = SupabaseClient<any>;

function toSafeNumber(value: unknown): number {
  const num = Number(value ?? 0);
  return Number.isFinite(num) ? num : 0;
}

function toCents(dollars: number): number {
  return Math.round(dollars * 100);
}

export interface OrderAmount {
  amountSubtotalCents: number;
  serviceFeeCents: number;
  shippingCents: number;
  amountTotalCents: number;
  currency: string;
}

// The server-side price authority this whole system depends on: never
// trusts a client-submitted total, always recomputes from this order's
// OWN order_items rows, using the exact same fee calculation
// (calculateCartTotal) Cart/Checkout already display to the customer, so
// what Stripe charges can never drift from what was shown. Items already
// marked "failed_unavailable" (sold out before Lockette could secure them
// — a fulfillment-side outcome, unrelated to payment) are excluded: a
// customer should never pay for something that was never actually
// available. Returns null for an order with nothing payable (empty order,
// or every item already failed) — every caller below treats that as a
// hard stop, never a $0 charge.
async function computeTrustedOrderAmount(supabase: AnySupabase, orderId: string): Promise<OrderAmount | null> {
  const { data: items, error } = await supabase
    .from("order_items")
    .select("price, shipping_cost, status")
    .eq("order_id", orderId);

  if (error) {
    console.error("[payment] Failed to fetch order_items for pricing:", error);
    return null;
  }

  const payableItems = (items ?? []).filter((item) => item.status !== "failed_unavailable");
  if (payableItems.length === 0) return null;

  const { subtotal, fee, total } = calculateCartTotal(payableItems.map((item) => ({ price: toSafeNumber(item.price) })));
  const shippingDollars = payableItems.reduce((sum, item) => sum + toSafeNumber(item.shipping_cost), 0);

  return {
    amountSubtotalCents: toCents(subtotal),
    serviceFeeCents: toCents(fee),
    shippingCents: toCents(shippingDollars),
    amountTotalCents: toCents(total + shippingDollars),
    currency: "usd",
  };
}

// Statuses under which an order is not yet paid and not in a terminal
// failure/cancellation state — the only states a PaymentIntent may
// legitimately be created or reused for.
const PAYABLE_STATUSES = new Set(["unpaid", "pending", "awaiting_payment", "processing", "payment_failed"]);
const PAID_STATUSES = new Set(["authorized", "captured", "paid"]);

export type PaymentIntentResult =
  | {
      clientSecret: string;
      amountSubtotalCents: number;
      serviceFeeCents: number;
      shippingCents: number;
      amountTotalCents: number;
      currency: string;
    }
  | { error: string };

/**
 * The protected server action Task 1 calls for: verifies the
 * authenticated user, verifies ownership, recomputes the trusted amount
 * from the database, and creates (or reuses/updates) exactly ONE
 * PaymentIntent for this order. Safe to call repeatedly — a duplicate
 * click, a page refresh mid-checkout, or a re-render never creates a
 * second PaymentIntent; it retrieves the existing one and only updates
 * its amount if the trusted total has actually changed since it was
 * created (e.g. an item was marked unavailable in the interim), so the
 * amount the customer is about to confirm on the Payment Element is
 * always the current, correct one — never a stale cached total.
 *
 * Returns only a client secret and safe display data (never the raw
 * PaymentIntent, never anything from Stripe that isn't needed to render
 * the payment form) — matches this file's "never trust/leak more than
 * necessary" posture throughout.
 */
export async function createOrReusePaymentIntent(orderId: string): Promise<PaymentIntentResult> {
  try {
    requireStripeConfigured();
  } catch (error) {
    console.error("[payment] Stripe not configured:", error);
    return { error: "Payments are temporarily unavailable. Please try again shortly." };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { error: "Sign in to continue." };
  }

  const { data: order, error: orderError } = await supabase
    .from("orders")
    .select("id, user_id, payment_status, stripe_payment_intent_id")
    .eq("id", orderId)
    .maybeSingle();

  if (orderError || !order) {
    return { error: "This order could not be found." };
  }

  // Ownership only — no admin bypass. Paying for an order is the
  // customer's own action; an admin never has legitimate reason to pay on
  // someone else's behalf.
  if (order.user_id !== user.id) {
    return { error: "This order could not be found." };
  }

  if (PAID_STATUSES.has(order.payment_status) || order.payment_status === "refunded") {
    return { error: "This order has already been paid." };
  }

  if (!PAYABLE_STATUSES.has(order.payment_status)) {
    return { error: "This order can no longer be paid." };
  }

  const amount = await computeTrustedOrderAmount(supabase, orderId);
  if (!amount || amount.amountTotalCents <= 0) {
    return { error: "This order has no items available to pay for." };
  }

  let clientSecret: string | null = null;

  if (order.stripe_payment_intent_id) {
    // Reuse — prevents a duplicate PaymentIntent on a repeated click,
    // page refresh, or re-render. Only ever updates the amount (never
    // creates a second intent) if the trusted total actually changed.
    try {
      const existing = await stripe.paymentIntents.retrieve(order.stripe_payment_intent_id);

      if (existing.status === "succeeded" || existing.status === "canceled") {
        // The PaymentIntent itself has already moved on (e.g. the webhook
        // for a success/cancellation hasn't been reflected in this row
        // yet, or Stripe canceled it independently) — fall through to
        // create a fresh one rather than handing back a client secret
        // that can never be confirmed again.
      } else {
        if (existing.amount !== amount.amountTotalCents || existing.currency !== amount.currency) {
          const updated = await stripe.paymentIntents.update(order.stripe_payment_intent_id, {
            amount: amount.amountTotalCents,
            currency: amount.currency,
            metadata: { order_id: orderId, user_id: user.id },
          });
          clientSecret = updated.client_secret;
        } else {
          clientSecret = existing.client_secret;
        }
      }
    } catch (error) {
      console.error("[payment] Failed to retrieve/update existing PaymentIntent, creating a new one:", error);
    }
  }

  if (!clientSecret) {
    try {
      const intent = await stripe.paymentIntents.create(
        {
          amount: amount.amountTotalCents,
          currency: amount.currency,
          metadata: { order_id: orderId, user_id: user.id },
          automatic_payment_methods: { enabled: true },
        },
        // Idempotency key tied to the order — a genuinely simultaneous
        // double-submit (e.g. a double-click before React state disables
        // the button) that races past the stripe_payment_intent_id reuse
        // check above still can't create two PaymentIntents for the same
        // order; Stripe itself collapses concurrent requests with the
        // same key into one.
        { idempotencyKey: `order-${orderId}-create-payment-intent` },
      );
      clientSecret = intent.client_secret;

      const { error: updateError } = await supabase
        .from("orders")
        .update({ stripe_payment_intent_id: intent.id })
        .eq("id", orderId);

      if (updateError) {
        console.error("[payment] Failed to persist stripe_payment_intent_id:", updateError);
      }
    } catch (error) {
      console.error("[payment] Stripe PaymentIntent creation failed:", error);
      return { error: "We couldn't start payment for this order. Please try again." };
    }
  }

  if (!clientSecret) {
    return { error: "We couldn't start payment for this order. Please try again." };
  }

  // awaiting_payment is purely informational (lets the admin dashboard and
  // any future customer-facing order list show "waiting on the customer"
  // rather than a bare "unpaid"/"pending") — the webhook, never this
  // function, is what ever moves payment_status to "paid".
  if (order.payment_status === "unpaid" || order.payment_status === "pending") {
    const { error: statusError } = await supabase
      .from("orders")
      .update({
        payment_status: "awaiting_payment",
        amount_subtotal_cents: amount.amountSubtotalCents,
        service_fee_cents: amount.serviceFeeCents,
        shipping_cents: amount.shippingCents,
        amount_total_cents: amount.amountTotalCents,
        currency: amount.currency,
      })
      .eq("id", orderId);

    if (statusError) {
      console.error("[payment] Failed to stamp awaiting_payment state:", statusError);
    }
  } else {
    // Re-fetched/updated amount on a repeat call — keep the stored
    // breakdown in sync even when payment_status itself doesn't change.
    const { error: amountError } = await supabase
      .from("orders")
      .update({
        amount_subtotal_cents: amount.amountSubtotalCents,
        service_fee_cents: amount.serviceFeeCents,
        shipping_cents: amount.shippingCents,
        amount_total_cents: amount.amountTotalCents,
        currency: amount.currency,
      })
      .eq("id", orderId);

    if (amountError) {
      console.error("[payment] Failed to refresh stored amount breakdown:", amountError);
    }
  }

  return {
    clientSecret,
    amountSubtotalCents: amount.amountSubtotalCents,
    serviceFeeCents: amount.serviceFeeCents,
    shippingCents: amount.shippingCents,
    amountTotalCents: amount.amountTotalCents,
    currency: amount.currency,
  };
}

export interface PaymentResult {
  success: boolean;
  paymentStatus: string;
}

/**
 * Admin-only. Issues a Stripe refund request against the order's
 * PaymentIntent. Deliberately does NOT write payment_status = "refunded"
 * itself — the webhook's charge.refunded handling is the single source of
 * truth for that transition (src/app/api/stripe/webhook/route.ts), same
 * "Stripe confirms, then the DB reflects it" principle as payment success
 * itself. A { success: true } here means Stripe accepted the refund
 * request, not that the DB has caught up yet.
 *
 * No admin UI calls this yet (see this feature's own report — refunds can
 * be initiated directly in the Stripe Dashboard in the meantime); kept
 * here, correct and ready, for whenever a refund action is added.
 */
export async function refundPayment(orderId: string): Promise<PaymentResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user || !(await isCurrentUserAdmin(supabase, user.id))) {
    return { success: false, paymentStatus: "unpaid" };
  }

  try {
    requireStripeConfigured();
  } catch (error) {
    console.error("[payment] Stripe not configured:", error);
    return { success: false, paymentStatus: "failed" };
  }

  const { data: order, error: orderError } = await supabase
    .from("orders")
    .select("payment_status, stripe_payment_intent_id")
    .eq("id", orderId)
    .maybeSingle();

  if (orderError || !order) {
    return { success: false, paymentStatus: "unpaid" };
  }

  if (!order.stripe_payment_intent_id || !PAID_STATUSES.has(order.payment_status)) {
    return { success: false, paymentStatus: order.payment_status };
  }

  try {
    await stripe.refunds.create({ payment_intent: order.stripe_payment_intent_id });
  } catch (error) {
    console.error("[payment] Stripe refund failed:", error);
    return { success: false, paymentStatus: "failed" };
  }

  return { success: true, paymentStatus: order.payment_status };
}
