-- Inventory Growth Render-worker migration — moves batch execution out of
-- Vercel's request-bounded process-batch route into one dedicated,
-- continuously-running background worker (src/workers/inventory-growth-worker.ts).
-- Two additions, both additive/optional so a database that hasn't run this
-- migration yet keeps working exactly as before (same tiered-fallback
-- posture as every other scraper_jobs column — see scraper-jobs.ts's own
-- header comment):
--
--   1. scraper_jobs.batch_worker_id — purely observational. The batch-lease
--      mutex itself (batch_lease_id/batch_lease_expires_at, already live)
--      is completely unchanged; this just records WHICH worker process
--      currently holds a lease, so an admin (or a future multi-worker
--      deployment) can tell who's actually running a given batch.
--
--   2. inventory_worker_status — a new, small table for GLOBAL worker
--      process health, independent of any one job. A job's own
--      last_heartbeat (scraper_jobs) only exists while that job has an
--      active lease; it can't answer "is the worker process itself even
--      running" when idle between jobs, which the admin dashboard's
--      worker online/stale/not-configured distinction needs. One row per
--      worker_id (upserted on every heartbeat), never job-scoped.
alter table public.scraper_jobs add column if not exists batch_worker_id text;

create table if not exists public.inventory_worker_status (
  worker_id text primary key,
  started_at timestamptz not null default now(),
  last_heartbeat timestamptz not null default now(),
  current_job_id uuid,
  current_stage text,
  active_browser_count integer not null default 0,
  last_successful_unit_at timestamptz,
  last_successful_unit text,
  last_error text,
  app_version text,
  updated_at timestamptz not null default now()
);

alter table public.inventory_worker_status enable row level security;

-- Service-role only (the worker process and admin API routes both use
-- createAdminClient()) — same "admins can view, nothing else can touch it"
-- posture as scraper_discovery_history's own policy.
drop policy if exists "Worker status is viewable by admins" on public.inventory_worker_status;
create policy "Worker status is viewable by admins"
  on public.inventory_worker_status for select
  using (public.is_admin());
