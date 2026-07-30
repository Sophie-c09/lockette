-- Lockette database schema.
-- Run this in the Supabase SQL editor (or `supabase db push`).
--
-- Two tables, deliberately separated:
--   profiles       — account/identity data ("who you are")
--   style_profiles — fashion preferences captured by /onboarding ("what you like")
--
-- Safe to re-run: every statement is guarded so this works whether you're
-- setting up fresh, or migrating an older version of this schema that mixed
-- account and fashion data into a single `profiles` table (that version had
-- full_name/style_tags/size_preference/budget_max/favorite_*/
-- onboarding_completed_at all on `profiles` — this migrates that data into
-- the new `style_profiles` table before dropping those columns).

-- ---------------------------------------------------------------------------
-- profiles: account/identity data only
-- ---------------------------------------------------------------------------

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  username text unique,
  display_name text,
  avatar_url text,
  bio text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Pre-split installs had `full_name` instead of `display_name` — rename
-- rather than add-and-lose-data, but only if it hasn't happened already.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'profiles' and column_name = 'full_name'
  ) and not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'profiles' and column_name = 'display_name'
  ) then
    alter table public.profiles rename column full_name to display_name;
  end if;
end $$;

alter table public.profiles add column if not exists username text unique;
alter table public.profiles add column if not exists display_name text;
alter table public.profiles add column if not exists avatar_url text;
alter table public.profiles add column if not exists bio text;
alter table public.profiles add column if not exists updated_at timestamptz not null default now();

-- Real admin role, replacing the old hardcoded-email check public.is_admin()
-- used to do (see that function, further below) — a boolean column instead
-- of a code constant means granting a second admin is a one-line SQL
-- update, not a deploy. Only ever set by hand in the SQL editor (see the
-- bootstrap update right below, and the column-level grant restriction
-- further down this file that explicitly excludes this column from what a
-- signed-in user can update on their own row) — never exposed to any
-- user-facing form.
alter table public.profiles add column if not exists is_admin boolean not null default false;

-- Bootstrap: grants the original hardcoded admin email (the one
-- public.is_admin() used to compare against directly) the new is_admin
-- flag, every time this file runs — so a fresh install (or a flag
-- accidentally cleared) always re-asserts the site owner as admin, rather
-- than requiring a one-time manual step to be remembered. Additional
-- admins: run `update public.profiles set is_admin = true where id = '<their-uuid>';`
-- by hand in the Supabase SQL editor — there's no admin-management UI for
-- this yet, matching the "simple for now" posture the rest of this feature
-- already had.
update public.profiles set is_admin = true
where id = (select id from auth.users where email = 'sophia@rhinoroofers.com');

-- ---------------------------------------------------------------------------
-- style_profiles: fashion preferences captured by /onboarding
-- ---------------------------------------------------------------------------

create table if not exists public.style_profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references public.profiles (id) on delete cascade,
  style_tags text[] not null default '{}',
  favorite_brands text[] not null default '{}',
  favorite_categories text[] not null default '{}',
  favorite_colors text[] not null default '{}',
  size_preference text,
  budget_max numeric,
  onboarding_completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Part 4 of the recommendation-integration architecture
