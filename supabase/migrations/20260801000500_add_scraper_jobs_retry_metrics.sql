-- P0 launch-readiness fix (scraper dashboard) — dashboard requirements
-- "retry count" and "permanently failed count" at the JOB level. The
-- per-URL data these summarize already exists (scraper_url_queue.attempt_count
-- and its terminal 'failed' status — see url-queue.ts), and
-- /api/admin-scraper/large-scale/metrics already surfaces a live
-- permanently-failed count sourced directly from that table (see this same
-- launch-readiness pass's fix to that route). These two columns exist so a
-- future pass can persist a durable, point-in-time snapshot onto the job
-- row itself (surviving past the live queue being cleared/reused for a
-- later run) — added now for schema-readiness; not yet written by any
-- application code.
alter table public.scraper_jobs add column if not exists retry_count integer not null default 0;
alter table public.scraper_jobs add column if not exists permanently_failed_count integer not null default 0;
