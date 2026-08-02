-- P0 launch-readiness fix (scraper reliability) — process-batch/route.ts's
-- own status check (job.status IN ('pending','running')) does not prevent
-- two concurrent calls for the SAME job from both running
-- runLargeScaleAdminScraper at once, since status stays 'running' across
-- many sequential batch calls by design and can't double as a per-attempt
-- mutex. batch_lease_id/batch_lease_expires_at let claimBatchLease
-- (src/lib/scraper-jobs.ts) atomically claim exclusive ownership of one
-- batch attempt; a lease past its expiry is reclaimable, same "stale
-- claims recover" posture as scraper_url_queue.claimed_at.
alter table public.scraper_jobs add column if not exists batch_lease_id uuid;
alter table public.scraper_jobs add column if not exists batch_lease_expires_at timestamptz;

create index if not exists scraper_jobs_batch_lease_expires_at_idx
  on public.scraper_jobs (batch_lease_expires_at);