-- (src/lib/style-embedding.ts) — a real embedding of this user's stated
-- taste (quiz answers + liked items), same model/dimension as
-- listings.visual_embedding (text-embedding-3-small, 1536-dim) so the two
-- live in the same comparable vector space for
-- src/lib/ai/embedding-search.ts's searchListingsByEmbedding. Requires
-- the same pgvector extension listings.visual_embedding already enables
-- (supabase/schema.sql's Part 8 section) — `create extension if not
-- exists vector` there already covers this column too.
alter table public.style_profiles add column if not exists style_embedding vector(1536);
alter table public.style_profiles add column if not exists style_embedding_generated_at timestamptz;

-- Backfill from a pre-split `profiles` table that still carries the legacy
-- fashion columns, then drop those columns from `profiles` — they now live
-- exclusively on `style_profiles`.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'profiles' and column_name = 'style_tags'
  ) then
    insert into public.style_profiles (
      user_id, style_tags, favorite_brands, favorite_categories,
      favorite_colors, size_preference, budget_max, onboarding_completed_at
    )
    select
      p.id, p.style_tags, p.favorite_brands, p.favorite_categories,
      p.favorite_colors, p.size_preference, p.budget_max, p.onboarding_completed_at
    from public.profiles p
    where not exists (
      select 1 from public.style_profiles sp where sp.user_id = p.id
    )
    on conflict (user_id) do nothing;

    alter table public.profiles drop column style_tags;
    alter table public.profiles drop column size_preference;
    alter table public.profiles drop column budget_max;
    alter table public.profiles drop column favorite_brands;
    alter table public.profiles drop column favorite_categories;
    alter table public.profiles drop column favorite_colors;
    alter table public.profiles drop column onboarding_completed_at;
  end if;
end $$;

-- Every profile should have exactly one style_profiles row, even if they've
-- never touched onboarding (existing accounts predating this table).
insert into public.style_profiles (user_id)
select p.id from public.profiles p
where not exists (select 1 from public.style_profiles sp where sp.user_id = p.id)
on conflict (user_id) do nothing;

-- ---------------------------------------------------------------------------
-- saved_items: items a user has swiped right on / saved from /discover
-- ---------------------------------------------------------------------------

create table if not exists public.saved_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  -- References an id from the mock clothing catalog (src/lib/mock-clothing.ts),
  -- not a database table. Nullable because rows saved from the real
  -- `listings` table (further below — listing_id is added onto this table
  -- once that table exists) use listing_id instead.
  item_id text,
  created_at timestamptz not null default now(),
  unique (user_id, item_id)
);

alter table public.saved_items alter column item_id drop not null;

-- Style preferences captured by /onboarding this table didn't originally
-- have a place for: style_tags (above) is what a user likes; this is the
-- inverse ("skip anything grunge/formal") — a distinct concept from
-- disliked_items below, which is about individual LISTINGS a user has
-- swiped away, not aesthetic tags in general.
--
-- Originally a flat text[] of signals — migrated to jsonb (a map from
-- normalized signal -> { count, last_seen }) so scoring can weight a style
-- by how often and how recently it's been disliked (src/lib/disliked-styles.ts),
-- rather than treating "disliked once, years ago" the same as "disliked
-- five times this week." Any pre-existing text[] data is folded in as
-- count: 1 (a real disliked-count history didn't exist under the old
-- shape, so this is the most honest starting point, not a guess at a
-- number that was never actually tracked).
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'style_profiles'
      and column_name = 'disliked_styles' and data_type = 'ARRAY'
  ) then
    alter table public.style_profiles
      alter column disliked_styles type jsonb
      using (
        coalesce(
          (
            select jsonb_object_agg(style, jsonb_build_object('count', 1, 'last_seen', now()))
            from unnest(disliked_styles) as style
          ),
          '{}'::jsonb
        )
      ),
      alter column disliked_styles set default '{}'::jsonb;
  end if;
end $$;

alter table public.style_profiles add column if not exists disliked_styles jsonb not null default '{}'::jsonb;

-- ---------------------------------------------------------------------------
-- listings: imported thrift listings (populated by an internal import job,
-- not by end users — there is deliberately no insert/update/delete policy
-- below, so only the service-role key, which bypasses RLS, can write).
-- ---------------------------------------------------------------------------

create table if not exists public.listings (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  description text,
  price numeric,
  image_url text,
  -- Full image gallery; image_url (above) is kept in sync as images[0] by
  -- the extraction pipeline for backward compatibility with existing code
  -- that only ever reads a single image.
  images text[] not null default '{}',
  product_url text,
  platform text,
  brand text,
  category text,
  size text,
  color text,
  aesthetic_tags text[] not null default '{}',
  -- Marketplace-charged shipping, set at import time from the platform
  -- (see the import route) — 0 is a safe default for any platform without
  -- a known rule, not a claim that shipping is actually free there.
  shipping_cost numeric not null default 0,
  created_at timestamptz not null default now()
);

alter table public.listings add column if not exists images text[] not null default '{}';
alter table public.listings add column if not exists shipping_cost numeric not null default 0;

-- Style-Aware Admin Scraper (see src/lib/admin-scraper-filter.ts) — this
-- run's own aesthetic-archetype match, kept deliberately separate from
-- aesthetic_tags: that column stays populated by the real AI
-- classification pipeline (classifyListing/generateImageTags), which is
-- what Discover's ?style= filter, the homepage category cards, and Feed/
-- Match's tag scoring all actually key off. matched_style is one of this
-- feature's own archetype names (e.g. "boho_y2k"), not a member of that
-- vocabulary, and style_score is only comparable across listings scored
-- by this same scraper. Nullable — only listings imported through this
-- path populate them.
alter table public.listings add column if not exists style_score numeric;
alter table public.listings add column if not exists matched_style text;

-- Image-based outfit-potential scoring (src/lib/image-score.ts) — a
-- second, visual gate on top of style_score/matched_style above, same
-- "this scraper's own signal, not a member of the real aesthetic_tags
-- vocabulary" reasoning. image_score is the FINAL score after Step 5/6's
-- tag/presentation adjustments, not the vision model's raw output.
alter table public.listings add column if not exists image_score numeric;
alter table public.listings add column if not exists image_tags text[];
alter table public.listings add column if not exists fit_type text;
alter table public.listings add column if not exists visual_aesthetic text[];

-- Scoring + ranking architecture (src/lib/listing-score.ts) — the admin
-- scraper no longer hard-rejects candidates for a low style/image/price
-- match (see admin-scraper-filter.ts's own header comment); instead every
-- candidate that clears the two minimal quality gates (a real title, at
-- least 2 photos) is imported as 'pending' with this numeric relevance
-- score attached, and Discover ranks by it (score desc, created_at desc)
-- rather than the scraper deciding in advance what's "good enough."
-- Nullable — a listing imported before this feature existed (or by a
-- different path that doesn't compute one) has no score, not a real 0;
-- discover-feed.ts's ordering treats null as "sorts last," not "worst."
alter table public.listings add column if not exists score numeric;

-- "Hot Item" detection (src/lib/hot-score.ts) — engagement counts from the
-- ORIGINAL marketplace listing (Depop/Vinted/etc.), not Lockette's own
-- activity. Deliberately does NOT add "source_platform"/"source_url"
-- columns some specs for this feature call for: `platform` and
-- `product_url` above already store exactly that (which marketplace, and
-- the original listing URL) — duplicating them under new names would just
-- create two columns that can silently drift out of sync.
-- Nullable, no default: most imports will never populate these (see the
-- import route/extraction pipeline for why) — null means "unknown," not
-- "zero engagement," so hot-score.ts must never treat a missing value as
-- a real 0.
alter table public.listings add column if not exists source_likes_count integer;
alter table public.listings add column if not exists source_views_count integer;
alter table public.listings add column if not exists source_comments_count integer;

-- Permanent availability/moderation state — distinct from (and composes
-- with, via AND) the temporary reserved_by_order_id hold added further
-- below. Five states, two of which are easy to conflate but mean
-- different things:
--   'pending'     every newly-scraped listing starts here (see the import
--                 route) — visible ONLY in the /admin/listings moderation
--                 queue, nowhere else, until an admin approves/rejects it.
--   'active'      set the moment an admin approves a pending listing —
--                 visible everywhere (Discover/Feed/Match/etc).
--   'sold'        set the moment Lockette itself sells it (see
--                 updateOrderItemStatus in src/lib/orderActions.ts) —
--                 hidden from Discover/Feed/Match, but stays visible in
--                 Likes/Cart (badged "Sold", buying disabled).
--   'rejected'    an admin's moderation decision at /admin/listings that
--                 this listing shouldn't be in the marketplace — hidden
--                 everywhere, same visibility as 'sold'/'unavailable' but
--                 a distinct value so "an admin rejected this" and "this
--                 turned out to be unavailable" don't get conflated in
--                 the data.
--   'unavailable' set by the periodic check-listing-status cron job
--                 (src/app/api/cron/check-listing-status) once it detects
--                 a sold/removed signal on the ORIGINAL source page — an
--                 external fact, not a moderation decision, hence its own
--                 value rather than reusing 'rejected'.
-- Rows are never deleted when this changes — kept for analytics.
alter table public.listings add column if not exists status text not null default 'pending';
-- Existing installs already had this column with an older default applied
-- — add column if not exists above is a no-op for them, so the default
-- has to be updated explicitly too.
alter table public.listings alter column status set default 'pending';
-- Last time the cron job above checked this listing's original source page
-- — null until the first check. Only ever written by service-role clients
-- (the cron job), same as status itself; see the narrow authenticated
-- grant below, which deliberately does not include either column.
alter table public.listings add column if not exists last_checked_at timestamptz;

-- Drop + recreate (not the usual guarded if-not-exists add) since this
-- constraint's *definition* changes here — it needs to allow 'rejected'
-- too, not just be present at all (same reasoning as
-- order_items_status_check). Widened again for 'removed' (Admin-Only
-- Listing Removal, src/lib/adminListingRemoval.ts) — distinct from
-- 'rejected' (never made it out of the pending queue) and 'unavailable'
-- (the check-listing-status cron found it sold out externally): this one
-- means an admin pulled an already-live listing for quality/aesthetic
-- reasons. All three are equally hidden everywhere a normal user browses
-- (Discover/Feed/Match already filter to status='active'), same as
-- listings_status_check's own original comment already noted.
alter table public.listings drop constraint if exists listings_status_check;
alter table public.listings
  add constraint listings_status_check
  check (status in ('active', 'sold', 'unavailable', 'pending', 'rejected', 'removed'));

-- Non-destructive alternative to removal (Step 7 of that same feature) —
-- the listing stays 'active' and fully visible everywhere else in the
-- app, just deprioritized in Discover/Feed ranking (see
-- listing-scoring.ts/feed-scoring.ts's own low-quality penalty).
alter table public.listings add column if not exists is_low_quality boolean not null default false;

-- Audit trail for admin-removed listings (src/lib/adminListingRemoval.ts)
-- — training data for the scraper later, per that feature's own spec.
-- image_url/title are snapshotted at removal time (not re-derived from
-- `listings` later), and listing_id is ON DELETE SET NULL rather than
-- CASCADE, so this row stays a self-contained record even if the
-- listing it came from is ever hard-deleted down the line.
create table if not exists public.admin_rejections (
  id uuid primary key default gen_random_uuid(),
  listing_id uuid references public.listings (id) on delete set null,
  image_url text,
  title text,
  reason text,
  created_at timestamptz not null default now()
);

-- Background job tracking for the Style-Aware Scraper
-- (src/lib/admin-scraper.ts, src/app/api/admin-scraper/run/route.ts) — a
-- large scrape (100-500 requested) can legitimately run for several
-- minutes, so its execution was moved out of the request/response cycle
-- entirely: the route creates this row and returns immediately, then
-- keeps running via after() and updates the SAME row as it goes. The
-- admin UI polls getScraperJobStatus() against this row instead of
-- awaiting one long call, so leaving/closing the admin tab no longer
-- aborts an in-progress scrape.
create table if not exists public.scraper_jobs (
  id uuid primary key default gen_random_uuid(),
  status text not null default 'queued',
  requested_count integer not null,
  scraped_count integer not null default 0,
  scored_count integer not null default 0,
  passed_count integer not null default 0,
  inserted_count integer not null default 0,
  error_message text,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  -- Extraction + insert failures combined, and the most recently-started
  -- candidate URL — surfaced in the admin UI (Admin Listings run panel)
  -- so a stuck-looking run can be diagnosed ("currently on: ...", "N
  -- errors so far") without reading server logs. Written best-effort,
  -- same graceful-degradation posture as completed_at/updated_at/
  -- last_heartbeat above (see this table's own earlier comment).
  error_count integer not null default 0,
  last_url text
);

-- 'pending' added alongside the original 'queued' (both accepted —
-- runLargeScaleAdminScraper's jobs are created with 'pending', existing
-- callers still create 'queued' ones, and nothing needs a data migration
-- for old rows) and 'paused' added for the large-scale ingestion job's
-- own pause/resume support (src/app/actions/admin-scraper.ts's
-- pauseScraperJob/resumeScraperJob) — a run checks its own job row's
-- status before starting each batch and stops cleanly, leaving status
-- 'paused' rather than flipping to 'running'/'completed', the moment an
-- admin has paused it.
alter table public.scraper_jobs drop constraint if exists scraper_jobs_status_check;
alter table public.scraper_jobs add constraint scraper_jobs_status_check
  check (status in ('pending', 'queued', 'running', 'paused', 'completed', 'failed'));

-- Investigating a "scraper stuck at running forever, zero results" report
-- found the LIVE scraper_jobs table missing `completed_at` (this file's
-- own column, above) and carrying several extra columns this codebase
-- never defined (target_count, current_round, checkpoint, last_heartbeat,
-- updated_at) — i.e. the live table was created by something other than
-- this schema.sql at some point. completeScraperJob/failScraperJob
-- (src/lib/scraper-jobs.ts) always tried to write completed_at; on a
-- database missing it, every single call failed outright (Postgres
-- "column not found"), so a job's status could NEVER advance past
-- 'running' no matter what actually happened in the background — which
-- is exactly what an admin watching the job would see as an infinite
-- hang, even on a run that silently finished or failed in seconds. Code
-- now degrades gracefully instead of assuming the schema it expects and
-- a given database's actual columns agree (see that file's own header
-- comment) — this line makes sure completed_at exists here going
-- forward, and the columns below make a fresh install match what's
-- already live rather than schema.sql silently omitting them.
alter table public.scraper_jobs add column if not exists completed_at timestamptz;
alter table public.scraper_jobs add column if not exists updated_at timestamptz;
alter table public.scraper_jobs add column if not exists last_heartbeat timestamptz;
-- Large-scale continuous ingestion ("build a 50,000+ listing inventory
-- over time" — src/lib/scraper-config.ts's TARGET_INVENTORY_SIZE,
-- runLargeScaleAdminScraper in src/lib/admin-scraper.ts): target_count is
-- now actually used (the OVERALL inventory goal for this run, distinct
-- from requested_count above, which is one batch's own ask);
-- current_round is repurposed as "which batch number this run is
-- currently on"; checkpoint stores enough of this run's seenUrls set
-- (see admin-scraper.ts's own comment) that a resumed run doesn't
-- immediately re-discover/re-try URLs an earlier, paused run already
-- exhausted.
alter table public.scraper_jobs add column if not exists target_count integer;
alter table public.scraper_jobs add column if not exists current_round integer;
alter table public.scraper_jobs add column if not exists checkpoint jsonb;
alter table public.scraper_jobs add column if not exists error_count integer not null default 0;
-- valid_count/duplicate_count/rejected_count: finer-grained large-scale
-- progress than scored_count/inserted_count alone already gave —
-- duplicate_count specifically covers this task's own dedup requirement
-- (product URL / marketplace ID / image URL / normalized-title match),
-- kept distinct from rejected_count (failed the minimal quality gate, or
-- failed to extract at all) so an admin watching a run can tell "found
-- plenty, but mostly things we already have" apart from "found mostly
-- low-quality/unextractable candidates."
alter table public.scraper_jobs add column if not exists valid_count integer not null default 0;
alter table public.scraper_jobs add column if not exists duplicate_count integer not null default 0;
alter table public.scraper_jobs add column if not exists rejected_count integer not null default 0;
-- total_batches: this run's own planned ceiling (min(MAX_BATCHES, however
-- many batches of BATCH_SIZE it'd take to close the gap to target_count)
-- at start time) — paired with current_round for the admin UI's "batch
-- 43/100" display; not recalculated mid-run even if the gap changes.
alter table public.scraper_jobs add column if not exists total_batches integer;
alter table public.scraper_jobs add column if not exists mode text;

-- Persistent job system (Part 2 of the AI inventory architecture) —
-- error_log is a real structured history (one entry per failure, with
-- when/what), distinct from error_count (already added above, a running
-- tally only) — this is what lets a resumed/inspected job show WHAT went
-- wrong across every retry, not just how many times. Everything else
-- Part 2 asks for (target_count, current batch/round tracking, valid/
-- duplicate/rejected counts, checkpoint data, started_at/completed_at)
-- already exists on this table from the large-scale ingestion work above
-- under its own names — see src/lib/scraper-jobs.ts's own header comment
-- for the exact mapping (current_round = batch number, checkpoint =
-- checkpoint_data, inserted_count = current_count's progress signal,
-- created_at = started_at). Not renamed here to avoid breaking that
-- already-working code for a cosmetic naming difference.
alter table public.scraper_jobs add column if not exists error_log jsonb not null default '[]';
alter table public.scraper_jobs add column if not exists last_url text;

-- Inventory Growth discovery-scaling dashboard (src/lib/inventory/
-- scaled-discovery.ts) — how many distinct queries/search-result pages
-- this run has actually crawled, and how many distinct listing URLs that
-- crawling has turned up in total (BEFORE extraction/quality-gate/
-- duplicate-detection — a separate number from valid_count/
-- duplicate_count, which are post-quality-gate). Same optional/best-
-- effort posture as every other column added here: a database that
-- hasn't run this migration yet just doesn't get these three numbers,
-- nothing else breaks (see scraper-jobs.ts's own tiered-fallback comment).
alter table public.scraper_jobs add column if not exists queries_completed integer not null default 0;
alter table public.scraper_jobs add column if not exists pages_searched integer not null default 0;
alter table public.scraper_jobs add column if not exists unique_urls_discovered integer not null default 0;

-- Inventory Growth/Bulk Importer architecture-parity fix — dashboard
-- requirement "Database insert failures." Distinct from rejected_count
-- (failed the quality gate, or failed to extract at all): this is
-- specifically a candidate that scored well, wasn't a duplicate, and
-- still failed the actual Supabase insert (a real infrastructure problem
-- — bad columns, a constraint violation, connectivity — worth its own
-- number rather than being invisible inside rejected_count).
alter table public.scraper_jobs add column if not exists insert_failed_count integer not null default 0;

-- Same architecture-parity fix — dashboard requirements "URLs extracted
-- successfully" and "extraction failures by reason." extracted_successfully_count
-- is extraction attempts that produced real data (a title AND at least one
-- image); extraction_failures_by_reason is a JSON map of failure reason ->
-- count (a thrown error's message, or "extracted_but_empty" for a
-- non-throwing but empty result), sourced from PipelineFunnel.getCounts().
alter table public.scraper_jobs add column if not exists extracted_successfully_count integer not null default 0;
alter table public.scraper_jobs add column if not exists extraction_failures_by_reason jsonb not null default '{}'::jsonb;

-- Full Style Learning System (src/lib/rejection-learning.ts,
-- src/lib/positive-learning.ts) — negative-learning signal fields added
-- to the table already populated by removeListing() rather than a
-- separate "rejected_items" table: same row, same purpose (this
-- listing's snapshot at the moment an admin rejected it), just enough
-- extra columns to extract tag/fit signal from later.
alter table public.admin_rejections add column if not exists description text;
alter table public.admin_rejections add column if not exists tags text[];
alter table public.admin_rejections add column if not exists fit text;
alter table public.admin_rejections add column if not exists aesthetic text[];

-- Positive-learning counterpart — populated by addApprovedListing()
-- (src/lib/adminListingAdd.ts) whenever an admin manually curates and
-- adds a listing directly (bypassing the scraper entirely). Same column
-- shape as admin_rejections' learning fields, mirrored on purpose so
-- src/lib/positive-learning.ts and rejection-learning.ts can stay
-- structurally parallel.
create table if not exists public.approved_items (
  id uuid primary key default gen_random_uuid(),
  listing_id uuid references public.listings (id) on delete set null,
  image_url text,
  title text,
  description text,
  tags text[],
  fit text,
  aesthetic text[],
  created_at timestamptz not null default now()
);

-- AI quality score (src/lib/listing-quality.ts) computed for every scraped
-- listing before it's inserted — image quality + product appeal (AI-
-- judged) plus fashion-relevance + completeness + price/value (all
-- code-computed: fashion-relevance from aesthetic_tags, completeness from
-- title/price/brand/image_url, price/value from brand tier + category vs.
-- the listing's actual price). The bulk importer (src/lib/bulk-import.ts)
-- never even inserts a listing scoring below 40; the single-URL importer
-- stores the score for every listing but doesn't gate on it (an admin
-- choosing to import one specific URL is a deliberate decision that
-- shouldn't get silently overridden by an automatic score).
-- Nullable, no default: null means "never scored" (e.g. a row from before
-- this feature existed), not a real 0.
alter table public.listings add column if not exists quality_score integer;
alter table public.listings add column if not exists quality_reason text;
-- Per-criterion point breakdown (imageQuality/fashionRelevance/
-- completeness/productAppeal/priceValue) shown compactly on the
-- /admin/listings card — stored as its own column rather than recomputed
-- from other stored fields, since imageQuality/productAppeal are AI-judged
-- at import time and aren't otherwise recoverable later.
alter table public.listings add column if not exists quality_breakdown jsonb;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'listings_quality_score_range'
  ) then
    alter table public.listings
      add constraint listings_quality_score_range
      check (quality_score is null or (quality_score >= 0 and quality_score <= 100));
  end if;
end $$;

create index if not exists listings_status_idx on public.listings (status);

-- saved_items.listing_id: added here (rather than on saved_items' own
-- definition above) since it references `listings`, which must exist first.
alter table public.saved_items add column if not exists listing_id uuid references public.listings (id) on delete cascade;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'saved_items_user_listing_unique'
  ) then
    alter table public.saved_items
      add constraint saved_items_user_listing_unique unique (user_id, listing_id);
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'saved_items_item_or_listing_check'
  ) then
    alter table public.saved_items
      add constraint saved_items_item_or_listing_check
      check (item_id is not null or listing_id is not null);
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- disliked_items: listings a user has swiped away ("X"/Skip) on /match.
-- Previously not persisted at all — a dislike only ever removed a card
-- from that session's in-memory swipe queue (src/components/match/MatchView.tsx),
-- so a disliked listing could resurface on the very next refresh or on
-- Discover/Feed with no memory of it ever having been skipped. Mirrors
-- saved_items/cart_items' shape exactly (no legacy item_id column needed —
-- this is a new feature with no mock-catalog history to carry).
-- ---------------------------------------------------------------------------

create table if not exists public.disliked_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  listing_id uuid not null references public.listings (id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (user_id, listing_id)
);

-- ---------------------------------------------------------------------------
-- Part 5 of the recommendation-integration architecture — a raw,
-- append-only behavioral signal log. Deliberately NOT a replacement for
-- saved_items/disliked_items above (this app's real like/dislike state,
-- read by Discover/Match/the profile page) — this is an ADDITIVE history
-- of every such event over time, multiple rows per listing allowed (a
-- user can like, later reconsider, and skip the same listing — both
-- events matter for future ranking-from-behavior work, not just the
-- CURRENT saved/disliked state saved_items/disliked_items already track).
-- ---------------------------------------------------------------------------

create table if not exists public.user_style_feedback (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  listing_id uuid references public.listings (id) on delete set null,
  action text not null,
  created_at timestamptz not null default now()
);

alter table public.user_style_feedback drop constraint if exists user_style_feedback_action_check;
alter table public.user_style_feedback add constraint user_style_feedback_action_check
  check (action in ('like', 'save', 'skip', 'purchase'));

create index if not exists user_style_feedback_user_id_idx on public.user_style_feedback (user_id, created_at desc);
create index if not exists user_style_feedback_listing_id_idx on public.user_style_feedback (listing_id);

alter table public.user_style_feedback enable row level security;

drop policy if exists "Users can view their own style feedback" on public.user_style_feedback;
create policy "Users can view their own style feedback"
  on public.user_style_feedback for select
  using (auth.uid() = user_id or public.is_admin());

-- No insert/update/delete policy for the authenticated role — every
-- write goes through the service-role client from the existing
-- like/save/skip/purchase action's own server-side code (see
-- src/lib/style-feedback.ts), same reasoning as every other
-- admin/system-only-write table in this file.

-- ---------------------------------------------------------------------------
-- cart_items: listings a user has added to their cart, either via a Match
-- super-like or the listing detail page's "Add to Cart" button.
-- ---------------------------------------------------------------------------

create table if not exists public.cart_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  listing_id uuid not null references public.listings (id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (user_id, listing_id)
);

-- ---------------------------------------------------------------------------
-- orders / order_items: a purchase record created once a user clicks
-- through to buy on the original marketplace. There's no real payment
-- processing yet (see the Cart "Buy on {platform}" flow) — every row here
-- starts, and for now stays, in "pending_purchase" until a future
-- payment/fulfillment integration moves it along.
-- ---------------------------------------------------------------------------

create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  status text not null default 'pending_purchase',
  total_amount numeric not null default 0,
  shipping_address jsonb,
  -- Sum of (price + shipping_cost) across this order's items marked
  -- "failed_unavailable" — see updateOrderItemStatus in
  -- src/lib/orderActions.ts, the only writer of this column.
  refunded_amount numeric not null default 0,
  -- Stamped once, the first time an admin opens this order in the
  -- fulfillment dashboard (see updateOrderStatus in
  -- src/lib/orderActions.ts) — feeds the dashboard's speed analytics.
  processing_started_at timestamptz,
  -- Best-effort "have we shown this customer a status update" marker —
  -- stamped once, the first time they view /orders/[id]. Not wired to any
  -- actual notification (email/push) yet.
  customer_notified_at timestamptz,
  -- Payment infrastructure only — see src/lib/payment.ts. No real
  -- payment gateway is connected yet; these exist so that integration
  -- (whenever it happens) doesn't require another schema change.
  payment_status text not null default 'unpaid',
  payment_provider_id text,
  payment_authorized_at timestamptz,
  -- Set (now + 5 minutes) whenever an automatic capturePayment() attempt
  -- fails — see syncOrderStatus in src/lib/orderLifecycle.ts. Read by
  -- retryPendingCaptures() (src/lib/paymentRetry.ts) so a retry sweep
  -- doesn't hammer Stripe again immediately for an order that just failed;
  -- left stale (never cleared) once payment_status moves past
  -- "authorized" — harmless, since retryPendingCaptures() only ever
  -- queries orders still "authorized" in the first place.
  capture_retry_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.orders add column if not exists refunded_amount numeric not null default 0;
alter table public.orders add column if not exists processing_started_at timestamptz;
alter table public.orders add column if not exists customer_notified_at timestamptz;
alter table public.orders add column if not exists payment_status text not null default 'unpaid';
alter table public.orders add column if not exists payment_provider_id text;
alter table public.orders add column if not exists payment_authorized_at timestamptz;
alter table public.orders add column if not exists capture_retry_at timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'orders_payment_status_check'
  ) then
    alter table public.orders
      add constraint orders_payment_status_check
      check (payment_status in ('unpaid', 'authorized', 'captured', 'failed', 'refunded'));
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'orders_status_check'
  ) then
    alter table public.orders
      add constraint orders_status_check
      check (status in ('pending_purchase', 'processing', 'completed'));
  end if;
end $$;

create table if not exists public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders (id) on delete cascade,
  -- Set null (not cascaded) if the source listing is later removed — this
  -- row's own platform/product_url/price/shipping_cost below are a
  -- snapshot taken at order time, so the order's own history stays intact
  -- either way.
  listing_id uuid references public.listings (id) on delete set null,
  platform text,
  product_url text,
  price numeric,
  shipping_cost numeric not null default 0,
  status text not null default 'pending_purchase',
  -- Both stamped once, the first time each happens (see markOrderItemOpened
  -- / updateOrderItemStatus in src/lib/orderActions.ts) — opened_at ->
  -- purchased_at is the admin dashboard's "time to purchase" metric.
  opened_at timestamptz,
  purchased_at timestamptz,
  -- Stamped once, when this item moves from pending_purchase into
  -- "securing" (an admin opened its order) — securing_started_at ->
  -- purchased_at is what /orders/[id]'s "usually secured within X
  -- minutes" estimate is averaged from (see order-analytics.ts).
  securing_started_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.order_items add column if not exists opened_at timestamptz;
alter table public.order_items add column if not exists purchased_at timestamptz;
alter table public.order_items add column if not exists securing_started_at timestamptz;

-- Drop + recreate (not the usual guarded if-not-exists add) since this
-- constraint's *definition* changes here — it needs to allow the new
-- "securing" status, not just be present at all.
alter table public.order_items drop constraint if exists order_items_status_check;
alter table public.order_items
  add constraint order_items_status_check
  check (status in ('pending_purchase', 'securing', 'purchased', 'failed_unavailable'));

-- Defense-in-depth against duplicate active orders for the same
-- (user, listing) — the real, primary guard is application-level (see
-- findActiveOrdersForListings in src/lib/createOrder.ts, which returns the
-- existing order instead of ever attempting a duplicate insert). This
-- trigger only matters for a genuine race between two concurrent
-- requests slipping past that check at the same time. order_items has no
-- user_id column of its own, so this can't be a plain unique constraint —
-- it has to look up the inserted row's order to find its user_id first.
create or replace function public.prevent_duplicate_active_order_item()
returns trigger
language plpgsql
as $$
declare
  new_user_id uuid;
  conflict_count integer;
begin
  if new.listing_id is null or new.status not in ('pending_purchase', 'securing') then
    return new;
  end if;

  select user_id into new_user_id from public.orders where id = new.order_id;

  select count(*) into conflict_count
  from public.order_items oi
  join public.orders o on o.id = oi.order_id
  where oi.listing_id = new.listing_id
    and o.user_id = new_user_id
    and oi.status in ('pending_purchase', 'securing')
    and o.status <> 'completed'
    and oi.id is distinct from new.id;

  if conflict_count > 0 then
    raise exception 'An active order already exists for this listing.' using errcode = 'P0001';
  end if;

  return new;
end;
$$;

drop trigger if exists prevent_duplicate_active_order_item_trigger on public.order_items;
create trigger prevent_duplicate_active_order_item_trigger
  before insert on public.order_items
  for each row execute procedure public.prevent_duplicate_active_order_item();

-- listings.reservation_*: a temporary hold placed the moment an order is
-- created for a one-of-one listing (see src/lib/reservations.ts, the only
-- writer), so a second customer can't also start buying the same item
-- while the first order is being fulfilled. Added here (not alongside
-- listings' own definition above) since reserved_by_order_id references
-- orders, which must exist first.
alter table public.listings add column if not exists reserved_by_order_id uuid references public.orders (id) on delete set null;
alter table public.listings add column if not exists reserved_at timestamptz;
alter table public.listings add column if not exists reservation_expires_at timestamptz;

-- listings otherwise has no update policy at all (see its own comment
-- above — only the service-role import job writes it). This opens
-- exactly the 3 reservation columns to regular authenticated users,
-- scoped so a listing can only be reserved on behalf of an order the
-- caller themselves owns (never someone else's), and can only be
-- reached at all if it's unreserved, already expired, already theirs,
-- or the caller is admin — an active reservation belonging to a
-- different user is simply invisible to this policy.
drop policy if exists "Listings reservation is updatable" on public.listings;
create policy "Listings reservation is updatable"
  on public.listings for update
  using (
    public.is_admin()
    or reserved_by_order_id is null
    or reservation_expires_at <= now()
    or exists (
      select 1 from public.orders
      where orders.id = listings.reserved_by_order_id
        and orders.user_id = auth.uid()
    )
  )
  with check (
    public.is_admin()
    or reserved_by_order_id is null
    or exists (
      select 1 from public.orders
      where orders.id = listings.reserved_by_order_id
        and orders.user_id = auth.uid()
    )
  );

revoke update on public.listings from authenticated;
grant update (reserved_by_order_id, reserved_at, reservation_expires_at) on public.listings to authenticated;

-- listings.user_id: this is an admin-curated discovery platform — users
-- never create or own listings, only admins add them (via the scraper or
-- addApprovedListing, both service-role, both leave user_id null). Column
-- kept (nullable, unused) rather than dropped in case older rows still
-- reference it; no INSERT/UPDATE/DELETE policy or column grant exists for
-- authenticated on this table beyond the reservation columns above — a
-- regular user cannot write a listing row at all.
alter table public.listings add column if not exists user_id uuid references public.profiles (id) on delete cascade;
create index if not exists listings_user_id_idx on public.listings (user_id);

-- ---------------------------------------------------------------------------
-- Personal Style Request feature: a user submits inspiration (text +
-- photos + budget + categories, see src/app/actions/style-requests.ts),
-- an admin curates a "styled bundle" of existing listings for it
-- (src/lib/styleRequestAdmin.ts), and the user is notified + can add the
-- whole bundle to cart. Only select is opened up to regular authenticated
-- users below — every write (status transitions, bundle creation) goes
-- through the service-role client (createAdminClient()), same as
-- listings' approveListing/rejectListing.
-- ---------------------------------------------------------------------------

create table if not exists public.style_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  inspo_text text,
  -- Storage PATHS, not public URLs — style-request-images is a private
  -- bucket (see below), so a plain public URL wouldn't be fetchable
  -- anyway. Signed URLs are generated on demand from these paths.
  inspo_images text[] not null default '{}',
  budget numeric,
  categories text[] not null default '{}',
  status text not null default 'pending',
  created_at timestamptz not null default now()
);

alter table public.style_requests drop constraint if exists style_requests_status_check;
alter table public.style_requests add constraint style_requests_status_check
  check (status in ('pending', 'in_progress', 'completed'));

-- Keeps categories[] aligned with the exact SelectedCategory union the
-- scraper (src/lib/marketplace-discovery.ts) already understands —
-- anything else couldn't be turned into a real search term anyway.
alter table public.style_requests drop constraint if exists style_requests_categories_check;
alter table public.style_requests add constraint style_requests_categories_check
  check (categories <@ array['low-rise-jeans','low-rise-shorts','low-rise-skirts','tops','dresses','skirts','sweaters-jackets']::text[]);

create index if not exists style_requests_user_id_idx on public.style_requests (user_id);
create index if not exists style_requests_status_idx on public.style_requests (status);

create table if not exists public.styled_bundles (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.style_requests (id) on delete cascade,
  title text not null,
  description text,
  created_at timestamptz not null default now()
);
create index if not exists styled_bundles_request_id_idx on public.styled_bundles (request_id);

-- AI-Powered Outfit Creation (src/lib/style-bundle-analysis.ts,
-- src/lib/bundle-generation.ts) — every column below is nullable/has a
-- safe default, so an existing bundle row (created by the original
-- manual admin-curation flow, src/lib/styleRequestAdmin.ts, which never
-- populates any of these) keeps working exactly as it already did; these
-- are additive fields the new AI generation path fills in, not a
-- replacement for the manual flow.
alter table public.styled_bundles add column if not exists preview_image text;
alter table public.styled_bundles add column if not exists item_subtotal numeric;
alter table public.styled_bundles add column if not exists mavelle_fee numeric;
alter table public.styled_bundles add column if not exists total_price numeric;
alter table public.styled_bundles add column if not exists estimated_delivery_start date;
alter table public.styled_bundles add column if not exists estimated_delivery_end date;
-- 'draft' (AI-generated, not yet reviewed/purchased) / 'generating' (row
-- exists so the user can be redirected here immediately, but the async
-- generation pipeline — src/lib/bundle-generation.ts's
-- runBundleGenerationAsync — hasn't finished yet; items arrive
-- progressively while this is the status) / 'error' (generation finished
-- but found nothing usable — generation_error below has why) / 'ready'
-- (finalized, shown to the user) / 'purchased' — distinct from
-- style_requests.status (pending/in_progress/completed), which tracks
-- the REQUEST's own admin-review lifecycle, not the bundle object itself.
alter table public.styled_bundles add column if not exists status text not null default 'ready';
alter table public.styled_bundles drop constraint if exists styled_bundles_status_check;
alter table public.styled_bundles add constraint styled_bundles_status_check
  check (status in ('draft', 'generating', 'error', 'ready', 'purchased'));
-- Only ever set alongside status = 'error' — surfaced to the user so
-- "we couldn't build this" isn't a silent dead end.
alter table public.styled_bundles add column if not exists generation_error text;
-- generation_step/generation_progress: finer-grained progress within
-- status = 'generating' (starting/analyzing_inspiration/searching_items/
-- ranking_matches/building_preview/complete/failed — written by
-- src/lib/bundle-generation.ts's runBundleGenerationAsync/
-- createGeneratingBundle) — status alone only says "still generating,"
-- these say how far along.
alter table public.styled_bundles add column if not exists generation_step text;
alter table public.styled_bundles add column if not exists generation_progress integer not null default 0;

create table if not exists public.styled_bundle_items (
  id uuid primary key default gen_random_uuid(),
  bundle_id uuid not null references public.styled_bundles (id) on delete cascade,
  listing_id uuid not null references public.listings (id) on delete cascade,
  created_at timestamptz not null default now()
);
create index if not exists styled_bundle_items_bundle_id_idx on public.styled_bundle_items (bundle_id);

-- position: display/collage order within the bundle (0-based) — lets the
-- Pinterest-style preview (src/lib/outfit-preview.ts) render items in a
-- deliberate order instead of insertion order.
alter table public.styled_bundle_items add column if not exists position integer not null default 0;
-- category: this app's own GarmentCategory vocabulary
-- (src/lib/garment-detection.ts) for THIS item — denormalized from
-- `listings.category` (a raw, inconsistent source string) so swap/replace
-- (Part 5) can filter same-category alternatives without a join.
alter table public.styled_bundle_items add column if not exists category text;
-- replacement_group: which "slot" this item fills in the outfit (e.g.
-- "tops", "bottoms") — an item can be swapped only against others sharing
-- the same replacement_group, preserving the outfit's overall structure.
-- Nullable/free-text rather than an enum: a future outfit could have two
-- independent "tops" slots (e.g. a top + an open layer) that must never
-- be swapped against each other despite sharing a category.
alter table public.styled_bundle_items add column if not exists replacement_group text;
create index if not exists styled_bundle_items_replacement_group_idx on public.styled_bundle_items (bundle_id, replacement_group);

-- ---------------------------------------------------------------------------
-- Recreate This Outfit: a user uploads a photo, the system classifies it
-- (src/lib/outfit-classification.ts) and matches it against already-
-- ACTIVE listings only (src/lib/outfit-matching.ts) — no live scraping
-- per request, that's admin-only and multi-minute (see listings' own
-- comment above). Fully automated/real-time, so unlike style_requests
-- there's no admin-curation status machine — a recreation is complete
-- the moment it's inserted.
-- ---------------------------------------------------------------------------

-- Migrated to this shape (from a version with image_path/inspo_text/
-- budget/style_keywords/aesthetic_tags/categories columns plus a separate
-- outfit_recreation_items child table of ranked per-category matches) —
-- matches are no longer computed once at submission time and persisted as
-- rows; they're fetched fresh every time the results page loads
-- (getOutfitRecreation, src/app/actions/outfit-recreations.ts), the same
-- "always live, never stale" approach "Find Similar" already uses.
-- swapOutfitItem and the outfit_recreation_items table it depended on are
-- gone entirely — shuffling/replacing a piece is now purely a client-side
-- reorder of a freshly-fetched pool, nothing to persist.
create table if not exists public.outfit_recreations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users (id) on delete cascade,
  -- Named image_url, but still holds a private-bucket storage PATH
  -- (outfit-photos, see below), not a real public URL — photos were kept
  -- private in this migration, so a signed URL is still generated fresh
  -- on every read (getSignedOutfitPhotoUrl, src/lib/outfit-photo.ts)
  -- rather than stored directly (a stored signed URL would just expire).
  image_url text not null,
  -- AI output (src/lib/outfit-classification.ts's classifyOutfitPhoto):
  -- { categories: OutfitCategory[], styleKeywords: string[],
  --   budgetByCategory: Partial<Record<OutfitCategory, BudgetOption>> }.
  -- budgetByCategory isn't itself AI output, but this is the only place
  -- left to persist the per-piece budget selector
  -- (src/lib/budget-options.ts) now that there's no outfit_recreation_items
  -- row to carry it — getOutfitRecreation reads it back out to re-apply
  -- each category's own price ceiling when it fetches matches live.
  detected_items jsonb,
  -- Aesthetic tags (y2k, streetwear, etc.) — same signal this table used
  -- to call aesthetic_tags.
  style_tags text[],
  created_at timestamp with time zone default now()
);

create index if not exists outfit_recreations_user_id_idx on public.outfit_recreations (user_id);

-- Visual Similarity Search Foundation (src/lib/image-similarity.ts) — one
-- embedding for the WHOLE inspiration photo (there's only one photo per
-- recreation, unlike a listing's own image_embedding which is per-item),
-- generated at submit time (src/app/actions/outfit-recreations.ts's
-- submitOutfitRecreation) and read back by getOutfitRecreation to pass
-- into rankBySimilarity's optional queryImageEmbedding parameter
-- (src/lib/garment-similarity-ranking.ts). Both nullable — null for
-- every row inserted before this column existed, or if embedding
-- generation failed at submit time (best-effort, never blocks
-- submission); same plain `double precision[]` (not pgvector's `vector`
-- type) reasoning as listings.image_embedding's own column comment.
alter table public.outfit_recreations add column if not exists image_embedding double precision[];
alter table public.outfit_recreations add column if not exists embedding_generated_at timestamptz;

-- ---------------------------------------------------------------------------
-- Style Me: a user submits several inspiration photos + optional text +
-- a budget; src/lib/style-me-classification.ts aggregates a "dominant
-- style" signal across ALL the photos in one AI call, and
-- src/lib/style-me-matching.ts auto-generates a surprise 2-5 item bundle
-- from already-ACTIVE listings (same real-time-only philosophy as
-- outfit_recreations above — no live scraping per request). Unlike
-- outfit_recreations, generation is intentionally hidden from the user
-- until status = 'delivered' (see the bundle tables' own SELECT policies
-- below) — status advances on a fixed, simulated timer
-- (src/lib/style-me-status.ts), not any real fulfillment: this app has
-- no real shipping/delivery concept anywhere (confirmed — orders/
-- order_items stop at "we finished sourcing," see that section below),
-- so "shipped"/"delivered" here are a scripted reveal-pacing device, not
-- a real order status. Real purchase happens afterward via the existing
-- "Add All to Cart" pattern, same as Personal Style Request above.
-- ---------------------------------------------------------------------------

create table if not exists public.style_me_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  inspo_text text,
  -- Private-bucket storage PATHS (style-me-images, see below), same
  -- convention as style_requests.inspo_images.
  inspo_images text[] not null default '{}',
  budget numeric not null,
  -- Aggregated across ALL submitted images in one AI call — the
  -- IMAGE_TAG_VOCABULARY aesthetic tags, canonical `#Tag` form.
  dominant_styles text[] not null default '{}',
  -- Broader than outfit_recreations' top/bottom/layer — the real
  -- CategoryBucket set (src/lib/bulk-import.ts) a "2-5 item bundle" (not
  -- one-per-slot) needs.
  categories text[] not null default '{}',
  status text not null default 'pending',
  created_at timestamptz not null default now()
);

