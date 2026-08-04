"use client";

// A customer can land back on /orders/[id] (via the Stripe redirect
// return_url, or the immediate window.location.assign in PaymentForm.tsx)
// before the Stripe webhook has actually reached this app and flipped
// payment_status to "paid"/"payment_failed" — confirmPayment succeeding
// client-side is never treated as proof of payment (see this feature's
// own report). This just re-fetches the real Server Component page (via
// router.refresh(), so it reads genuinely fresh data from the database,
// not anything cached client-side) every couple of seconds until the
// order reaches a terminal payment state, then stops — "poll briefly and
// show a truthful processing state" rather than faking immediate success.
import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";

const POLL_INTERVAL_MS = 2000;
const MAX_POLL_MS = 30000;

const TERMINAL_PAYMENT_STATUSES = new Set([
  "paid",
  "captured",
  "payment_failed",
  "failed",
  "canceled",
  "refunded",
]);

export function OrderPaymentStatusPoller({ paymentStatus }: { paymentStatus: string }) {
  const router = useRouter();
  const startedAtRef = useRef<number | null>(null);

  useEffect(() => {
    if (TERMINAL_PAYMENT_STATUSES.has(paymentStatus)) return;

    if (startedAtRef.current == null) {
      startedAtRef.current = Date.now();
    }

    const interval = setInterval(() => {
      if (Date.now() - (startedAtRef.current ?? Date.now()) > MAX_POLL_MS) {
        clearInterval(interval);
        return;
      }
      router.refresh();
    }, POLL_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [paymentStatus, router]);

  return null;
}
