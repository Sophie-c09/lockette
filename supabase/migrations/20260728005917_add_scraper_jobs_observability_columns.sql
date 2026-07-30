-- Adds the Inventory Growth discovery-scaling dashboard columns that
-- src/lib/scraper-jobs.ts's updateLargeScaleScraperJobProgress has always
-- written (best-effort, tiered fallback) but the live scraper_jobs table
-- never actually had — confirmed directly: a `select` naming these columns
-- fails with Postgres error 42703 ("column does not exist"), and a real
-- row fetched from the table has no such keys at all. This is why the
-- admin dashboard's "Queries completed / Pages searched / Unique URLs
-- found" fields have only ever been able to show 0.
--
-- Safe by construction:
--   - `add column if not exists` — a no-op if a column already exists
--     (e.g. re-run against an environment that already has it), never
--     errors, never touches unrelated columns.
--   - `integer not null default 0` — Postgres backfills every EXISTING
--     row with the literal default 0 as part of adding the column; no
--     row is deleted, locked for a meaningful duration, or loses any of
--     its other data. This is the same "add column with a default"
--     pattern already used throughout supabase/schema.sql (see
--     valid_count/duplicate_count/rejected_count/error_count above it).
--
-- This exact SQL already lives in supabase/schema.sql (lines documenting
-- the discovery-scaling dashboard columns) — this migration file is what
-- actually gets it applied to a live database via `supabase db push` (or
-- pasted into the SQL editor), since schema.sql itself is this repo's
-- reference document, not something anything runs automatically.

alter table public.scraper_jobs add column if not exists queries_completed integer not null default 0;
alter table public.scraper_jobs add column if not exists pages_searched integer not null default 0;
alter table public.scraper_jobs add column if not exists unique_urls_discovered integer not null default 0;
