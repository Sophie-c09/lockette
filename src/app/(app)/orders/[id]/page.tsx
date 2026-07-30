import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { CheckCircle2 } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getAverageSecuringMinutes } from "@/lib/order-analytics";

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

const PAYMENT_STATUS_LABELS: Record<string, string> = {
  unpaid: "Payment required",
  authorized: "Payment secured",
  captured: "Payment completed",
  failed: "Payment issue",
  refunded: "Payment refunded",
};

function toSafeNumber(value: unknown): number {
  const num = Number(value ?? 0);
  return Number.isFinite(num) ? num : 0;
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
  //
  // payment_status is also new (this task's payment infrastructure) —
  // same risk, so it's fetched with the same try-then-fallback pattern
  // already established elsewhere (e.g. admin/orders/page.tsx) rather
  // than being added to the select above directly.
  const full = await supabase
    .from("orders")
    .select("id, user_id, status, total_amount, refunded_amount, payment_status")
    .eq("id", id)
    .maybeSingle();

  let order = full.data;
  let error = full.error;

  if (error) {
    console.error("[order-page] payment_status query failed, falling back:", error);
    const fallback = await supabase
      .from("orders")
      .select("id, user_id, status, total_amount, refunded_amount")
      .eq("id", id)
      .maybeSingle();
    order = fallback.data ? { ...fallback.data, payment_status: "unpaid" } : fallback.data;
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
    .select("id, product_url, price, shipping_cost, status")
    .eq("order_id", order.id)
    .order("created_at", { ascending: true });

  const averageSecuringMinutes = await getAverageSecuringMinutes();

  const totalAmount = toSafeNumber(order.total_amount);
  const refundedAmount = toSafeNumber(order.refunded_amount);
  const finalTotal = totalAmount - refundedAmount;

  const items = orderItems ?? [];
  const securedCount = items.filter((item) => item.status !== "pending_purchase" && item.status !== "securing").length;
  const progressPercent = items.length > 0 ? Math.round((securedCount / items.length) * 100) : 0;

  return (
    <div className="flex min-h-[calc(100vh-137px)] flex-col items-center px-6 py-12 text-center">
      <CheckCircle2 className="h-10 w-10 text-teal" strokeWidth={1.5} />
      <h1 className="mt-4 font-display text-2xl font-semibold text-ink sm:text-3xl">
        Order received 🎉
      </h1>
      <p className="mt-2 text-xs font-medium uppercase tracking-[0.1em] text-ink-soft">
        {PAYMENT_STATUS_LABELS[order.payment_status] ?? order.payment_status}
      </p>
      <p className="mt-3 max-w-sm text-sm font-medium text-ink">
        Items are being secured.
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

      {items.length > 0 && (
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
              const isFailed = item.status === "failed_unavailable";
              const itemRefund = toSafeNumber(item.price) + toSafeNumber(item.shipping_cost);

              return (
                <div
                  key={item.id}
                  className="flex items-center justify-between gap-3 rounded-card border border-border bg-surface p-4 text-sm"
                >
                  <div className="flex flex-col gap-1">
                    {item.product_url ? (
                      <a
                        href={item.product_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-medium text-ink underline"
                      >
                        {item.product_url}
                      </a>
                    ) : (
                      <span className="text-ink-soft">Listing link unavailable</span>
                    )}

                    {/* A sold-out item is a normal marketplace event, not
                        an error — same neutral styling as every other
                        status line here, no red/alarming treatment. */}
                    {isFailed ? (
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
