-- P0 launch-readiness fix (scraper reliability) — claimNextUrls
-- (src/lib/inventory/url-queue.ts) used `created_at` (when a URL was
-- ENQUEUED, not when it was actually claimed) as its staleness clock: a
-- URL claimed shortly before it would have gone stale anyway was
-- immediately eligible for a second worker to reclaim and process twice.
-- claimed_at is now stamped fresh at the actual moment of claim, and the
-- staleness comparison (STALE_CLAIM_THRESHOLD_MS in url-queue.ts) uses it
-- instead.
alter table public.scraper_url_queue add column if not exists claimed_at timestamptz;

-- claimNextUrls' actual query now filters on
-- status.eq.pending,and(status.eq.claimed,claimed_at.lt.<cutoff>) — same
-- "composite index backs both the filter and the ORDER BY created_at"
-- reasoning as scraper_url_queue_status_idx (status, created_at), applied
-- to the new column so the stale-claimed branch of that OR is index-backed
-- too rather than falling back to created_at for that half of the filter.
create index if not exists scraper_url_queue_status_claimed_at_idx
  on public.scraper_url_queue (status, claimed_at);