alter table public.style_me_requests drop constraint if exists style_me_requests_status_check;
alter table public.style_me_requests add constraint style_me_requests_status_check
  check (status in ('pending', 'in_progress', 'shipped', 'delivered'));

-- Deliberately NOT widened to include 'bags' — src/lib/garment-detection.ts
-- later split "bags" out of "accessories" as its own detectable category
-- (better matching for a detected purse/backpack), but this table wasn't
-- part of that migration. src/app/actions/style-me.ts collapses "bags"
-- back to "accessories" before writing to this column specifically, so
-- this constraint's original value list is still accurate for what's
-- actually ever inserted here — if you widen it to add 'bags', also
-- remove that collapse step.
alter table public.style_me_requests drop constraint if exists style_me_requests_categories_check;
alter table public.style_me_requests add constraint style_me_requests_categories_check
  check (categories <@ array['tops','dresses','bottoms','outerwear','accessories','shoes']::text[]);

create index if not exists style_me_requests_user_id_idx on public.style_me_requests (user_id);

create table if not exists public.style_me_bundles (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.style_me_requests (id) on delete cascade,
  title text not null,
  description text,
  created_at timestamptz not null default now()
);
create index if not exists style_me_bundles_request_id_idx on public.style_me_bundles (request_id);

create table if not exists public.style_me_bundle_items (
  id uuid primary key default gen_random_uuid(),
  bundle_id uuid not null references public.style_me_bundles (id) on delete cascade,
  listing_id uuid not null references public.listings (id) on delete cascade,
  created_at timestamptz not null default now()
);
create index if not exists style_me_bundle_items_bundle_id_idx on public.style_me_bundle_items (bundle_id);

