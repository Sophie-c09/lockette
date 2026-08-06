-- Final Inventory Growth stabilization pass — job-scoped queue ownership.
--
-- ROOT CAUSE this closes: scraper_url_queue was entirely global/unscoped —
-- every job's discovered URLs, every worker's claims, and every metrics
-- read all mixed together in one table with no way to tell which job a
-- row belonged to. Confirmed live: 293+ historical failed rows from jobs
-- that no longer exist, sitting alongside a genuinely healthy new job's
-- own rows — a new job's real queue depth/stall diagnostics were
-- indistinguishable from noise left over by every job that ever ran
-- before it.
--
-- Safe by construction:
--   - `add column if not exists` — a no-op on an environment that already
--     has it, never errors, never touches unrelated columns.
--   - nullable, no backfill — every EXISTING row (legacy, pre-migration)
--     keeps job_id = null forever; url-queue.ts's own claimNextUrls/
--     enqueueUrls/getUrlQueueStats treat null as "legacy/unassigned,"
--     never silently attributed to whichever job happens to claim it
--     first. The 293+ historical failed rows are NOT deleted or
--     reassigned.
--   - Application code (url-queue.ts) already tolerates this column not
--     existing yet (tiered fallback to the pre-migration global
--     behavior), so Inventory Growth keeps working today even before this
--     migration is applied — this is a strict improvement, never a
--     requirement to function at all.
alter table public.scraper_url_queue add column if not exists job_id uuid;

-- Backs claimNextUrls' own `.eq("job_id", jobId)` scoping and
-- getUrlQueueStats' per-status counts, both filtered by job_id first.
create index if not exists scraper_url_queue_job_id_status_idx
  on public.scraper_url_queue (job_id, status);

-- Backs getOldestPendingUrlAgeMs' "oldest pending row for this job" query.
create index if not exists scraper_url_queue_job_id_created_at_idx
  on public.scraper_url_queue (job_id, created_at);
