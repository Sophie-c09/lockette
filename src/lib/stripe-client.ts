"use client";

import { loadStripe, type Stripe } from "@stripe/stripe-js";

// Client-side only — NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY is, by design, the
// one Stripe credential safe to ship to the browser (it can only create
// PaymentIntents/tokens client-side, never move money or read account
// data — that's what STRIPE_SECRET_KEY, server-only, is for). loadStripe
// itself caches/memoizes its own promise, but this module-level variable
// avoids re-invoking it (and re-fetching js.stripe.com) on every
// CheckoutView render.
let stripePromise: Promise<Stripe | null> | null = null;

export function getStripeClient(): Promise<Stripe | null> {
  const publishableKey = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;

  if (!publishableKey) {
    console.error(
      "[stripe-client] NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY is not set — the Payment Element cannot load.",
    );
    return Promise.resolve(null);
  }

  if (!stripePromise) {
    stripePromise = loadStripe(publishableKey);
  }

  return stripePromise;
}
