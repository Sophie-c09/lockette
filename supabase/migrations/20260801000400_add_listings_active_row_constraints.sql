-- P0 launch-readiness fix (inventory quality, DB-level backstop) — this
-- app's own architecture DELIBERATELY inserts a listing that fails
-- flagListing()'s checks as status='flagged' rather than rejecting the
-- insert outright (see src/lib/inventory/listing-flagging.ts's own header
-- comment: "Scraped listings go live automatically unless flagged" — a
-- flagged row with a bad price/title/image sitting in the moderation
-- queue is intentional, not a bug). A blanket `check (price > 0)` would
-- make that architecture impossible to insert at all. These constraints
-- are conditional on status = 'active' instead — exactly matching the
-- actual requirement ("a PUBLIC listing must not appear unless...") without
-- breaking the flagging design.
--
-- NOT VALID: does not retroactively check existing rows (this database may
-- already have an 'active' row with bad data from before any of this
-- session's ingestion-pipeline fixes existed) — only NEW inserts/updates
-- are checked from this point on. Safe migration strategy per this
-- feature's own "do not add constraints that would break existing valid
-- rows" requirement; existing bad rows can be cleaned up separately by an
-- admin without this migration itself failing.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'listings_active_requires_valid_price') then
    alter table public.listings
      add constraint listings_active_requires_valid_price
      check (status <> 'active' or (price is not null and price > 0))
      not valid;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'listings_active_requires_title') then
    alter table public.listings
      add constraint listings_active_requires_title
      check (status <> 'active' or (title is not null and length(trim(title)) > 0))
      not valid;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'listings_active_requires_image') then
    alter table public.listings
      add constraint listings_active_requires_image
      check (status <> 'active' or (image_url is not null and length(trim(image_url)) > 0))
      not valid;
  end if;
end $$;

-- P0 launch-readiness fix (duplicate protection, DB-level backstop) — app
-- code (bulk-import.ts/admin-scraper.ts/import-listing/route.ts, all via
-- duplicate-detection.ts's checkForDuplicate as of this same launch-
-- readiness pass) already checks product_url before inserting, but
-- nothing at the DB level has ever enforced it — confirmed no unique
-- constraint or index exists on `listings.product_url` at all. A PARTIAL
-- unique index (scoped to status = 'active' only, not the whole table) is
-- the safe choice here: it enforces "no two ACTIVE listings share the same
-- product_url" — the actual requirement — without blocking legitimate
-- historical data where a duplicate might already exist across different
-- statuses (a 'removed'/'rejected' row alongside the one 'active' survivor
-- is fine and expected, this app never deletes rows).
--
-- Dedup FIRST — if two 'active' rows already share a product_url (a real
-- possibility given the gaps this launch-readiness pass found in the
-- pre-existing dedup logic), creating the index would fail outright
-- otherwise. Keeps the earliest 'active' row per product_url, demotes the
-- rest to 'rejected' (never deletes — matches this app's own "just change
-- status" convention, see adminListingRemoval.ts's own comment) rather
-- than silently dropping them.
update public.listings a
set status = 'rejected'
where a.status = 'active'
  and a.product_url is not null
  and exists (
    select 1 from public.listings b
    where b.status = 'active'
      and b.product_url = a.product_url
      and b.id < a.id
  );

create unique index if not exists listings_active_product_url_unique
  on public.listings (product_url)
  where status = 'active';