-- ---------------------------------------------------------------------------
-- notifications: in-app, order-related updates for the customer (see
-- src/lib/notifications.ts, the only writer/reader). Not email/push —
-- purely a row a signed-in user sees in the navbar bell.
-- ---------------------------------------------------------------------------

create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  order_id uuid references public.orders (id) on delete cascade,
  order_item_id uuid references public.order_items (id) on delete cascade,
  type text not null,
  title text not null,
  message text not null,
  read boolean not null default false,
  created_at timestamptz not null default now()
);

-- Was a not-exists-guarded add (only ever ran once, so it could never
-- widen) — switched to drop-if-exists/add like every other constraint in
-- this file, so adding 'style_request_completed' below actually takes
-- effect on an existing database, not just a fresh one.
alter table public.notifications drop constraint if exists notifications_type_check;
alter table public.notifications
  add constraint notifications_type_check
  check (type in ('order_created', 'item_secured', 'item_failed', 'order_completed', 'style_request_completed'));

-- Personal Style Request feature (see src/lib/notifications.ts,
-- src/lib/styleRequestAdmin.ts) — nullable, same pattern as order_id/
-- order_item_id above: only 'style_request_completed' notifications
-- populate this.
alter table public.notifications add column if not exists style_request_id uuid references public.style_requests (id) on delete cascade;

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------

