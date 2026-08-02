-- P0 launch-readiness fix (dead-listing cleanup): the check-listing-status
-- cron previously flipped a listing to 'unavailable' on a SINGLE sold/
-- removed signal, with no memory of prior checks — a transient false
-- positive (a page that briefly rendered an ambiguous "out of stock"
-- banner, a promo banner containing one of the phrase matches, etc.)
-- could remove a genuinely still-active listing with no way to tell how
-- many times it had actually been confirmed gone. These four columns let
-- the cron require several CONSECUTIVE unavailable signals (never reset
-- by an inconclusive/blocked check — see that route's own comment) before
-- actually marking a listing unavailable, and give an admin real data to
-- decide whether to manually restore one that was.
--
-- last_checked_at already exists (see the original migration) — these are
-- new, additive columns only.
alter table public.listings add column if not exists last_available_at timestamptz;
alter table public.listings add column if not exists availability_check_count integer not null default 0;
alter table public.listings add column if not exists consecutive_unavailable_checks integer not null default 0;
alter table public.listings add column if not exists removal_reason text;

comment on column public.listings.last_available_at is
  'Last time check-listing-status ran and did NOT get a confirmed-unavailable signal (a genuine "still in stock" confirmation, a blocked/inconclusive fetch, or no signal at all all count — see that route''s own "never guess" philosophy). Distinct from last_checked_at, which stamps on every run regardless of outcome.';
comment on column public.listings.availability_check_count is
  'Total number of times check-listing-status has actually run a real check against this listing (not counting rows skipped for having no product_url).';
comment on column public.listings.consecutive_unavailable_checks is
  'Consecutive unavailable signals with no inconclusive/available result in between — resets to 0 the moment a check does not return "unavailable". Only reaching CONSECUTIVE_UNAVAILABLE_THRESHOLD (see check-listing-status/route.ts) actually flips status.';
comment on column public.listings.removal_reason is
  'Human-readable reason a listing was marked unavailable/removed by the availability-check cron (e.g. the matched phrase or JSON-LD value) — distinct from flag_reason, which is set by flagListing() at INSERT time for a different purpose.';
