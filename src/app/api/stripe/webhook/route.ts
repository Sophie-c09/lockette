// Stripe webhook receiver — the only entry point that updates
// orders.payment_status *without* an admin session (Stripe calls this
// directly, server-to-server, with no cookies at all). Verifies Stripe's
// own signature instead, then writes through the service-role client
// (src/lib/supabase/admin.ts, already used the same way by
// /api/import-listing) since RLS's "Orders are updatable by admin" policy
// has no concept of "the request came from Stripe."
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

  // Best-effort from here on — Stripe already got a verified event; a
  // downstream DB hiccup is logged, never thrown, and never turned into a
  // non-2xx (which would just make Stripe retry the same event later).
  try {
    if (event.type === "payment_intent.succeeded" || event.type === "payment_intent.payment_failed") {
      const intent = event.data.object as Stripe.PaymentIntent;
      const nextStatus = event.type === "payment_intent.succeeded" ? "captured" : "failed";

      // No STRIPE_SECRET_KEY/SUPABASE_SERVICE_ROLE_KEY misconfiguration
      // should ever surface as a crash here — createAdminClient() throws
      // if the service-role key is missing, so that's caught below too.
      const supabase = createAdminClient();

      // payment_provider_id may not exist on the live DB yet (this
      // payment infrastructure's own migration) — matches this whole
      // file's "don't assume the column exists" requirement. A missing
      // column simply means 0 rows match, logged below, not a throw.
      const { data, error } = await supabase
        .from("orders")
        .update({ payment_status: nextStatus })
        .eq("payment_provider_id", intent.id)
        .select("id, user_id");

      if (error) {
        console.error("[stripe-webhook] Failed to update order payment_status:", error);
      } else if (!data || data.length === 0) {
        console.error(`[stripe-webhook] No order found for payment_provider_id ${intent.id}.`);
      } else if (nextStatus === "captured") {
        // Part 5 of the recommendation-integration architecture — one
        // "purchase" feedback signal per item actually bought, the
        // strongest possible taste signal this app has. Best-effort:
        // logged after the real payment_status update above has already
        // succeeded, never affects this webhook's own 200 response.
        for (const order of data) {
          const { data: items, error: itemsError } = await supabase
            .from("order_items")
            .select("listing_id")
            .eq("order_id", order.id);

          if (itemsError) {
            console.error("[stripe-webhook] Failed to fetch order_items for feedback logging:", itemsError);
            continue;
          }

          for (const item of items ?? []) {
            if (item.listing_id) {
              await logStyleFeedback(order.user_id, item.listing_id, "purchase");
            }
          }
        }
      }
    }
  } catch (error) {
    console.error("[stripe-webhook] Failed to process event:", error);
  }

  return NextResponse.json({ received: true }, { status: 200 });
}