alter table public.profiles enable row level security;

drop policy if exists "Profiles are viewable by their owner" on public.profiles;
create policy "Profiles are viewable by their owner"
  on public.profiles for select
  using (auth.uid() = id);

drop policy if exists "Profiles are editable by their owner" on public.profiles;
create policy "Profiles are editable by their owner"
  on public.profiles for update
  using (auth.uid() = id);

-- Column-level grant restriction — critical now that profiles carries
-- is_admin (see above): the RLS policy just above is row-scoped only
-- ("your own row"), so without this, any signed-in user could set
-- is_admin = true on their own profile via a normal update() call, a
-- straightforward self-elevation-to-admin bug. Scoped to exactly the
-- columns ProfileForm's updateProfile() (src/app/actions/profile.ts)
-- actually writes today — same narrowing pattern already used for
-- listings.status/notifications.read elsewhere in this file.
revoke update on public.profiles from authenticated;
grant update (username, display_name, avatar_url, bio, updated_at) on public.profiles to authenticated;

drop policy if exists "Profiles are insertable by their owner" on public.profiles;
create policy "Profiles are insertable by their owner"
  on public.profiles for insert
  with check (auth.uid() = id);

alter table public.style_profiles enable row level security;

drop policy if exists "Style profiles are viewable by their owner" on public.style_profiles;
create policy "Style profiles are viewable by their owner"
  on public.style_profiles for select
  using (auth.uid() = user_id);

drop policy if exists "Style profiles are editable by their owner" on public.style_profiles;
create policy "Style profiles are editable by their owner"
  on public.style_profiles for update
  using (auth.uid() = user_id);

drop policy if exists "Style profiles are insertable by their owner" on public.style_profiles;
create policy "Style profiles are insertable by their owner"
  on public.style_profiles for insert
  with check (auth.uid() = user_id);

alter table public.saved_items enable row level security;

drop policy if exists "Saved items are viewable by their owner" on public.saved_items;
create policy "Saved items are viewable by their owner"
  on public.saved_items for select
  using (auth.uid() = user_id);

drop policy if exists "Saved items are insertable by their owner" on public.saved_items;
create policy "Saved items are insertable by their owner"
  on public.saved_items for insert
  with check (auth.uid() = user_id);

drop policy if exists "Saved items are deletable by their owner" on public.saved_items;
create policy "Saved items are deletable by their owner"
  on public.saved_items for delete
  using (auth.uid() = user_id);

alter table public.disliked_items enable row level security;

drop policy if exists "Disliked items are viewable by their owner" on public.disliked_items;
create policy "Disliked items are viewable by their owner"
  on public.disliked_items for select
  using (auth.uid() = user_id);

drop policy if exists "Disliked items are insertable by their owner" on public.disliked_items;
create policy "Disliked items are insertable by their owner"
  on public.disliked_items for insert
  with check (auth.uid() = user_id);

drop policy if exists "Disliked items are deletable by their owner" on public.disliked_items;
create policy "Disliked items are deletable by their owner"
  on public.disliked_items for delete
  using (auth.uid() = user_id);

alter table public.listings enable row level security;

drop policy if exists "Listings are viewable by everyone" on public.listings;
create policy "Listings are viewable by everyone"
  on public.listings for select
  using (true);

-- "More Like This" on the listing detail page (src/lib/similar-listings.ts,
-- the only caller). Ordering by "most shared aesthetic_tags first" needs a
-- per-row computed value (the size of the intersection between this
-- listing's tags and the candidate's), which plain PostgREST filter-builder
-- calls can't express — .overlaps() (used elsewhere, e.g.
-- discover-feed.ts) can filter on array overlap but has no way to order by
-- an overlap *count*. Dropping to a SQL function is the same resolution
-- already used once in this file for the same kind of gap (see
-- average_securing_minutes below). No security definer needed here, unlike
-- that function — "Listings are viewable by everyone" above already makes
-- a plain (invoker-rights) select see every row, for anon and authenticated
-- alike.
create or replace function public.similar_listings(
  p_listing_id uuid,
  p_tags text[],
  p_limit int default 10
)
returns setof public.listings
language sql
stable
as $$
  select l.*
  from public.listings l
  where l.id <> p_listing_id
    and l.status = 'active'
    and l.aesthetic_tags && p_tags
  order by
    cardinality(array(select unnest(l.aesthetic_tags) intersect select unnest(p_tags))) desc,
    l.created_at desc
  limit p_limit;
$$;

grant execute on function public.similar_listings(uuid, text[], int) to anon, authenticated;

alter table public.cart_items enable row level security;

drop policy if exists "Cart items are viewable by their owner" on public.cart_items;
create policy "Cart items are viewable by their owner"
  on public.cart_items for select
  using (auth.uid() = user_id);

drop policy if exists "Cart items are insertable by their owner" on public.cart_items;
create policy "Cart items are insertable by their owner"
  on public.cart_items for insert
  with check (auth.uid() = user_id);

drop policy if exists "Cart items are deletable by their owner" on public.cart_items;
create policy "Cart items are deletable by their owner"
  on public.cart_items for delete
  using (auth.uid() = user_id);

-- Real admin-role check, reading profiles.is_admin for the calling user —
-- replaces the previous hardcoded-email comparison (see that column's own
-- comment further up this file). No security definer needed: this only
-- ever reads the CALLER's own row (id = auth.uid()), which "Profiles are
-- viewable by their owner" already permits for that same caller, so a
-- plain invoker-rights function sees it fine.
create or replace function public.is_admin()
returns boolean
language sql
stable
as $$
  select coalesce(
    (select is_admin from public.profiles where id = auth.uid()),
    false
  );
$$;

-- Customer-facing "usually secured within X minutes" estimate on
-- /orders/[id] (see src/lib/order-analytics.ts, the only caller). Needs
-- security definer to average across *all* customers' order_items — a
-- plain RLS-respecting query from a customer's own session would only
-- ever see their own rows, understating (or nulling out) the estimate for
-- anyone without much order history of their own. Safe to expose broadly:
-- it returns a single aggregate number, never any row-level/per-user data,
-- so this doesn't weaken order_items' own RLS policies at all.
create or replace function public.average_securing_minutes()
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select round(avg(extract(epoch from (purchased_at - securing_started_at)) / 60)::numeric, 0)
  from public.order_items
  where securing_started_at is not null and purchased_at is not null;
$$;

grant execute on function public.average_securing_minutes() to authenticated;

alter table public.orders enable row level security;

drop policy if exists "Orders are viewable by their owner" on public.orders;
create policy "Orders are viewable by their owner"
  on public.orders for select
  using (auth.uid() = user_id or public.is_admin());

drop policy if exists "Orders are insertable by their owner" on public.orders;
create policy "Orders are insertable by their owner"
  on public.orders for insert
  with check (auth.uid() = user_id);

-- Replaces the old "owner can update" policy: order status/refunded_amount
-- are admin-managed (see src/lib/orderActions.ts), not something the
-- purchasing user should be able to set themselves.
drop policy if exists "Orders are updatable by their owner" on public.orders;
drop policy if exists "Orders are updatable by admin" on public.orders;
create policy "Orders are updatable by admin"
  on public.orders for update
  using (public.is_admin());

-- No delete policy: orders are a historical record, not something users
-- clear out the way an ephemeral cart/saved-items row can be removed.

alter table public.order_items enable row level security;

drop policy if exists "Order items are viewable by their order's owner" on public.order_items;
create policy "Order items are viewable by their order's owner"
  on public.order_items for select
  using (
    public.is_admin()
    or exists (
      select 1 from public.orders
      where orders.id = order_items.order_id and orders.user_id = auth.uid()
    )
  );

drop policy if exists "Order items are insertable by their order's owner" on public.order_items;
create policy "Order items are insertable by their order's owner"
  on public.order_items for insert
  with check (exists (
    select 1 from public.orders
    where orders.id = order_items.order_id and orders.user_id = auth.uid()
  ));

-- Replaces the old "order's owner can update" policy — same reasoning as
-- orders above: item status is admin-managed, not user-managed.
drop policy if exists "Order items are updatable by their order's owner" on public.order_items;
drop policy if exists "Order items are updatable by admin" on public.order_items;
create policy "Order items are updatable by admin"
  on public.order_items for update
  using (public.is_admin());

alter table public.notifications enable row level security;

drop policy if exists "Notifications are viewable by their owner" on public.notifications;
create policy "Notifications are viewable by their owner"
  on public.notifications for select
  using (auth.uid() = user_id);

