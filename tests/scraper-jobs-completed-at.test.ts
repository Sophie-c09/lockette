// Covers the Inventory Growth startup fix — production error: "Failed to
// start inventory growth: Could not find the 'completed_at' column of
// 'scraper_jobs' in the schema cache". Root cause: createLargeScaleScraperJob
// (scraper-jobs.ts) put completed_at in its bottom-most fallback tier, with
// no narrower tier beneath it, breaking the graceful-degradation pattern
// every other write in this file already uses. Source-level assertions,
// same convention as scraper-jobs-batch-lease.test.ts and
// inventory-db-constraints.test.ts — these functions need a real Supabase
// table to exercise the actual insert/fallback behavior, which this
// project avoids depending on in an automated test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const scraperJobsSource = readFileSync(join(__dirname, "..", "src", "lib", "scraper-jobs.ts"), "utf-8");
const migrationSource = readFileSync(
  join(__dirname, "..", "supabase", "migrations", "20260803000000_add_scraper_jobs_completed_at.sql"),
  "utf-8",
);
const typesSource = readFileSync(join(__dirname, "..", "src", "lib", "supabase", "scraper-jobs.types.ts"), "utf-8");

function fnBody(source: string, name: string, nextName?: string): string {
  const start = source.indexOf(`export async function ${name}`);
  assert.ok(start > -1, `expected to find export async function ${name}`);
  const end = nextName ? source.indexOf(`export async function ${nextName}`) : start + 4000;
  return source.slice(start, end > -1 ? end : undefined);
}

test("ROOT CAUSE REGRESSION: createLargeScaleScraperJob has a bare-minimum fallback tier that excludes completed_at/error_message", () => {
  const body = fnBody(scraperJobsSource, "createLargeScaleScraperJob", "updateLargeScaleScraperJobProgress");
  assert.match(body, /const bareMinimumPayload = \{/);
  const bareMinimumBlock = body.slice(body.indexOf("const bareMinimumPayload"), body.indexOf("const corePayload"));
  assert.doesNotMatch(bareMinimumBlock, /completed_at/);
  assert.doesNotMatch(bareMinimumBlock, /error_message/);
});

test("createLargeScaleScraperJob falls all the way through to bareMinimumPayload when every richer tier fails on a missing column", () => {
  const body = fnBody(scraperJobsSource, "createLargeScaleScraperJob", "updateLargeScaleScraperJobProgress");
  const tierInserts = [...body.matchAll(/\.insert\((\w+)\)\.select\(\)\.single\(\)/g)].map((m) => m[1]);
  assert.deepEqual(tierInserts, ["fullPayload", "trackedPayload", "corePayload", "bareMinimumPayload"]);
});

test("every tier is a strict superset of the one below it (fullPayload spreads trackedPayload, which spreads corePayload, which spreads bareMinimumPayload)", () => {
  const body = fnBody(scraperJobsSource, "createLargeScaleScraperJob", "updateLargeScaleScraperJobProgress");
  assert.match(body, /const corePayload = \{\s*\.\.\.bareMinimumPayload,/);
  assert.match(body, /const trackedPayload = \{\s*\.\.\.corePayload,/);
  assert.match(body, /const fullPayload = \{ \.\.\.trackedPayload,/);
});

test("createLargeScaleScraperJob only gives up (returns job: null) once bareMinimumPayload itself fails, never before", () => {
  const body = fnBody(scraperJobsSource, "createLargeScaleScraperJob", "updateLargeScaleScraperJobProgress");
  const giveUpIndex = body.indexOf("if (error || !data) {");
  const bareMinimumInsertIndex = body.indexOf('.insert(bareMinimumPayload)');
  assert.ok(bareMinimumInsertIndex > -1 && giveUpIndex > bareMinimumInsertIndex);
});

test("completed_at is explicitly cleared to null on a freshly-created large-scale job (never inherited from a prior row)", () => {
  const body = fnBody(scraperJobsSource, "createLargeScaleScraperJob", "updateLargeScaleScraperJobProgress");
  assert.match(body, /completed_at: null,/);
});

test("completed_at is set on successful completion via completeScraperJob", () => {
  const body = fnBody(scraperJobsSource, "completeScraperJob", "recoverStaleLargeScaleJob");
  assert.match(body, /status: "completed", inserted_count: insertedCount, completed_at: nowIso/);
});

test("completed_at is set on terminal failure via failScraperJob — 'failed' is a real terminal state in this lifecycle", () => {
  const body = fnBody(scraperJobsSource, "failScraperJob");
  assert.match(body, /status: "failed", error_message: errorMessage, completed_at: nowIso/);
});

test("resuming a paused job (claimJobForResume) never sets or clears completed_at — a paused job never had it set in the first place", () => {
  // End marker is resumeFalselyFailedZeroProgressJob, not claimBatchLease —
  // the zero-progress false-failure recovery function now sits between
  // the two (it legitimately clears completed_at for a DIFFERENT,
  // 'failed'-status recovery case, which must not leak into this
  // assertion about claimJobForResume's own body).
  const body = fnBody(scraperJobsSource, "claimJobForResume", "resumeFalselyFailedZeroProgressJob");
  assert.doesNotMatch(body, /completed_at/);
});

test("pausing a job (pauseScraperJobRow) never touches completed_at", () => {
  const body = fnBody(scraperJobsSource, "pauseScraperJobRow", "claimJobForResume");
  assert.doesNotMatch(body, /completed_at/);
});

test("completed_at is never used as the batch-lease timestamp — batch_lease_expires_at is a distinct field", () => {
  const body = fnBody(scraperJobsSource, "claimBatchLease", "releaseBatchLease");
  assert.doesNotMatch(body, /completed_at/);
  assert.match(body, /batch_lease_expires_at/);
});

test("completeScraperJob/failScraperJob still degrade gracefully if completed_at/updated_at are missing (pre-migration safety net)", () => {
  const completeBody = fnBody(scraperJobsSource, "completeScraperJob", "recoverStaleLargeScaleJob");
  assert.match(completeBody, /isMissingColumnError\(error\)/);
  assert.match(completeBody, /\.update\(\{ status: "completed", inserted_count: insertedCount \}\)/);

  const failBody = fnBody(scraperJobsSource, "failScraperJob");
  assert.match(failBody, /isMissingColumnError\(error\)/);
  assert.match(failBody, /\.update\(\{ status: "failed", error_message: errorMessage \}\)/);
});

test("the completed_at migration exists, is idempotent, nullable, and documents its purpose with a column comment", () => {
  assert.match(migrationSource, /add column if not exists completed_at timestamptz;/);
  assert.doesNotMatch(migrationSource, /not null/);
  assert.doesNotMatch(migrationSource, /update public\.scraper_jobs/i); // no backfill of existing rows
  assert.match(migrationSource, /comment on column public\.scraper_jobs\.completed_at is/);
});

test("local scraper_jobs TypeScript types already declare completed_at on Row/Insert/Update", () => {
  const rowBlock = typesSource.slice(typesSource.indexOf("Row: {"), typesSource.indexOf("Insert: {"));
  const insertBlock = typesSource.slice(typesSource.indexOf("Insert: {"), typesSource.indexOf("Update: {"));
  const updateBlock = typesSource.slice(typesSource.indexOf("Update: {"), typesSource.indexOf("Relationships:"));
  assert.match(rowBlock, /completed_at: string \| null;/);
  assert.match(insertBlock, /completed_at\?: string \| null;/);
  assert.match(updateBlock, /completed_at\?: string \| null;/);
});
