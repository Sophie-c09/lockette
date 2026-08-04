-- Style Bundle retry support. attempt_count/last_attempt_at were already
-- present on the LIVE styled_bundles table (confirmed by direct
-- inspection while diagnosing the "Try again" production failure) but
-- were never recorded in this repo's schema.sql/migrations — a real,
-- pre-existing drift between the documented schema and the live
-- database. This migration is purely to bring schema.sql/migrations back
-- in sync with what's already there; `add column if not exists` makes it
-- a genuine no-op against the live database, and additive/safe against
-- any other environment (a fresh database, a staging project) that
-- doesn't have these columns yet.
--
-- No new "failed"/error_code/error_message/failed_at columns are added:
-- styled_bundles.status already has a truthful 'error' state, and
-- generation_error already stores a safe, user-facing failure reason —
-- the schema already represents failure truthfully. attempt_count/
-- last_attempt_at (this migration) are the only genuinely missing piece,
-- needed for retryBundleGeneration (src/app/actions/style-requests.ts) to
-- cap repeated attempts.
alter table public.styled_bundles add column if not exists attempt_count integer not null default 0;
alter table public.styled_bundles add column if not exists last_attempt_at timestamptz;