-- Owner OR admin can insert: order_created is created on behalf of the
-- customer by the customer's own session (createOrder.ts), but item_secured/
-- item_failed/order_completed are created by an admin action
-- (updateOrderItemStatus) on behalf of a *different* user — the order's
-- customer, not the signed-in admin.
drop policy if exists "Notifications are insertable by owner or admin" on public.notifications;
create policy "Notifications are insertable by owner or admin"
  on public.notifications for insert
  with check (auth.uid() = user_id or public.is_admin());

-- Owner can update, but only the `read` column (see the grant below) —
-- "mark as read" is the only mutation a customer should ever be able to
-- make to their own notifications.
drop policy if exists "Notifications are updatable by their owner" on public.notifications;
create policy "Notifications are updatable by their owner"
  on public.notifications for update
  using (auth.uid() = user_id);

revoke update on public.notifications from authenticated;
grant update (read) on public.notifications to authenticated;

alter table public.style_requests enable row level security;

drop policy if exists "Style requests are viewable by their owner or admin" on public.style_requests;
create policy "Style requests are viewable by their owner or admin"
  on public.style_requests for select
  using (auth.uid() = user_id or public.is_admin());

drop policy if exists "Style requests are insertable by their owner" on public.style_requests;
create policy "Style requests are insertable by their owner"
  on public.style_requests for insert
  with check (auth.uid() = user_id and status = 'pending');

-- No update/delete policy for regular authenticated users — status
-- transitions (pending -> in_progress -> completed) are admin-only and go
-- through createAdminClient(), same as listings' approve/reject.

alter table public.styled_bundles enable row level security;

drop policy if exists "Styled bundles are viewable by their request's owner or admin" on public.styled_bundles;
create policy "Styled bundles are viewable by their request's owner or admin"
  on public.styled_bundles for select
  using (
    public.is_admin()
    or exists (
      select 1 from public.style_requests
      where style_requests.id = styled_bundles.request_id
        and style_requests.user_id = auth.uid()
    )
  );

alter table public.styled_bundle_items enable row level security;

drop policy if exists "Styled bundle items are viewable by their bundle's owner or admin" on public.styled_bundle_items;
create policy "Styled bundle items are viewable by their bundle's owner or admin"
  on public.styled_bundle_items for select
  using (
    public.is_admin()
    or exists (
      select 1 from public.styled_bundles
      join public.style_requests on style_requests.id = styled_bundles.request_id
      where styled_bundles.id = styled_bundle_items.bundle_id
        and style_requests.user_id = auth.uid()
    )
  );

alter table public.outfit_recreations enable row level security;

drop policy if exists "Outfit recreations are viewable by their owner or admin" on public.outfit_recreations;
create policy "Outfit recreations are viewable by their owner or admin"
  on public.outfit_recreations for select
  using (auth.uid() = user_id or public.is_admin());

drop policy if exists "Outfit recreations are insertable by their owner" on public.outfit_recreations;
create policy "Outfit recreations are insertable by their owner"
  on public.outfit_recreations for insert
  with check (auth.uid() = user_id);

-- No update/delete policy — a recreation is created complete in one
-- insert (image_url — a storage path, see that column's own comment
-- above — is known before insert, see outfit-photo.ts) and never edited
-- afterward. No outfit_recreation_items policies anymore either — that
-- table is gone (see outfit_recreations' own comment above).

alter table public.style_me_requests enable row level security;

drop policy if exists "Style Me requests are viewable by their owner or admin" on public.style_me_requests;
create policy "Style Me requests are viewable by their owner or admin"
  on public.style_me_requests for select
  using (auth.uid() = user_id or public.is_admin());

drop policy if exists "Style Me requests are insertable by their owner" on public.style_me_requests;
create policy "Style Me requests are insertable by their owner"
  on public.style_me_requests for insert
  with check (auth.uid() = user_id and status = 'pending');

-- No update/delete policy for regular users — status advancement is
-- opportunistic-on-read (src/lib/style-me-status.ts) but still writes
-- through createAdminClient(), same admin/service-role-only convention
-- as style_requests.

alter table public.style_me_bundles enable row level security;

-- The actual "no preview" guarantee: a non-admin can only ever select a
-- bundle row once its own request has reached 'delivered' — a real
-- data-layer gate, not just something the server actions choose not to
-- return.
drop policy if exists "Style Me bundles are viewable once delivered, or by admin" on public.style_me_bundles;
create policy "Style Me bundles are viewable once delivered, or by admin"
  on public.style_me_bundles for select
  using (
    public.is_admin()
    or exists (
      select 1 from public.style_me_requests
      where style_me_requests.id = style_me_bundles.request_id
        and style_me_requests.user_id = auth.uid()
        and style_me_requests.status = 'delivered'
    )
  );

drop policy if exists "Style Me bundles are insertable by their request's owner" on public.style_me_bundles;
create policy "Style Me bundles are insertable by their request's owner"
  on public.style_me_bundles for insert
  with check (
    exists (
      select 1 from public.style_me_requests
      where style_me_requests.id = style_me_bundles.request_id
        and style_me_requests.user_id = auth.uid()
    )
  );

alter table public.style_me_bundle_items enable row level security;

drop policy if exists "Style Me bundle items are viewable once delivered, or by admin" on public.style_me_bundle_items;
create policy "Style Me bundle items are viewable once delivered, or by admin"
  on public.style_me_bundle_items for select
  using (
    public.is_admin()
    or exists (
      select 1 from public.style_me_bundles
      join public.style_me_requests on style_me_requests.id = style_me_bundles.request_id
      where style_me_bundles.id = style_me_bundle_items.bundle_id
        and style_me_requests.user_id = auth.uid()
        and style_me_requests.status = 'delivered'
    )
  );

drop policy if exists "Style Me bundle items are insertable by their bundle's owner" on public.style_me_bundle_items;
create policy "Style Me bundle items are insertable by their bundle's owner"
  on public.style_me_bundle_items for insert
  with check (
    exists (
      select 1 from public.style_me_bundles
      join public.style_me_requests on style_me_requests.id = style_me_bundles.request_id
      where style_me_bundles.id = style_me_bundle_items.bundle_id
        and style_me_requests.user_id = auth.uid()
    )
  );

alter table public.admin_rejections enable row level security;

drop policy if exists "Admin rejections are viewable by admins" on public.admin_rejections;
create policy "Admin rejections are viewable by admins"
  on public.admin_rejections for select
  using (public.is_admin());

-- No insert/update/delete policy for authenticated users — only ever
-- written by removeListing() via createAdminClient() (service-role),
-- same as every other admin-only mutation in this codebase.

alter table public.approved_items enable row level security;

drop policy if exists "Approved items are viewable by admins" on public.approved_items;
create policy "Approved items are viewable by admins"
  on public.approved_items for select
  using (public.is_admin());

-- No insert/update/delete policy for authenticated users — only ever
-- written by addApprovedListing() via createAdminClient() (service-role).

alter table public.scraper_jobs enable row level security;

drop policy if exists "Scraper jobs are viewable by admins" on public.scraper_jobs;
create policy "Scraper jobs are viewable by admins"
  on public.scraper_jobs for select
  using (public.is_admin());

-- No insert/update/delete policy for authenticated users — only ever
-- written by /api/admin-scraper/run's route handler via createAdminClient()
-- (service-role), same convention as admin_rejections/approved_items above.

-- Discovery-scaling persistence (src/lib/inventory/query-generator.ts,
-- src/lib/inventory/discovery-history.ts, src/lib/inventory/
-- scaled-discovery.ts) — records every (platform, query, page) search
-- this app has ever actually crawled, so a future discovery pass can skip
-- straight to combinations it hasn't tried yet instead of re-crawling
-- page 1 of the same handful of search terms every round (the root cause
-- of Inventory Growth's climbing duplicate rate — 62% -> 90% -> 93% across
-- batches 1-3 of a real run). One row per crawl attempt, kept forever
-- (never deleted) — this table IS the "have we searched this before"
-- memory; deleting rows would just make the run re-crawl combinations it
-- already exhausted.
create table if not exists public.scraper_discovery_history (
  id uuid primary key default gen_random_uuid(),
  platform text not null,
  query text not null,
  page_number integer not null default 1,
  urls_found integer not null default 0,
  created_at timestamptz not null default now()
);

-- One row per (platform, query, page) combination ever attempted — lets
-- "has this been processed" be a single indexed lookup/upsert rather than
-- a table scan, and makes re-recording the same combination update its
-- urls_found instead of accumulating duplicate rows.
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
-- (service-role), same convention as scraper_jobs above.

-- Asynchronous inventory pipeline (OVERNIGHT_AGGRESSIVE — src/lib/
-- inventory/url-queue.ts) — decouples discovery from extraction so
-- overnight acquisition is never blocked waiting on either. Discovery
-- writes a row per candidate URL it finds; independent extraction workers
-- claim batches from here rather than extracting whatever discovery just
-- happened to return in the same call. Persistent (not an in-memory
-- array) so a crash mid-run leaves 'pending'/reclaimable-'claimed' rows
-- instead of losing whatever discovery had already found — the same
-- crash-resilience posture listing_enrichment_queue already established.
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

-- One row per URL ever discovered — re-discovering the same URL (a
-- different query/page turning up something already queued) updates the
-- existing row instead of creating a duplicate extraction job for it.
create unique index if not exists scraper_url_queue_url_idx on public.scraper_url_queue (url);
-- Composite (status, created_at) — claimNextUrls (url-queue.ts) always
-- filters by status AND orders by created_at together, so the composite
-- form lets one index scan satisfy both instead of a separate sort step;
-- same shape as this table's own sibling, listing_enrichment_queue's own
-- (status, created_at) index above. See supabase/migrations/
-- 20260729000200_add_scraper_url_queue_and_discovery_history.sql for the
-- full rationale (this replaces what used to be a plain (status) index
-- here, before that migration).
create index if not exists scraper_url_queue_status_idx on public.scraper_url_queue (status, created_at);

alter table public.scraper_url_queue enable row level security;

drop policy if exists "URL queue is viewable by admins" on public.scraper_url_queue;
create policy "URL queue is viewable by admins"
  on public.scraper_url_queue for select
  using (public.is_admin());

-- No insert/update/delete policy for authenticated users — only ever
-- written by src/lib/inventory/url-queue.ts via createAdminClient()
-- (service-role), same convention as scraper_jobs/scraper_discovery_history
-- above.

-- ---------------------------------------------------------------------------
-- New user setup: create both rows when someone signs up.
-- ---------------------------------------------------------------------------

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, username, display_name, avatar_url, bio)
  values (new.id, null, null, null, null)
  on conflict (id) do nothing;

  insert into public.style_profiles (
    user_id, style_tags, favorite_brands, favorite_categories,
    favorite_colors, size_preference, budget_max, onboarding_completed_at
  )
  values (new.id, '{}', '{}', '{}', '{}', null, null, null)
  on conflict (user_id) do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- ---------------------------------------------------------------------------
-- avatars storage bucket: profile picture uploads (src/components/profile/
-- ProfileForm.tsx). Public bucket — profiles.avatar_url is displayed
-- anywhere a profile is shown, including to signed-out visitors, so the
-- objects themselves need to be publicly readable; writes are still locked
-- down below to each user's own folder. file_size_limit/allowed_mime_types
-- mirror the 5MB/images-only validation already done client-side, as a
-- second, server-enforced backstop.
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'avatars',
  'avatars',
  true,
  5242880,
  array['image/jpeg', 'image/png', 'image/webp', 'image/gif']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- Every object is uploaded under `${auth.uid()}/profile-image.<ext>` (see
-- ProfileForm.tsx) — storage.foldername(name) splits that path, so
-- element [1] is the top-level folder, i.e. the uploading user's own id.
-- This is the standard Supabase pattern for per-user storage folders.
drop policy if exists "Avatar images are publicly viewable" on storage.objects;
create policy "Avatar images are publicly viewable"
  on storage.objects for select
  using (bucket_id = 'avatars');

