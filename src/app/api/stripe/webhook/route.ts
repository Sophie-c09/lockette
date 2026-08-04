// Stripe webhook receiver — the single source of truth for whether an
// order is actually paid. Nothing else in this app (no Server Action, no
// client callback) is ever allowed to write payment_status = "paid" —
// see src/lib/payment.ts's own header comment. Writes through the
// service-role client (src/lib/supabase/admin.ts, already used the same
// way by /api/import-listing) since RLS's "Orders are updatable by
// admin" policy has no concept of "the request came from Stripe."
//
// Explicitly Node.js runtime: needs the raw, unparsed request body for
// signature verification (see stripe.webhooks.constructEvent below), which
// only works against the exact bytes Stripe signed — not a JSON-parsed
// and re-serialized copy.
import type Stripe from "stripe";
import { NextResponse } from "next/server";
import { stripe } from "@/lib/stripe";
import { createAdminClient } from "@/lib/supabase/admin";
import { logStyleFeedback } from "@/lib/style-feedback";

export const runtime = "nodejs";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- matching createAdminClient()'s own untyped default
type AnyAdminClient = ReturnType<typeof createAdminClient<any>>;

interface OrderRow {
  id: string;
  user_id: string | null;
  amount_total_cents: number | null;
  currency: string | null;
}

// Every handler below looks the order up the same way — by the
// PaymentIntent's own metadata.order_id (set at creation time, see
// createOrReusePaymentIntent in src/lib/payment.ts), not by scanning for
// a matching stripe_payment_intent_id. Metadata is what Stripe explicitly
// recommends trusting for this, and it means a webhook event can locate
// its order even if the DB column was somehow never persisted.
async function findOrderForIntent(supabase: AnyAdminClient, intent: Stripe.PaymentIntent): Promise<OrderRow | null> {
  const orderId = intent.metadata?.order_id;
  if (!orderId) {
    console.error(`[stripe-webhook] PaymentIntent ${intent.id} has no metadata.order_id.`);
    return null;
  }

  const { data, error } = await supabase
    .from("orders")
    .select("id, user_id, amount_total_cents, currency")
    .eq("id", orderId)
    .maybeSingle();

  if (error || !data) {
    console.error(`[stripe-webhook] No order found for metadata.order_id ${orderId}.`);
    return null;
  }

  return data;
}

async function handlePaymentIntentSucceeded(supabase: AnyAdminClient, intent: Stripe.PaymentIntent): Promise<void> {
  const order = await findOrderForIntent(supabase, intent);
  if (!order) return;

  // Server-side price authority, enforced one last time here: a
  // PaymentIntent whose amount/currency doesn't match what this order is
  // trusted to cost is never marked paid, no matter what Stripe says
  // succeeded — this is what stops a tampered/stale PaymentIntent (or one
  // whose amount was changed some other way) from ever settling an order
  // for the wrong amount. Mismatches are logged, not silently accepted.
  if (order.amount_total_cents != null && intent.amount !== order.amount_total_cents) {
    console.error(
      `[stripe-webhook] Amount mismatch for order ${order.id}: PaymentIntent ${intent.id} charged ${intent.amount}, order expects ${order.amount_total_cents}. Not marking paid.`,
    );
    return;
  }
  if (order.currency && intent.currency !== order.currency) {
    console.error(
      `[stripe-webhook] Currency mismatch for order ${order.id}: PaymentIntent ${intent.id} is ${intent.currency}, order expects ${order.currency}. Not marking paid.`,
    );
    return;
  }

  const { error } = await supabase
    .from("orders")
    .update({
      payment_status: "paid",
      stripe_payment_intent_id: intent.id,
      paid_at: new Date().toISOString(),
      payment_failure_code: null,
      payment_failure_message: null,
    })
    .eq("id", order.id);

  if (error) {
    console.error(`[stripe-webhook] Failed to mark order ${order.id} paid:`, error.message);
    return;
  }

  // Part 5 of the recommendation-integration architecture — one "purchase"
  // feedback signal per item actually bought, the strongest possible
  // taste signal this app has. Best-effort: logged after the real
  // payment_status update above has already succeeded, never affects
  // this webhook's own 200 response. Only ever reached once per order,
  // since the idempotency guard in POST() below skips a redelivered
  // payment_intent.succeeded event entirely (so this can't double-log).
  if (order.user_id) {
    const { data: items, error: itemsError } = await supabase
      .from("order_items")
      .select("listing_id")
      .eq("order_id", order.id);

    if (itemsError) {
      console.error(`[stripe-webhook] Failed to fetch order_items for feedback logging (order ${order.id}):`, itemsError.message);
    } else {
      for (const item of items ?? []) {
        if (item.listing_id) {
          await logStyleFeedback(order.user_id, item.listing_id, "purchase");
        }
      }
    }
  }
}

async function handlePaymentIntentFailed(supabase: AnyAdminClient, intent: Stripe.PaymentIntent): Promise<void> {
  const order = await findOrderForIntent(supabase, intent);
  if (!order) return;

  // Safe to log: Stripe's decline_code/last_payment_error.message are
  // customer-facing-safe descriptions ("Your card was declined.") — never
  // the card number, CVC, or any raw card data, none of which this app
  // ever receives in the first place (Stripe Elements keeps that entirely
  // off Lockette's servers).
  const failureCode = intent.last_payment_error?.decline_code ?? intent.last_payment_error?.code ?? null;
  const failureMessage = intent.last_payment_error?.message ?? null;

  const { error } = await supabase
    .from("orders")
    .update({
      payment_status: "payment_failed",
      payment_failure_code: failureCode,
      payment_failure_message: failureMessage,
    })
    .eq("id", order.id);

  if (error) {
    console.error(`[stripe-webhook] Failed to mark order ${order.id} payment_failed:`, error.message);
  }
}

