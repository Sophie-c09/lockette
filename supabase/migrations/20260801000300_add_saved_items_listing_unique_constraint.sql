-- P0 launch-readiness fix (likes/saved-items) — supabase/schema.sql has
-- declared `saved_items.listing_id` and the
-- `saved_items_user_listing_unique` constraint for a while (search that
-- file for both names), but this table was NEVER TOUCHED by any file in
-- supabase/migrations/ — confirmed by searching this directory before
-- writing this file. schema.sql is a reference document only (nothing
-- runs it automatically), so a real, applied migration never actually
-- existed for either — every saveListing() upsert(...).onConflict(...)
-- call was silently failing with Postgres error 42P10 ("no unique or
-- exclusion constraint matching the ON CONFLICT specification"), which is
-- why src/app/actions/saved-items.ts's own comment documents switching to
-- a non-atomic check-then-insert instead: a real TOCTOU race (rapid
-- double-click, two open tabs) could still create duplicate saved_items
-- rows for the same (user_id, listing_id) pair.
--
-- Dedup BEFORE adding the constraint — if that race has already produced
-- live duplicate rows, `add constraint ... unique` would fail outright
-- otherwise. Keeps the earliest row per (user_id, listing_id) pair (the
-- original save), deletes the rest.
delete from public.saved_items a
using public.saved_items b
where a.listing_id is not null
  and b.listing_id is not null
  and a.user_id = b.user_id
  and a.listing_id = b.listing_id
  and a.id > b.id;

alter table public.saved_items add column if not exists listing_id uuid references public.listings (id) on delete cascade;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'saved_items_user_listing_unique'
  ) then
    alter table public.saved_items
      add constraint saved_items_user_listing_unique unique (user_id, listing_id);
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'saved_items_item_or_listing_check'
  ) then
    alter table public.saved_items
      add constraint saved_items_item_or_listing_check
      check (item_id is not null or listing_id is not null);
  end if;
end $$;