drop policy if exists "Users can upload their own avatar" on storage.objects;
create policy "Users can upload their own avatar"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "Users can replace their own avatar" on storage.objects;
create policy "Users can replace their own avatar"
  on storage.objects for update
  to authenticated
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  )
  with check (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "Users can delete their own avatar" on storage.objects;
create policy "Users can delete their own avatar"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- ---------------------------------------------------------------------------
-- listing-photos storage bucket: seller-submitted listing photos (see
-- src/app/actions/listings.ts). Public bucket for the same reason as
-- avatars — approved listings' photos are shown to signed-out visitors
-- too. Path convention is `${user.id}/${listingId}/${index}.${ext}`, one
-- level deeper than avatars since a user can own multiple listings, each
-- with multiple photos (vs. avatars' single file per user).
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'listing-photos',
  'listing-photos',
  true,
  5242880,
  array['image/jpeg', 'image/png', 'image/webp', 'image/gif']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- Public read only — every write into this bucket comes from an admin
-- action (admin-scraper.ts, adminListingAdd.ts), always via
-- createAdminClient() (service-role, bypasses RLS entirely). No
-- authenticated-role insert/update/delete policy exists on purpose: this
-- is an admin-curated platform, regular users never upload listing photos.
drop policy if exists "Listing photos are publicly viewable" on storage.objects;
create policy "Listing photos are publicly viewable"
  on storage.objects for select
  using (bucket_id = 'listing-photos');

-- ---------------------------------------------------------------------------
-- style-request-images storage bucket: a user's personal style-inspiration
-- photos (see src/app/actions/style-requests.ts). Deliberately NOT public
-- — unlike avatars/listing-photos (meant for public display), these are
-- private reference images only the uploading user and admins should ever
-- see; access goes through signed URLs (src/lib/style-request-photo.ts)
-- rather than getPublicUrl(). Path convention:
-- `${user.id}/${requestId}/${index}.${ext}`, same shape as listing-photos.
-- ---------------------------------------------------------------------------

-- file_size_limit matches MAX_STYLE_REQUEST_PHOTO_BYTES
-- (src/lib/listing-photo.ts, 10MB) — NOT the 5MB every other photo
-- bucket in this file uses. Style Request's per-photo limit was raised
-- to 10MB without this bucket ever having existed live yet; keep these
-- two in sync if either changes again.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'style-request-images',
  'style-request-images',
  false,
  10485760,
  array['image/jpeg', 'image/png', 'image/webp', 'image/gif']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Style request images are viewable by their owner or admin" on storage.objects;
create policy "Style request images are viewable by their owner or admin"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'style-request-images'
    and ((storage.foldername(name))[1] = auth.uid()::text or public.is_admin())
  );

drop policy if exists "Users can upload their own style request images" on storage.objects;
create policy "Users can upload their own style request images"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'style-request-images'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "Users can delete their own style request images" on storage.objects;
create policy "Users can delete their own style request images"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'style-request-images'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- ---------------------------------------------------------------------------
-- outfit-photos storage bucket: a user's uploaded "recreate this outfit"
-- photo (see src/app/actions/outfit-recreations.ts). Private, same
-- reasoning as style-request-images — a personal photo, not meant for
-- public display; access goes through signed URLs
-- (src/lib/outfit-photo.ts) rather than getPublicUrl(). Path convention:
-- `${user.id}/${randomToken}/photo.${ext}` — the token is generated
-- before the outfit_recreations row is even inserted, since (unlike
-- style-request-images) there's only ever one photo, so there's no need
-- to key the path off the row's own id.
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'outfit-photos',
  'outfit-photos',
  false,
  5242880,
  array['image/jpeg', 'image/png', 'image/webp', 'image/gif']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Outfit photos are viewable by their owner or admin" on storage.objects;
create policy "Outfit photos are viewable by their owner or admin"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'outfit-photos'
    and ((storage.foldername(name))[1] = auth.uid()::text or public.is_admin())
  );

drop policy if exists "Users can upload their own outfit photos" on storage.objects;
create policy "Users can upload their own outfit photos"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'outfit-photos'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "Users can delete their own outfit photos" on storage.objects;
create policy "Users can delete their own outfit photos"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'outfit-photos'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- ---------------------------------------------------------------------------
-- style-me-images storage bucket: a user's inspiration photos for Style
-- Me (see src/app/actions/style-me.ts). Private, identical shape to
-- style-request-images — a multi-photo case, not the single-photo
-- outfit-photos bucket. Path convention:
-- `${user.id}/${requestId}/${index}.${ext}`.
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'style-me-images',
  'style-me-images',
  false,
  5242880,
  array['image/jpeg', 'image/png', 'image/webp', 'image/gif']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Style Me images are viewable by their owner or admin" on storage.objects;
create policy "Style Me images are viewable by their owner or admin"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'style-me-images'
    and ((storage.foldername(name))[1] = auth.uid()::text or public.is_admin())
  );

drop policy if exists "Users can upload their own Style Me images" on storage.objects;
create policy "Users can upload their own Style Me images"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'style-me-images'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "Users can delete their own Style Me images" on storage.objects;
create policy "Users can delete their own Style Me images"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'style-me-images'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- ---------------------------------------------------------------------------
-- discover-search-photos storage bucket: hybrid image+semantic search
-- upgrade — a user's uploaded "search by photo" inspiration image on
-- /discover (src/app/actions/discover-feed.ts's searchDiscoverByPhoto,
-- src/lib/discover-search-photo.ts). Private, same shape/reasoning as
-- outfit-photos above (a personal photo, not meant for public display;
-- access goes through signed URLs, never getPublicUrl()) — except these
-- are purely ephemeral (only ever used once, synchronously, to generate
-- a query embedding for that single search) rather than something a
-- later page load needs to keep displaying, so the app deletes each
-- upload from this bucket right after generating its embedding instead
-- of leaving it around. Path convention matches outfit-photos exactly:
-- `${user.id}/${randomToken}/photo.${ext}`.
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'discover-search-photos',
  'discover-search-photos',
  false,
  5242880,
  array['image/jpeg', 'image/png', 'image/webp', 'image/gif']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Discover search photos are viewable by their owner or admin" on storage.objects;
create policy "Discover search photos are viewable by their owner or admin"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'discover-search-photos'
    and ((storage.foldername(name))[1] = auth.uid()::text or public.is_admin())
  );

