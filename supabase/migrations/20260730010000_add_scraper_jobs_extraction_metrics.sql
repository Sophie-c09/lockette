-- Inventory Growth/Bulk Importer architecture-parity fix — dashboard
-- requirements "URLs extracted successfully" and "extraction failures by
-- reason": extracted_successfully_count is extraction attempts that
-- produced real data (a title AND at least one image); Extraction attempts
-- that threw or came back empty are not counted here but ARE reflected in
-- extraction_failures_by_reason, a JSON map of failure reason -> count (a
-- thrown error's message, or "extracted_but_empty" for a non-throwing but
-- empty result) — both sourced from PipelineFunnel.getCounts()
-- (src/lib/pipeline-debug.ts), not a second parallel counting mechanism.
--
-- Verified directly against the live database before writing this file:
-- `select extracted_successfully_count from scraper_jobs limit 1` and
-- `select extraction_failures_by_reason from scraper_jobs limit 1` both
-- fail with 42703 "column does not exist" — brand new columns, same as
-- insert_failed_count in the migration just before this one.
alter table public.scraper_jobs add column if not exists extracted_successfully_count integer not null default 0;
alter table public.scraper_jobs add column if not exists extraction_failures_by_reason jsonb not null default '{}'::jsonb;
