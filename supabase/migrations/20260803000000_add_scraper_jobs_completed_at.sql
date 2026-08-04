-- Inventory Growth startup fix — production error: "Failed to start
-- inventory growth: Could not find the 'completed_at' column of
-- 'scraper_jobs' in the schema cache".
--
-- Confirmed directly against the live database (not inferred from
-- schema.sql): `select completed_at from scraper_jobs` fails with
-- Postgres 42703 ("column scraper_jobs.completed_at does not exist").
-- schema.sql has documented this column since the original
-- completeScraperJob/failScraperJob "stuck at running forever" fix (see
-- that section's own comment, a few lines above where this migration's
-- SQL is mirrored) — but that documentation was only ever written into
-- schema.sql's reference text, never actually applied to this live
-- database via a real migration file, the same gap the
-- 20260728005917_add_scraper_jobs_observability_columns.sql migration's
-- own header comment describes for queries_completed/pages_searched/
-- unique_urls_discovered.
--
-- Why this specific column breaks Inventory Growth's *startup* (not just
-- degrade some observability, like most other possibly-missing
-- scraper_jobs columns already do): createLargeScaleScraperJob
-- (src/lib/scraper-jobs.ts) writes completed_at: null in corePayload —
-- the bottom-most tier of its otherwise-graceful fallback chain, with no
-- narrower tier beneath it. Every other write in that file already
-- treats completed_at/updated_at as "might not exist on this database"
-- and drops them in a fallback tier; this one write path never does, so
-- a missing completed_at fails EVERY tier at once and createLargeScaleScraperJob
-- returns { job: null, error } — Inventory Growth cannot start at all,
-- rather than starting in a degraded mode.
--
-- Safe by construction: nullable, `add column if not exists` (a no-op on
-- an environment that already has it), no backfill of any existing row.
alter table public.scraper_jobs add column if not exists completed_at timestamptz;

comment on column public.scraper_jobs.completed_at is
  'Set once a job reaches a terminal state (completed via completeScraperJob, or failed via failScraperJob — src/lib/scraper-jobs.ts). Null while pending/queued/running/paused. Not a heartbeat/lease timestamp — see updated_at/last_heartbeat for liveness and batch_lease_expires_at for the per-batch lease.';
