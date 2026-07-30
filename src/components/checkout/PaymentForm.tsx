"use client";

// Placeholder only — no payment provider is connected, no card data is
// ever read, stored, or sent anywhere. Every field here is disabled; this
// exists purely so /checkout has the right shape and layout ready for a
// real payment element (Stripe or otherwise) to drop into later.
export interface PaymentMethod {
  type: string;
  last4?: string;
}

export function PaymentForm() {
  return (
    <div className="flex flex-col gap-3 rounded-card border border-border bg-inner/50 p-4">
      <p className="text-sm font-medium text-ink">Payment</p>

      <label className="flex flex-col gap-1 text-xs text-ink-soft">
        Card number
        <input
          type="text"
          disabled
          placeholder="•••• •••• •••• ••••"
          className="rounded-md border border-border bg-surface px-3 py-2 text-sm text-ink-soft disabled:cursor-not-allowed"
        />
      </label>

      <div className="flex gap-3">
        <label className="flex flex-1 flex-col gap-1 text-xs text-ink-soft">
          Expiration
          <input
            type="text"
            disabled
            placeholder="MM / YY"
            className="rounded-md border border-border bg-surface px-3 py-2 text-sm text-ink-soft disabled:cursor-not-allowed"
          />
        </label>
        <label className="flex flex-1 flex-col gap-1 text-xs text-ink-soft">
          CVC
          <input
            type="text"
            disabled
            placeholder="•••"
            className="rounded-md border border-border bg-surface px-3 py-2 text-sm text-ink-soft disabled:cursor-not-allowed"
          />
        </label>
      </div>

      <p className="text-xs text-ink-soft/70">Payment processing coming soon</p>
    </div>
  );
}
