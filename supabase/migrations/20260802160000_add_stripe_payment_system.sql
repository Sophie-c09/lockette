-- Real Stripe payment system (replaces the fake authorize-with-no-card
-- flow — see src/lib/payment.ts's own header comment). Additive only:
-- no existing row is mutated, no column is dropped. Historical orders
-- created under the old fake flow (payment_status in
-- 'unpaid'/'authorized'/'captured'/'failed') are left exactly as they
-- are — see this repo's launch-readiness report for the diagnostic query
-- that finds them; they are NOT silently reclassified here.
--
-- payment_provider_id is renamed to stripe_payment_intent_id (the name
-- Task 1 of the payment-system pass calls for) rather than left as a
-- differently-named column with a comment explaining the mismatch —
-- existing values are preserved by the rename, nothing is lost. Guarded
-- so re-running this file (or a database that already has the new name)
-- is a no-op.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'orders' and column_name = 'payment_provider_id'
  ) and not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'orders' and column_name = 'stripe_payment_intent_id'
  ) then
    alter table public.orders rename column payment_provider_id to stripe_payment_intent_id;
  end if;
end $$;

alter table public.orders add column if not exists stripe_payment_intent_id text;

-- Cents-based, integer amounts are what Stripe itself works in and what
-- this system now treats as authoritative — total_amount (numeric,
-- dollars) is left in place and still written to for every existing
-- reader (admin dashboard, order-analytics.ts, notifications, the order
-- confirmation page), but new code computes and trusts the *_cents
-- columns below, never a client-submitted total.
alter table public.orders add column if not exists amount_subtotal_cents integer;
alter table public.orders add column if not exists service_fee_cents integer;
alter table public.orders add column if not exists shipping_cents integer;
alter table public.orders add column if not exists amount_total_cents integer;
alter table public.orders add column if not exists currency text not null default 'usd';

-- Truthful payment lifecycle timestamps/detail — paid_at is only ever
-- stamped by the Stripe webhook (the sole source of truth for "the
-- customer was actually charged"), never by a client callback or by
-- PaymentIntent *creation*.
alter table public.orders add column if not exists paid_at timestamptz;
alter table public.orders add column if not exists payment_failure_code text;
alter table public.orders add column if not exists payment_failure_message text;
alter table public.orders add column if not exists refunded_at timestamptz;

-- Widened, not narrowed: 'unpaid'/'authorized'/'captured'/'failed' are
-- kept so historical rows written under the old fake-payment flow
-- remain valid without being rewritten. New code only ever writes the
-- second group (pending/awaiting_payment/processing/paid/payment_failed/
-- canceled/refunded) — see src/lib/payment.ts. 'fulfilled' (mentioned in
-- the payment-system spec this migration implements) is deliberately NOT
-- one of these: it's already represented by the existing, untouched
-- orders.status = 'completed' (a separate column tracking marketplace
-- fulfillment, driven by order_items — see src/lib/orderLifecycle.ts),
-- not by payment_status.
alter table public.orders drop constraint if exists orders_payment_status_check;
alter table public.orders add constraint orders_payment_status_check
  check (payment_status in (
    'unpaid', 'authorized', 'captured', 'failed', 'refunded',
    'pending', 'awaiting_payment', 'processing', 'paid', 'payment_failed', 'canceled'
  ));

-- Webhook idempotency — Stripe explicitly documents that the same event
-- can be delivered more than once (retries, redelivery from the
-- dashboard); recording each processed event.id here is what lets the
-- webhook route (src/app/api/stripe/webhook/route.ts) safely no-op a
-- duplicate delivery instead of re-marking an order paid/refunded twice
-- or double-logging purchase feedback. No RLS policies (same convention
-- as every other service-role-only table in this file, e.g.
-- user_style_feedback's insert path) — only the webhook route's
-- service-role client ever touches this table.
create table if not exists public.stripe_webhook_events (
  id text primary key,
  type text not null,
  processed_at timestamptz not null default now()
);

alter table public.stripe_webhook_events enable row level security;
