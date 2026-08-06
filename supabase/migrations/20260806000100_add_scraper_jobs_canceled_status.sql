-- Final Inventory Growth stabilization pass — a deliberate admin cancel
-- needs its own truthful terminal state, distinct from 'paused'
-- (resumable) and from 'failed' (a genuine error). Without this, the only
-- available terminal-ish states were 'paused' (implies resumable, which a
-- canceled run should not offer) or 'failed' (reads as a bug/error to an
-- admin, when a deliberate cancel is neither).
--
-- Safe by construction: widens the existing CHECK constraint only (adds
-- 'canceled' to the allowed set — never narrows it, never touches any
-- existing row's current status). cancelScraperJob (src/lib/scraper-jobs.ts)
-- already tolerates this constraint not being widened yet on a database
-- that hasn't run this migration — it falls back to 'failed' with a
-- clearly distinguishable CANCELED_BY_ADMIN_PREFIX-tagged error_message,
-- so cancellation works today even before this migration is applied; this
-- migration only upgrades that fallback into the real, dedicated state.
alter table public.scraper_jobs drop constraint if exists scraper_jobs_status_check;
alter table public.scraper_jobs add constraint scraper_jobs_status_check
  check (status in ('pending', 'queued', 'running', 'paused', 'completed', 'failed', 'canceled'));