async function handlePaymentIntentCanceled(supabase: AnyAdminClient, intent: Stripe.PaymentIntent): Promise<void> {
  const order = await findOrderForIntent(supabase, intent);
  if (!order) return;

  const { error } = await supabase.from("orders").update({ payment_status: "canceled" }).eq("id", order.id);

  if (error) {
    console.error(`[stripe-webhook] Failed to mark order ${order.id} canceled:`, error.message);
  }
}

async function handlePaymentIntentProcessing(supabase: AnyAdminClient, intent: Stripe.PaymentIntent): Promise<void> {
  const order = await findOrderForIntent(supabase, intent);
  if (!order) return;

  const { error } = await supabase.from("orders").update({ payment_status: "processing" }).eq("id", order.id);

  if (error) {
    console.error(`[stripe-webhook] Failed to mark order ${order.id} processing:`, error.message);
  }
}

// Refunds: charge.refunded fires on the Charge object, which carries the
// PaymentIntent id but not its metadata directly — retrieving the
// PaymentIntent itself (one extra, cheap API call) is what lets this
// reuse the exact same metadata.order_id lookup every other handler uses,
// rather than a second, parallel "find by stripe_payment_intent_id"
// query path.
async function handleChargeRefunded(supabase: AnyAdminClient, charge: Stripe.Charge): Promise<void> {
  const paymentIntentId = typeof charge.payment_intent === "string" ? charge.payment_intent : charge.payment_intent?.id;
  if (!paymentIntentId) {
    console.error("[stripe-webhook] charge.refunded event has no payment_intent id.");
    return;
  }

  let intent: Stripe.PaymentIntent;
  try {
    intent = await stripe.paymentIntents.retrieve(paymentIntentId);
  } catch (error) {
    console.error(`[stripe-webhook] Failed to retrieve PaymentIntent ${paymentIntentId} for refund event:`, error);
    return;
  }

  const order = await findOrderForIntent(supabase, intent);
  if (!order) return;

  const { error } = await supabase
    .from("orders")
    .update({ payment_status: "refunded", refunded_at: new Date().toISOString() })
    .eq("id", order.id);

  if (error) {
    console.error(`[stripe-webhook] Failed to mark order ${order.id} refunded:`, error.message);
  }
}

// Idempotency — Stripe explicitly documents that the same event can be
// delivered more than once (network retries, manual redelivery from the
// dashboard). Recording each processed event.id first, and bailing out if
// it's already there, is what stops a redelivered payment_intent.succeeded
// from re-running the purchase-feedback loop or re-stamping paid_at, and
// stops any handler from ever running twice for the same event. The
// insert's own unique-violation (23505) IS the concurrency guard — no
// separate lock needed, since Postgres itself rejects a second insert of
// the same primary key even under a genuinely simultaneous redelivery.
async function alreadyProcessed(supabase: AnyAdminClient, event: Stripe.Event): Promise<boolean> {
  const { error } = await supabase.from("stripe_webhook_events").insert({ id: event.id, type: event.type });

  if (!error) return false;
  if (error.code === "23505") return true;

  // Any other error (table missing, connection issue) fails OPEN — the
  // event is treated as not-yet-processed rather than silently dropped,
  // since the alternative (skipping a genuine payment_intent.succeeded
  // because the idempotency table had a hiccup) is worse than a rare
  // double-processing that the handlers' own guards (amount/currency
  // check, order lookup) still substantially protect against.
  console.error("[stripe-webhook] Failed to record processed event id, proceeding anyway:", error.message);
  return false;
}

export async function POST(request: Request) {
  const signature = request.headers.get("stripe-signature");
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!signature || !webhookSecret) {
    console.error("[stripe-webhook] Missing stripe-signature header or STRIPE_WEBHOOK_SECRET.");
    return NextResponse.json({ error: "Webhook not configured." }, { status: 400 });
  }

  const rawBody = await request.text();

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
  } catch (error) {
    console.error("[stripe-webhook] Signature verification failed:", error);
    return NextResponse.json({ error: "Invalid signature." }, { status: 400 });
  }

  const supabase = createAdminClient();

  if (await alreadyProcessed(supabase, event)) {
    return NextResponse.json({ received: true, duplicate: true }, { status: 200 });
  }

  // Best-effort from here on — Stripe already got a verified event; a
  // downstream DB hiccup is logged, never thrown, and never turned into a
  // non-2xx (which would just make Stripe retry the same event later —
  // harmless given alreadyProcessed above, but not useful either, since a
  // logged DB error isn't something a retry alone will fix).
  try {
    switch (event.type) {
      case "payment_intent.succeeded":
        await handlePaymentIntentSucceeded(supabase, event.data.object as Stripe.PaymentIntent);
        break;
      case "payment_intent.payment_failed":
        await handlePaymentIntentFailed(supabase, event.data.object as Stripe.PaymentIntent);
        break;
      case "payment_intent.canceled":
        await handlePaymentIntentCanceled(supabase, event.data.object as Stripe.PaymentIntent);
        break;
      case "payment_intent.processing":
        await handlePaymentIntentProcessing(supabase, event.data.object as Stripe.PaymentIntent);
        break;
      case "charge.refunded":
        await handleChargeRefunded(supabase, event.data.object as Stripe.Charge);
        break;
      default:
        // Unhandled event types are expected and fine — Stripe's account-
        // wide webhook endpoint can be subscribed to more events than this
        // route cares about; anything not listed above is a deliberate
        // no-op, not an oversight.
        break;
    }
  } catch (error) {
    console.error(`[stripe-webhook] Failed to process event ${event.id} (${event.type}):`, error);
  }

  return NextResponse.json({ received: true }, { status: 200 });
}
