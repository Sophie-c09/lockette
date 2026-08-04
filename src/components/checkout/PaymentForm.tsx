"use client";

// Real Stripe Payment Element — replaces the old disabled placeholder.
// Card data (number/expiry/CVC) is entered directly into Stripe-hosted
// iframes this component never touches; Lockette's own code never reads,
// stores, or transmits it. Apple Pay / Google Pay are offered
// automatically by the Payment Element itself (via automatic_payment_
// methods on the PaymentIntent, see src/lib/payment.ts) whenever the
// browser/device and the production domain support them — see this
// feature's own report for the one-time Stripe Dashboard step (Payment
// Method Domains) production Apple Pay needs; nothing in this component
// has a separate code path for wallets vs. card, Stripe renders whichever
// are available.
import { useState, type FormEvent } from "react";
import { PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js";
import { Button } from "@/components/ui/Button";

export function PaymentForm({ orderId, payLabel }: { orderId: string; payLabel: string }) {
  const stripe = useStripe();
  const elements = useElements();
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // Guards double submission — a second Enter/click while a
    // confirmation is already in flight is a no-op, not a second charge
    // attempt (Stripe.js itself also rejects a concurrent confirm on the
    // same Elements instance, but this is what keeps the button/UI from
    // even trying).
    if (!stripe || !elements || submitting) return;

    setSubmitting(true);
    setErrorMessage(null);

    // "beforeunload" warns against navigating away mid-confirmation
    // (closing the tab, hitting back) — a 3D Secure challenge or a slow
    // bank response can leave this pending for several seconds, and
    // leaving mid-flight is the one moment a real double-charge risk
    // exists (the customer not knowing whether it went through and
    // trying again from scratch elsewhere).
    function warnBeforeUnload(event: BeforeUnloadEvent) {
      event.preventDefault();
    }
    window.addEventListener("beforeunload", warnBeforeUnload);

    try {
      // redirect: "if_required" — most cards confirm in place with no
      // navigation at all; only a payment method that genuinely requires
      // it (3D Secure, certain bank redirects) actually leaves this page,
      // via return_url below. Either way, this component never marks
      // anything paid itself — the Stripe webhook is the sole source of
      // truth (src/app/api/stripe/webhook/route.ts); a successful
      // confirmPayment here only means "go look at the order page,"
      // which itself shows a truthful "processing" state until the
      // webhook actually lands (see orders/[id]/page.tsx).
      const { error, paymentIntent } = await stripe.confirmPayment({
        elements,
        confirmParams: {
          return_url: `${window.location.origin}/orders/${orderId}`,
        },
        redirect: "if_required",
      });

      if (error) {
        // Stripe's own message is already customer-facing-safe ("Your
        // card was declined.", "Your postal code is incomplete.") — never
        // a raw exception, never card data.
        setErrorMessage(error.message ?? "Something went wrong. Please try again.");
        setSubmitting(false);
        return;
      }

      void paymentIntent;
      // Any resolved outcome (succeeded, processing, or an
      // otherwise-uncaught status) — send the customer to the order page,
      // which independently re-fetches the real, current status from the
      // database rather than trusting anything from this client-side call.
      window.location.assign(`/orders/${orderId}`);
    } finally {
      window.removeEventListener("beforeunload", warnBeforeUnload);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3 rounded-card border border-border bg-inner/50 p-4">
      <p className="text-sm font-medium text-ink">Payment</p>

      <PaymentElement />

      {errorMessage && <p className="text-xs text-oxblood">{errorMessage}</p>}

      <Button type="submit" disabled={!stripe || !elements || submitting} className="mt-1 w-full">
        {submitting ? "Processing…" : payLabel}
      </Button>

      <p className="text-xs text-ink-soft/70">
        Payments are processed securely by Stripe. Lockette never sees or stores your card details.
      </p>
    </form>
  );
}
