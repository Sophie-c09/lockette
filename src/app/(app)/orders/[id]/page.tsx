import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { CheckCircle2, Clock, XCircle } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getAverageSecuringMinutes } from "@/lib/order-analytics";
import { OrderPaymentStatusPoller } from "@/components/checkout/OrderPaymentStatusPoller";

export const metadata: Metadata = {
  title: "Order placed — Lockette",
};

// pending_purchase and securing both read as the same simple "still
// working on it" message to a customer — the distinction between "not yet
// opened" and "an admin has opened the order but hasn't bought/failed
// this item yet" is an internal fulfillment-workflow detail, not
// something a customer needs to parse.
const STATUS_LABELS: Record<string, string> = {
  pending_purchase: "🔄 Securing",
  securing: "🔄 Securing",
  purchased: "✅ Purchased",
};

// Real Stripe payment system — truthful language only (see this feature's
// own report): nothing here is ever shown before the Stripe webhook has
// actually confirmed the outcome. The first group (unpaid/authorized/
// captured/failed) are historical values from the old fake-payment flow —
// "authorized"/"captured" are deliberately NOT rendered as success
// language anymore, since those old rows may never have had a real charge
// behind them at all.
const PAYMENT_STATUS_LABELS: Record<string, string> = {
  unpaid: "Payment required",
  authorized: "Payment recorded (legacy)",
  captured: "Payment recorded (legacy)",
  failed: "Payment issue",
  refunded: "Payment refunded",
  pending: "Payment required",
  awaiting_payment: "Awaiting payment confirmation",
  processing: "Processing payment",
  paid: "Payment successful",
  payment_failed: "Payment issue",
  canceled: "Payment canceled",
};

const PAID_STATUSES = new Set(["paid", "captured"]);
const PROCESSING_STATUSES = new Set(["awaiting_payment", "processing"]);
const FAILED_STATUSES = new Set(["failed", "payment_failed"]);

function toSafeNumber(value: unknown): number {
  const num = Number(value ?? 0);
  return Number.isFinite(num) ? num : 0;
}

function formatCentsOrDollars(cents: number | null, dollars: number): string {
  if (cents != null) return `$${(cents / 100).toFixed(2)}`;
  return `$${dollars.toFixed(2)}`;
}

// Order lifecycle spec's exact copy: none resolved yet -> "Securing your
// items", all resolved -> "Order complete", otherwise -> "Some items
// secured". "Resolved" here means purchased or sold out either way, not
// just successfully purchased — this tracks fulfillment progress, not
// purchase success rate.
function progressMessage(secured: number, total: number): string {
  if (secured === 0) return "Securing your items";
  if (secured === total) return "Order complete";
  return "Some items secured";
}

