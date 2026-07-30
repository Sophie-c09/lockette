-- "Scraped listings go live automatically unless flagged" ingestion
-- change — adds the one new column (flag_reason) and widens the status
-- CHECK constraint to allow 'flagged' as a value. Existing rows and their
-- current status values are completely untouched: this only ADDS a new
-- permitted value to the constraint and a new nullable column, it never
-- removes or renames anything, so no existing row can violate it.
--
-- Safe by construction, same pattern as the scraper_jobs observability
-- migration before this one:
--   - `add column if not exists ... text` — nullable, no default needed,
--     no backfill required (every existing row simply has NULL here,
--     which is exactly correct: none of them were ever flagged by this
--     new logic).
--   - Widening a CHECK constraint (adding a new allowed value) can never
--     fail against existing data — every row's current status is already
--     in the new, larger allowed set, since the new set is the old set
--     plus one more value.
--
-- IMPORTANT ordering note: src/lib/admin-scraper.ts, src/lib/bulk-import.ts,
-- and src/app/api/import-listing/route.ts now insert status: 'flagged' for
-- anything flagListing() rejects. Until THIS migration is applied, any such
-- insert will fail with a CHECK constraint violation (not a soft "missing
-- column" degrade — see admin-scraper.ts's own withoutOptionalFields for
-- why those two failure modes need different handling). This migration
-- must run before the next scrape/import for flagged listings to insert
-- successfully; until then they'll show up as insert failures in the
-- existing per-row retry/failure-count logging, not as listings silently
-- promoted to 'active'.
--
-- CONFIRMED LIVE (not assumed from schema.sql): the actual constraint on
-- this database is named `status_check`, not `listings_status_check` as
-- schema.sql's own history would suggest — verified directly via a real
-- insert attempt, whose error read `violates check constraint
-- "status_check"`. Dropping only `listings_status_check` here would have
-- been a silent no-op (IF EXISTS) that left the real, differently-named
-- constraint in place — still rejecting 'flagged' rows even after this
-- migration ran, and adding a second, redundant constraint alongside it.
-- Both possible names are dropped below so this is correct regardless of
-- which one the live table actually has.

alter table public.listings add column if not exists flag_reason text;

alter table public.listings drop constraint if exists status_check;
alter table public.listings drop constraint if exists listings_status_check;
alter table public.listings
  add constraint listings_status_check
  check (status in ('active', 'sold', 'unavailable', 'pending', 'flagged', 'rejected', 'removed', 'expired'));