drop policy if exists "Users can upload their own discover search photos" on storage.objects;
create policy "Users can upload their own discover search photos"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'discover-search-photos'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "Users can delete their own discover search photos" on storage.objects;
create policy "Users can delete their own discover search photos"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'discover-search-photos'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- ---------------------------------------------------------------------------
-- Marketplace Ingestion Architecture — a unified, indexed inventory layer
-- across every marketplace this app can search (Lockette's own `listings`
-- table is itself one such source, alongside eBay/Depop/Vinted/Poshmark/
-- Mercari — src/lib/marketplaces/types.ts's MarketplaceSource). This is
-- distinct from src/lib/marketplace-search.ts, which fans out and re-ranks
-- LIVE on every single user search: this table is meant to be populated
-- AHEAD OF TIME by a separate ingestion process per source
-- (src/lib/marketplace-ingestion/) — the same "crawl ahead of time, don't
-- hit a live source on every request" principle this codebase's own admin
-- scraper already established for Lockette's own inventory
-- (src/lib/admin-scraper.ts). Foundation only — not wired into any live
-- query path yet, and no scraping is implemented (see
-- src/lib/marketplace-ingestion/sources/ for why every non-Lockette source
-- is a documented, not-yet-implemented placeholder rather than a working
-- ingester).
-- ---------------------------------------------------------------------------

create table if not exists public.marketplace_listings (
  id uuid primary key default gen_random_uuid(),
  -- Same vocabulary as src/lib/marketplaces/types.ts's MarketplaceSource,
  -- so a row's source_platform always lines up with a live search
  -- provider's own `platform` field.
  source_platform text not null,
  -- The source's own listing identifier (for 'reworn', that row's own
  -- `listings.id`) — paired with source_platform as this table's real
  -- dedupe key, since two different marketplaces can't collide on the
  -- same external id.
  external_id text not null,
  title text not null,
  description text,
  images text[] not null default '{}',
  price numeric,
  -- Coarse bucket as reported by the SOURCE itself (may be a raw,
  -- inconsistent string per marketplace) — kept separate from
  -- detected_category below, the same "raw vs. AI-derived" separation
  -- the `listings` table already draws between its own `category` and
  -- `matched_style`/`image_tags` columns.
  category text,
  brand text,
  url text not null,
  availability text not null default 'available',
  -- Denormalized blob (title + description + brand + category folded
  -- together) — a plain-text search-readiness field usable today via a
  -- standard Postgres full-text index, without waiting on real image
  -- embeddings.
  searchable_text text,
  -- This app's own GarmentCategory vocabulary
  -- (src/lib/garment-detection.ts) once an ingested listing has actually
  -- been run through AI classification — null until that enrichment step
  -- exists; never assumed to equal the raw `category` above.
  detected_category text,
  -- Structured, per-item detail in the same shape as DetectedGarment
  -- (src/lib/garment-detection.ts) minus its runtime-only searchQueries
  -- field — garment_type/color/pattern/material/silhouette/era/
  -- visual_details, once a real enrichment pass populates them. Null
  -- until then; jsonb (not separate columns) since this is explicitly a
  -- placeholder/future shape, not yet a stable, query-filtered contract.
  garment_attributes jsonb,
  -- Placeholder for a future image-embedding-based visual similarity
  -- search (see src/lib/garment-similarity-ranking.ts's own header
  -- comment on why this app's current ranking is text-attribute-based,
  -- not real embeddings — no pgvector/CLIP infrastructure exists yet).
  -- Plain float array, not the `vector` type, so this migration doesn't
  -- itself require enabling the pgvector extension — swapping this to a
  -- real `vector(N)` column (plus an ivfflat/hnsw index) is a natural
  -- follow-up once a real embedding model is actually wired in.
  image_embedding double precision[],
  -- When image_embedding was last (re)computed — null until a real
  -- embedding provider exists (src/lib/image-similarity.ts). Separate
  -- from last_ingested_at: re-ingesting a listing's text fields doesn't
  -- necessarily mean its embedding was recomputed too.
  embedding_generated_at timestamptz,
  last_ingested_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

alter table public.marketplace_listings add column if not exists embedding_generated_at timestamptz;

alter table public.marketplace_listings
  drop constraint if exists marketplace_listings_source_platform_check;
alter table public.marketplace_listings
  add constraint marketplace_listings_source_platform_check
  check (source_platform in ('reworn', 'ebay', 'depop', 'vinted', 'poshmark', 'mercari'));

alter table public.marketplace_listings
  drop constraint if exists marketplace_listings_availability_check;
alter table public.marketplace_listings
  add constraint marketplace_listings_availability_check
  check (availability in ('available', 'unavailable'));

-- Re-ingesting the same external listing updates the existing row
-- instead of duplicating it — this is what src/lib/marketplace-ingestion/
-- store.ts's upsert keys on.
create unique index if not exists marketplace_listings_source_external_id_idx
  on public.marketplace_listings (source_platform, external_id);

create index if not exists marketplace_listings_detected_category_idx
  on public.marketplace_listings (detected_category);

create index if not exists marketplace_listings_availability_idx
  on public.marketplace_listings (availability);

-- Search-readiness: a standard Postgres full-text index over the
-- denormalized searchable_text blob — usable today, ahead of any real
-- embedding-based search.
create index if not exists marketplace_listings_searchable_text_idx
  on public.marketplace_listings using gin (to_tsvector('english', coalesce(searchable_text, '')));

alter table public.marketplace_listings enable row level security;

-- Indexed marketplace data, not user-specific — readable by anyone, same
-- broad-read pattern `listings` itself uses ("Listings are viewable by
-- everyone", above). No insert/update/delete policy for the authenticated
-- role: only ever written by a service-role ingestion process
-- (src/lib/marketplace-ingestion/), never by a normal user request.
drop policy if exists "Marketplace listings are viewable by everyone" on public.marketplace_listings;
create policy "Marketplace listings are viewable by everyone"
  on public.marketplace_listings for select
  using (true);

-- Visual Similarity Search Foundation (src/lib/image-similarity.ts) — the
-- SAME two placeholder columns as marketplace_listings above, added here
-- too because src/lib/garment-similarity-ranking.ts and
-- src/app/actions/outfit-recreations.ts's getOutfitRecreation operate
-- directly on `listings` rows (marketplace_listings isn't wired into the
-- live Recreate This Look query path) — this is what actually lets a
-- future real embedding pipeline feed the live ranking's new, additive
-- visualSimilarityScore term (see garment-similarity-ranking.ts's own
-- comment on that term). Both null for every row until that pipeline
-- exists; see marketplace_listings' own column comments for why
-- image_embedding is a plain float array, not pgvector's `vector` type.
alter table public.listings add column if not exists image_embedding double precision[];
alter table public.listings add column if not exists embedding_generated_at timestamptz;

-- ---------------------------------------------------------------------------
-- Inventory Intelligence Layer (Parts 7-12 of the AI inventory
-- architecture) — every listing's AI-derived understanding, on top of the
-- existing style_score/image_score/image_tags/aesthetic_tags columns
-- above (those stay exactly as they are; this is additive, richer
-- structured data alongside them, not a replacement).
-- ---------------------------------------------------------------------------

-- Full structured output of src/lib/ai/visual-listing-analysis.ts's
-- analyzeListingVisually() (Part 7) — category/garment_type/colors/
-- patterns/materials/silhouette/fit/era/aesthetic_tags/style_attributes/
-- confidence, as one JSON blob. Kept separate from the existing
-- style_score/image_tags/etc. columns (which stay driven by the
-- existing admin-scraper enrichment pipeline, unchanged) rather than
-- replacing them — this is the richer, array-based analysis Part 7
-- specifically asks for.
alter table public.listings add column if not exists visual_analysis jsonb;

-- Real pgvector column (Part 8/10) — distinct from image_embedding above,
-- which stays a plain double precision[] (this codebase's existing
-- embedding pipeline still writes there; nothing about that changes).
-- visual_embedding is what src/lib/ai/embedding-search.ts's pgvector KNN
-- query (Part 10) actually searches against. text-embedding-3-small
-- produces 1536-dimensional vectors (src/lib/image-similarity.ts's own
-- EMBEDDING_MODEL) — matches that dimension so the SAME embedding
-- pipeline's output can be written here too, just as a real `vector`
-- instead of a plain array.
--
-- This DOES require enabling the pgvector extension — previously
-- deliberately NOT done (see image_embedding's own comment above,
-- "doesn't itself require enabling the pgvector extension") because no
-- query needed it yet. Part 10 explicitly asks for real pgvector
-- similarity search, so this migration turns it on for real rather than
-- continuing to defer it. `if not exists` makes this safe to re-run.
create extension if not exists vector;
alter table public.listings add column if not exists visual_embedding vector(1536);

-- Content hash (Part 5) — sha256 of the fetched image bytes, NOT a true
-- perceptual/pHash. This catches the same image byte-for-byte re-hosted
-- under a different URL (a common real-world duplicate pattern — the
-- same seller's photo reposted, or one listing scraped from two source
-- pages) but will NOT catch a re-compressed/re-cropped/watermarked copy
-- of visually the same photo — that would need real perceptual hashing
-- (avg-hash/dHash over decoded pixels), which needs an image-processing
-- library this project doesn't currently depend on. Documented
-- limitation, not a silent gap — see duplicate-detection.ts's own header
-- comment.
alter table public.listings add column if not exists image_hash text;

-- Part 11's weighted composite (image quality/multiple images/AI
-- confidence/style relevance/price/freshness) — distinct from the
-- existing `score` column (src/lib/listing-score.ts's calculateScore,
-- used by Discover's own ranking) and `quality_score`/`quality_reason`/
-- `quality_breakdown` (src/lib/admin-scraper-filter.ts's older
-- pre-scoring-architecture-change gates, still present on old rows) —
-- this is the NEW inventory-intelligence-specific score
-- (listing-quality.ts's calculateInventoryQualityScore, Part 11), kept
-- separate rather than overloading either existing column so neither of
-- those older signals' own meaning changes underneath any existing
-- reader.
alter table public.listings add column if not exists inventory_quality_score double precision;

-- Part 12 lifecycle — when a listing's continued availability was last
-- confirmed. Distinct from last_checked_at (already present above, used
-- by the existing sold/unavailable-detection cron,
-- src/app/api/cron/check-listing-status) — last_verified_at is this
-- NEW inventory-intelligence layer's own freshness signal (fed into
-- inventory_quality_score's freshness term), not a replacement for that
-- cron's own bookkeeping column.
alter table public.listings add column if not exists last_verified_at timestamptz;

-- 'expired' is new (Part 12's pending/active/expired/removed lifecycle);
-- every existing value (sold/unavailable/rejected/removed) is kept
-- exactly as-is — this widens the set, it doesn't replace it, so nothing
-- that already relies on those existing statuses (Discover/Feed's own
-- `status = 'active'` filters, admin moderation, order fulfillment)
-- changes meaning.
alter table public.listings drop constraint if exists listings_status_check;
alter table public.listings
  add constraint listings_status_check
  check (status in ('active', 'sold', 'unavailable', 'pending', 'rejected', 'removed', 'expired'));

-- Part 8's requested indexes — status/created_at already have indexes
-- elsewhere in this file for other reasons; added here specifically for
-- the inventory-intelligence dashboard's own bounded queries
-- (getInventoryIntelligenceStats) and the quality-score/image-hash
-- lookups duplicate-detection.ts and the admin dashboard both do.
create index if not exists listings_inventory_quality_score_idx on public.listings (inventory_quality_score desc);
create index if not exists listings_image_hash_idx on public.listings (image_hash);
create index if not exists listings_created_at_idx on public.listings (created_at desc);

-- ivfflat index for visual_embedding's pgvector KNN search (Part 10) —
-- cosine distance (vector_cosine_ops) since that's what
-- compareImageSimilarity (src/lib/image-similarity.ts) already uses for
-- the plain-array embeddings elsewhere in this codebase, kept consistent
-- rather than mixing distance metrics between the two embedding paths.
-- ivfflat (not hnsw) needs `lists` tuned to table size — 100 is a
-- reasonable starting point around the 100k-listing milestone this
-- feature targets; this is the one part of this migration worth
-- revisiting as inventory actually grows toward 500k/1M (larger `lists`,
-- or switching to hnsw, which pgvector also supports and doesn't need a
-- `lists` parameter at all).
create index if not exists listings_visual_embedding_idx
  on public.listings using ivfflat (visual_embedding vector_cosine_ops) with (lists = 100);

-- pgvector KNN search as a real Postgres function (Part 10) — "do NOT
-- scan all listings": the `<=>` operator + this index is what makes this
-- an actual nearest-neighbor lookup bounded by match_count, not a
-- full-table scan scored in application code. security invoker (not
-- definer) since this only reads already-RLS-visible rows anyway
-- (listings has a public "viewable by everyone" select policy).
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

-- ---------------------------------------------------------------------------
-- AI Enrichment Queue (Part 6) — decouples scraping from AI analysis: a
-- listing lands in `listings` (status='pending') the moment it's
-- scraped/imported, completely independent of whether/when it gets
-- visually analyzed. src/lib/inventory/enrichment-queue.ts enqueues one
-- row per newly-imported listing and src/lib/inventory/inventory-indexer.ts
-- (Part 3) processes this queue in its own bounded batches, on its own
-- schedule — scraping never waits on it.
-- ---------------------------------------------------------------------------

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

-- One outstanding queue row per listing — re-enqueuing an already-queued
-- listing (e.g. a re-triggered index run) updates the existing row
-- instead of creating a duplicate job for the same listing.
create unique index if not exists listing_enrichment_queue_listing_id_idx
  on public.listing_enrichment_queue (listing_id);
create index if not exists listing_enrichment_queue_status_idx
  on public.listing_enrichment_queue (status, created_at);

alter table public.listing_enrichment_queue enable row level security;

drop policy if exists "Enrichment queue is viewable by admins" on public.listing_enrichment_queue;
create policy "Enrichment queue is viewable by admins"
  on public.listing_enrichment_queue for select
  using (public.is_admin());

-- No insert/update/delete policy for the authenticated role — only ever
-- written by the admin-triggered indexer via the service-role client,
-- same pattern as scraper_jobs/ingestion_jobs above.

-- ---------------------------------------------------------------------------
-- Continuous Marketplace Inventory Discovery (src/lib/marketplace-ingestion/)
-- — job tracking for runIngestionSource() (registry.ts), the same
-- "one row per run, with the counts an operator would want to see"
-- convention src/lib/admin-scraper.ts's own scraper_jobs table already
-- established for Lockette's admin-triggered imports. One row per
-- ingestion run, one run per source.
-- ---------------------------------------------------------------------------

create table if not exists public.ingestion_jobs (
  id uuid primary key default gen_random_uuid(),
  -- Same vocabulary as marketplace_listings.source_platform /
  -- src/lib/marketplaces/types.ts's MarketplaceSource.
  source text not null,
  started_at timestamptz not null default now(),
  -- Null while the run is in progress — a caller can tell "still
  -- running" from "finished" without a separate status column.
  completed_at timestamptz,
  listings_found integer,
  listings_imported integer,
  -- One entry per provider-level failure encountered during the run
  -- (a single bad listing shouldn't abort the whole job) — empty array,
  -- not null, once the run completes; null only while still in progress.
  errors text[]
);

alter table public.ingestion_jobs enable row level security;

-- Operational data, not user-specific — admin-only, same pattern
-- scraper_jobs itself already uses.
drop policy if exists "Ingestion jobs are viewable by admins" on public.ingestion_jobs;
create policy "Ingestion jobs are viewable by admins"
  on public.ingestion_jobs for select
  using (public.is_admin());

-- No insert/update/delete policy for the authenticated role — only ever
-- written by runIngestionSource() via the service-role admin client,
-- same as marketplace_listings above.

-- ---------------------------------------------------------------------------
-- "Scraped listings go live automatically" ingestion change — 'flagged' is
-- the new default safety-net status (src/lib/inventory/listing-flagging.ts's
-- flagListing()), replacing 'pending' as the primary state a new import
-- lands in. 'pending' itself is kept in the allowed set (existing rows,
-- and anything that still sets it, stay valid) — it just isn't written by
-- the three insert sites anymore. See
-- supabase/migrations/20260728063000_add_listing_flagging.sql, which is
-- what actually applies this against a live database (this file is the
-- reference document, not something anything runs automatically).
--
-- Both `status_check` and `listings_status_check` are dropped before
-- re-adding — confirmed live that this table's actual constraint name is
-- `status_check`, not `listings_status_check` as every earlier block in
-- this file assumed (this whole file has apparently never been run
-- against the live database for this constraint at all — see that
-- migration's own comment for how this was confirmed). Covering both
-- names makes this correct regardless of which one a given database
-- actually has.
-- ---------------------------------------------------------------------------
alter table public.listings add column if not exists flag_reason text;

alter table public.listings drop constraint if exists status_check;
alter table public.listings drop constraint if exists listings_status_check;
alter table public.listings
  add constraint listings_status_check
  check (status in ('active', 'sold', 'unavailable', 'pending', 'flagged', 'rejected', 'removed', 'expired'));
