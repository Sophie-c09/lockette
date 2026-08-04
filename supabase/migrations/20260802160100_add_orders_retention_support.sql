-- Account deletion support — orders.user_id currently cascades (on delete
-- cascade), meaning deleting a user's auth.users/profiles row would
-- silently delete their entire order history along with it, including
-- orders that were actually paid. Real-money transaction records need to
-- survive account deletion (tax/fraud/dispute/accounting reasons — see
-- this repo's account-deletion report for the full retention policy);
-- this migration is what makes that possible at the schema level.
--
-- Changed to "on delete set null" (and user_id made nullable to allow
-- it): the account-deletion server action explicitly deletes UNPAID
-- orders itself before ever deleting the auth user, and explicitly
-- anonymizes (nulls user_id only — amounts, statuses, Stripe
-- identifiers, and shipping address are retained as legitimate
-- dispute/chargeback/fraud-prevention evidence) any paid/refunded order
-- it needs to keep. By the time the auth user is actually deleted, no
-- order should still carry a live, deletion-worthy user_id — "set null"
-- is the safety net if that sequencing is ever violated: a retained
-- order becomes an orphaned-but-intact record instead of vanishing, and
-- an order that was somehow missed becomes inert (no longer visible to
-- anyone, since /orders/[id] and the customer's order list both filter
-- by user_id) rather than lost.
do $$
begin
  if exists (
    select 1 from pg_constraint where conname = 'orders_user_id_fkey'
  ) then
    alter table public.orders drop constraint orders_user_id_fkey;
  end if;
end $$;

alter table public.orders alter column user_id drop not null;

alter table public.orders add constraint orders_user_id_fkey
  foreign key (user_id) references public.profiles (id) on delete set null;
