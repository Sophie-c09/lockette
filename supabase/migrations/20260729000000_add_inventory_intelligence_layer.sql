-- Closes a real gap discovered while building the hybrid image+semantic
-- search upgrade: supabase/schema.sql has documented the full "Inventory
-- Intelligence" architecture (Parts 3/6/7/8/10/11 — visual_analysis,
-- visual_embedding + pgvector, match_listings_by_embedding,
-- inventory_quality_score, the listing_enrichment_queue table) for a
-- while, and src/lib/inventory/inventory-indexer.ts,
-- src/lib/ai/embedding-search.ts, etc. are all written against it — but
-- NONE of it was ever actually applied to this live database. Verified
-- directly, not assumed from schema.sql: `select visual_embedding from
-- listings` fails with "column listings.visual_embedding does not
-- exist" (42703), `match_listings_by_embedding` fails with "Could not
-- find the function" (PGRST202), and `select * from
-- listing_enrichment_queue` fails with "Could not find the table"
-- (PGRST205). Every real call inventory-indexer.ts's processEnrichmentBatch
-- has ever made in production has therefore been failing outright (an
-- undetected 42703 on the final `.update()`), and the hybrid search
-- feature this migration unblocks (src/lib/discover-visual-search.ts)
-- cannot function at all without this.
--
-- This migration is a straight copy of schema.sql's own Part 7/8/10/11/6
-- sections (search that file for "Inventory Intelligence Layer" /
-- "AI Enrichment Queue" for the original, fully-commented source) — same
-- SQL, just actually run as a real migration this time. Every statement
-- is `if not exists`/`or replace`/`drop ... if exists` — safe to run
-- even if some subset of this was somehow partially applied already.

alter table public.listings add column if not exists visual_analysis jsonb;

create extension if not exists vector;
alter table public.listings add column if not exists visual_embedding vector(1536);

alter table public.listings add column if not exists image_hash text;
alter table public.listings add column if not exists inventory_quality_score double precision;
alter table public.listings add column if not exists last_verified_at timestamptz;

alter table public.listings drop constraint if exists listings_status_check;
alter table public.listings
  add constraint listings_status_check
  check (status in ('active', 'sold', 'unavailable', 'pending', 'flagged', 'rejected', 'removed', 'expired'));

create index if not exists listings_inventory_quality_score_idx on public.listings (inventory_quality_score desc);
create index if not exists listings_image_hash_idx on public.listings (image_hash);
create index if not exists listings_created_at_idx on public.listings (created_at desc);

create index if not exists listings_visual_embedding_idx
  on public.listings using ivfflat (visual_embedding vector_cosine_ops) with (lists = 100);

create or replace function public.match_listings_by_embedding(
  query_embedding vector(1536),
  match_count int default 100,
  filter_category text default null,
  max_price numeric default null
)
returns table (id uuid, similarity double precision)
language sql stable
security invoker
as $$
  select
    listings.id,
    1 - (listings.visual_embedding <=> query_embedding) as similarity
  from public.listings
  where listings.status = 'active'
    and listings.visual_embedding is not null
    and (filter_category is null or listings.category = filter_category)
    and (max_price is null or listings.price <= max_price)
  order by listings.visual_embedding <=> query_embedding
  limit match_count;
$$;

create table if not exists public.listing_enrichment_queue (
  id uuid primary key default gen_random_uuid(),
  listing_id uuid not null references public.listings (id) on delete cascade,
  status text not null default 'pending',
  attempts integer not null default 0,
  error text,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

alter table public.listing_enrichment_queue
  drop constraint if exists listing_enrichment_queue_status_check;
alter table public.listing_enrichment_queue
  add constraint listing_enrichment_queue_status_check
  check (status in ('pending', 'processing', 'completed', 'failed'));

create unique index if not exists listing_enrichment_queue_listing_id_idx
  on public.listing_enrichment_queue (listing_id);
create index if not exists listing_enrichment_queue_status_idx
  on public.listing_enrichment_queue (status, created_at);

alter table public.listing_enrichment_queue enable row level security;

drop policy if exists "Enrichment queue is viewable by admins" on public.listing_enrichment_queue;
create policy "Enrichment queue is viewable by admins"
  on public.listing_enrichment_queue for select
  using (public.is_admin());
