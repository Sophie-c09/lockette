-- Closes the gap traced in the "Inventory Growth discovery succeeds but
-- extraction never starts" investigation: discovery (scaled-discovery.ts)
-- reports real numbers (queries completed, pages searched, unique URLs
-- found — scraper_jobs columns, already live) while extraction queue
-- depth/valid/imported-per-minute all stay at 0 forever. Root cause,
-- confirmed directly against the live database (not assumed from
-- schema.sql): `select * from scraper_url_queue` and `select * from
-- scraper_discovery_history` both fail with PGRST205 "Could not find the
-- table" — neither table was ever actually migrated, only ever declared
-- in supabase/schema.sql (search that file for "Discovery-scaling
-- persistence" / "Asynchronous inventory pipeline" for the original,
-- fully-commented source this migration is copied from).
--
-- Every application-code touch point for these two tables
-- (src/lib/inventory/url-queue.ts's enqueueUrls/claimNextUrls/
-- getUrlQueueStats, src/lib/inventory/discovery-history.ts's
-- getProcessedQueries/getQueryYields/recordDiscoveryRun) is deliberately
-- best-effort/never-throws — a missing table degrades to "empty queue" /
-- "no history on record" silently, with no thrown exception anywhere, so
-- this failure mode produces no error in the app, just a permanently
-- stuck pipeline. This migration is the fix: create both tables (with one
-- deliberate index improvement over schema.sql's own definition, noted
-- below) so those functions actually have something to read/write.
--
-- Idempotent throughout (`create table/index if not exists`, `drop
-- constraint/policy if exists` before adding it back) — safe to run
-- again, and safe even if some subset of this was somehow already
-- partially applied.

-- ---------------------------------------------------------------------------
-- scraper_discovery_history — "have we already crawled this
-- (platform, query, page) before" memory (src/lib/inventory/
-- discovery-history.ts). One row per crawl attempt, kept forever (never
-- deleted) — this table IS the "already searched" memory; deleting rows
-- would make a future run re-crawl combinations it already exhausted.
-- ---------------------------------------------------------------------------

create table if not exists public.scraper_discovery_history (
  id uuid primary key default gen_random_uuid(),
  platform text not null,
  query text not null,
  page_number integer not null default 1,
  urls_found integer not null default 0,
  created_at timestamptz not null default now()
);

-- Backs BOTH getProcessedQueries' per-platform read (WHERE platform = ?)
-- and recordDiscoveryRun's upsert (ON CONFLICT (platform, query,
-- page_number)) — a single indexed lookup/upsert instead of a table scan,
-- and re-recording the same combination updates its urls_found instead of
-- accumulating duplicate rows.
create unique index if not exists scraper_discovery_history_platform_query_page_idx
  on public.scraper_discovery_history (platform, query, page_number);
create index if not exists scraper_discovery_history_platform_idx
  on public.scraper_discovery_history (platform);

alter table public.scraper_discovery_history enable row level security;

drop policy if exists "Discovery history is viewable by admins" on public.scraper_discovery_history;
create policy "Discovery history is viewable by admins"
  on public.scraper_discovery_history for select
  using (public.is_admin());

-- No insert/update/delete policy for authenticated users — only ever
-- written by the scaled-discovery module via createAdminClient()
-- (service-role), same convention as scraper_jobs.

-- ---------------------------------------------------------------------------
-- scraper_url_queue — the actual "extraction queue" (src/lib/inventory/
-- url-queue.ts). Discovery writes one row per candidate URL it finds;
-- extraction workers claim bounded batches from here independently, so a
-- crash mid-run leaves 'pending'/reclaimable-'claimed' rows instead of
-- losing whatever discovery had already found.
-- ---------------------------------------------------------------------------

create table if not exists public.scraper_url_queue (
  id uuid primary key default gen_random_uuid(),
  url text not null,
  platform text not null,
  query text not null,
  page integer not null default 1,
  status text not null default 'pending',
  attempt_count integer not null default 0,
  created_at timestamptz not null default now(),
  processed_at timestamptz
);

alter table public.scraper_url_queue drop constraint if exists scraper_url_queue_status_check;
alter table public.scraper_url_queue add constraint scraper_url_queue_status_check
  check (status in ('pending', 'claimed', 'extracted', 'failed'));

-- One row per URL ever discovered — enqueueUrls upserts ON CONFLICT (url),
-- so re-discovering the same URL (a different query/page turning up
-- something already queued) updates the existing row instead of creating
-- a duplicate extraction job for it.
create unique index if not exists scraper_url_queue_url_idx on public.scraper_url_queue (url);

-- Composite (status, created_at), not schema.sql's plain (status) —
-- deliberate improvement, not a copy error. claimNextUrls' actual query
-- (url-queue.ts) is:
--   .or(`status.eq.pending,and(status.eq.claimed,created_at.lt.<cutoff>)`)
--   .order("created_at", { ascending: true })
--   .limit(batchSize)
-- i.e. it always filters by status AND sorts by created_at together. A
-- single-column (status) index still requires a separate sort step for
-- the .order(); the composite index lets Postgres satisfy the filter AND
-- the ORDER BY from the same index scan, which matters once this table
-- has thousands of 'extracted'/'failed' rows sharing tightly-clustered
-- status values. Same shape as this table's own sibling queue,
-- listing_enrichment_queue_status_idx (also (status, created_at) —
-- see supabase/schema.sql) — this brings scraper_url_queue in line with
-- that established convention rather than leaving it as the one queue
-- table still using a plain single-column status index. Kept the same
-- index NAME schema.sql already uses (scraper_url_queue_status_idx) —
-- since this table doesn't exist live yet, there's no pre-existing index
-- under that name to migrate away from, so it's defined correctly from
-- the start rather than needing a follow-up rename.
create index if not exists scraper_url_queue_status_idx
  on public.scraper_url_queue (status, created_at);

alter table public.scraper_url_queue enable row level security;

drop policy if exists "URL queue is viewable by admins" on public.scraper_url_queue;
create policy "URL queue is viewable by admins"
  on public.scraper_url_queue for select
  using (public.is_admin());

-- No insert/update/delete policy for authenticated users — only ever
-- written by src/lib/inventory/url-queue.ts via createAdminClient()
-- (service-role), same convention as scraper_jobs/scraper_discovery_history.