export default async function OrderConfirmationPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  // Plain untyped client — orders/order_items aren't part of the
  // hand-written ListingsDatabase type (see listings.types.ts).
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  // customer_notified_at is deliberately NOT selected here — it's a new,
  // not-yet-migrated column (see supabase/schema.sql), and selecting a
  // column that doesn't exist fails the *entire* query, which would 404
  // every order confirmation page. The stamp below doesn't need to have
  // read its current value first (see the .is(...) guard), so this page
  // never actually needs to select it at all.
  const full = await supabase
    .from("orders")
    .select("id, user_id, status, total_amount, refunded_amount, payment_status, amount_total_cents, shipping_address, payment_failure_message")
    .eq("id", id)
    .maybeSingle();

  let order = full.data;
  let error = full.error;

  if (error) {
    console.error("[order-page] full query failed, falling back:", error);
    const fallback = await supabase
      .from("orders")
      .select("id, user_id, status, total_amount, refunded_amount")
      .eq("id", id)
      .maybeSingle();
    order = fallback.data
      ? { ...fallback.data, payment_status: "unpaid", amount_total_cents: null, shipping_address: null, payment_failure_message: null }
      : fallback.data;
    error = fallback.error;
  }

  // Also 404 (not just redirect) on an order that exists but belongs to
  // someone else — same "don't reveal whether it exists" reasoning as any
  // other owner-scoped lookup in this app.
  if (error || !order || order.user_id !== user.id) {
    notFound();
  }

  // Best-effort — the customer is looking at this page right now, so this
  // is as good a definition of "notified" as this app has today. Never
  // pushed forward again once set (the .is(...) guard); not wired to any
  // actual email/push notification yet.
  {
    const { error: notifyError } = await supabase
      .from("orders")
      .update({ customer_notified_at: new Date().toISOString() })
      .eq("id", order.id)
      .is("customer_notified_at", null);

    if (notifyError) {
      console.error("[order-page] Failed to stamp customer_notified_at:", notifyError);
    }
  }

  const { data: orderItems } = await supabase
    .from("order_items")
    .select("id, product_url, platform, price, shipping_cost, status")
    .eq("order_id", order.id)
    .order("created_at", { ascending: true });

  const averageSecuringMinutes = await getAverageSecuringMinutes();

  const totalAmount = toSafeNumber(order.total_amount);
  const refundedAmount = toSafeNumber(order.refunded_amount);
  const finalTotal = totalAmount - refundedAmount;

  const items = orderItems ?? [];
  const securedCount = items.filter((item) => item.status !== "pending_purchase" && item.status !== "securing").length;
  const progressPercent = items.length > 0 ? Math.round((securedCount / items.length) * 100) : 0;

  const isPaid = PAID_STATUSES.has(order.payment_status);
  const isProcessing = PROCESSING_STATUSES.has(order.payment_status);
  const isFailed = FAILED_STATUSES.has(order.payment_status);
  const isCanceled = order.payment_status === "canceled";

  const shippingAddress = order.shipping_address as
    | { fullName?: string; address?: string; city?: string; state?: string; zip?: string; country?: string }
    | null;

  const heading = isPaid
    ? "Order confirmed 🎉"
    : isFailed
      ? "Payment issue"
      : isCanceled
        ? "Payment canceled"
        : "Confirming your payment";

  return (
    <div className="flex min-h-[calc(100vh-137px)] flex-col items-center px-6 py-12 text-center">
      {/* Re-fetches this page (via router.refresh()) every couple of
          seconds while payment_status is still non-terminal — a customer
          can land here before the Stripe webhook (the sole source of
          truth for "paid") has actually arrived; this never fakes success
          in the meantime. */}
      <OrderPaymentStatusPoller paymentStatus={order.payment_status} />

      {isFailed ? (
        <XCircle className="h-10 w-10 text-oxblood" strokeWidth={1.5} />
      ) : isPaid ? (
        <CheckCircle2 className="h-10 w-10 text-teal" strokeWidth={1.5} />
      ) : (
        <Clock className="h-10 w-10 text-teal" strokeWidth={1.5} />
      )}
      <h1 className="mt-4 font-display text-2xl font-semibold text-ink sm:text-3xl">{heading}</h1>
      <p className="mt-2 text-xs font-medium uppercase tracking-[0.1em] text-ink-soft">
        {PAYMENT_STATUS_LABELS[order.payment_status] ?? order.payment_status}
      </p>

      <p className="mt-2 text-xs text-ink-soft/70">Order #{order.id.slice(0, 8)}</p>

      {isFailed && (
        <p className="mt-3 max-w-sm text-sm text-ink-soft">
          {order.payment_failure_message ?? "Your payment could not be completed. Please try again from your cart."}
        </p>
      )}

      {isCanceled && (
        <p className="mt-3 max-w-sm text-sm text-ink-soft">
          This payment was canceled before it completed. Nothing was charged.
        </p>
      )}

      {isProcessing && (
        <p className="mt-3 max-w-sm text-sm text-ink-soft">
          We&apos;re confirming your payment with your bank — this page will update automatically.
        </p>
      )}

      {isPaid && (
        <>
          <p className="mt-3 max-w-sm text-sm font-medium text-ink">
            Payment successful — {formatCentsOrDollars(order.amount_total_cents, totalAmount)} paid.
          </p>
          <p className="mt-1 max-w-sm text-sm text-ink-soft">
            These items are unique and may sell quickly. We&apos;ll confirm
            availability shortly.
          </p>
          {securedCount < items.length && (
            <p className="mt-1 max-w-sm text-sm text-ink-soft">
              Your item is temporarily secured while we purchase it.
            </p>
          )}
          {averageSecuringMinutes != null && (
            <p className="mt-1 max-w-sm text-xs text-ink-soft/70">
              Usually secured within {averageSecuringMinutes} minute
              {averageSecuringMinutes === 1 ? "" : "s"}
            </p>
          )}
        </>
      )}

      {shippingAddress?.address && (
        <div className="mt-6 w-full max-w-md rounded-card border border-border bg-surface p-4 text-left text-sm">
          <p className="mb-1 font-medium text-ink">Shipping to</p>
          <p className="text-ink-soft">{shippingAddress.fullName}</p>
          <p className="text-ink-soft">{shippingAddress.address}</p>
          <p className="text-ink-soft">
            {[shippingAddress.city, shippingAddress.state, shippingAddress.zip].filter(Boolean).join(", ")}
          </p>
        </div>
      )}

      {isPaid && items.length > 0 && (
        <div className="mt-8 w-full max-w-md text-left">
          <div className="mb-6">
            <div className="flex items-center justify-between text-sm text-ink-soft">
              <span>
                Items secured: {securedCount}/{items.length}
              </span>
              <span>{progressPercent}%</span>
            </div>
            <div className="mt-2 h-2 w-full overflow-hidden rounded-pill bg-inner">
              <div
                className="h-full rounded-pill bg-teal transition-all duration-300 ease-in-out"
                style={{ width: `${progressPercent}%` }}
              />
            </div>
            <p className="mt-2 text-sm font-medium text-ink">
              {progressMessage(securedCount, items.length)}
            </p>
          </div>

          <div className="flex flex-col gap-3">
            {items.map((item) => {
              const isItemFailed = item.status === "failed_unavailable";
              const itemRefund = toSafeNumber(item.price) + toSafeNumber(item.shipping_cost);

              return (
                <div
                  key={item.id}
                  className="flex items-center justify-between gap-3 rounded-card border border-border bg-surface p-4 text-sm"
                >
                  <div className="min-w-0 flex flex-col gap-1">
                    {item.product_url ? (
                      <a
                        href={item.product_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="truncate font-medium text-ink underline"
                      >
                        View on {item.platform ?? "marketplace"}
                      </a>
                    ) : (
                      <span className="text-ink-soft">Listing link unavailable</span>
                    )}

                    {/* A sold-out item is a normal marketplace event, not
                        an error — same neutral styling as every other
                        status line here, no red/alarming treatment. */}
                    {isItemFailed ? (
                      <div className="flex flex-col gap-0.5 text-ink-soft">
                        <span>This item sold before we could secure it.</span>
                        <span>Refunded: ${itemRefund.toFixed(2)}</span>
                      </div>
                    ) : (
                      <span className="text-ink-soft">
                        {STATUS_LABELS[item.status] ?? item.status}
                      </span>
                    )}
                  </div>
                  <span className="shrink-0 font-display font-semibold text-oxblood">
                    ${toSafeNumber(item.price).toFixed(2)}
                  </span>
                </div>
              );
            })}
          </div>

          <div className="mt-6 flex flex-col gap-2 border-t border-border/60 pt-6 text-sm">
            <div className="flex items-center justify-between text-ink-soft">
              <span>Original total</span>
              <span>${totalAmount.toFixed(2)}</span>
            </div>
            <div className="flex items-center justify-between text-ink-soft">
              <span>Refunded amount</span>
              <span>${refundedAmount.toFixed(2)}</span>
            </div>
            <div className="flex items-center justify-between font-display text-base font-semibold text-ink">
              <span>Final total</span>
              <span>${finalTotal.toFixed(2)}</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
