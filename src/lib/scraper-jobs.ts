// Shared DB access for the Style-Aware Scraper's background job tracking
// (scraper_jobs, see supabase/schema.sql) — used by both
// src/app/api/admin-scraper/run/route.ts (the only writer, via
// createAdminClient() since there's no authenticated-role write policy
// on this table) and src/app/actions/admin-scraper.ts's getScraperJobStatus
// (the polling read the admin UI calls every couple of seconds).
//
// ROOT CAUSE OF THE "scraper stuck at running forever, zero results" BUG:
// the live `scraper_jobs` table was found (via direct querying) to be
// missing the `completed_at` column this file's completeScraperJob/
// failScraperJob always tried to write — every single call to either
// function failed outright with a Postgres "column not found" error
// (PGRST204), which was only ever logged (console.error), never
// propagated. The job row's `status` therefore NEVER advanced past
// 'running', no matter what actually happened in runAdminScraper (finish
// cleanly with 0 results, finish with real results, or throw) — from the
// admin UI's perspective, polling a job that can physically never change
// status again looks exactly like an infinite hang, even on a run that
// silently succeeded or failed in seconds. The live table also turned out
// to have EXTRA columns this codebase never defined (target_count,
// current_round, checkpoint, last_heartbeat, updated_at) — i.e. it was
// created by something other than this repo's own supabase/schema.sql.
// Every write below now degrades gracefully instead of assuming the
// schema this file expects and the live table's actual columns agree.
import { createAdminClient } from "@/lib/supabase/admin";
import type { ScraperJobRow, ScraperJobsDatabase } from "@/lib/supabase/scraper-jobs.types";
import { STALE_JOB_RECOVERY_THRESHOLD_MS } from "@/lib/scraper-config";

export type { ScraperJobRow };

// Same "is this a not-yet-migrated/mismatched column" detection used
// throughout this codebase (admin-scraper.ts, /api/import-listing/route.ts)
// — duplicated rather than imported since none of those export it, matching
// this codebase's existing per-module convention for this exact check.
function isMissingColumnError(error: { code?: string; message: string }): boolean {
  return error.code === "PGRST204" || /column .* does not exist/i.test(error.message);
}

// Required, exact-shape log around every Inventory Growth status
// transition (see this file's own callers of this helper) — the
// "job silently starts Paused" investigation had no way to tell, from
// logs alone, WHEN a job's status actually changed, WHY, or whether a
// pause was ever really requested versus inferred (stale-heartbeat
// recovery, a startup exception, etc). `from` is best-effort: some call
// sites (pauseScraperJobRow) read the row first specifically to report
// it accurately; others (createLargeScaleScraperJob) have no prior state
// at all and pass `null`.
function logJobStatusTransition(params: {
  jobId: string;
  from: string | null;
  to: string;
  reason: string;
  pauseRequested: boolean;
}): void {
  console.info("[INVENTORY_GROWTH][STATUS]", {
    jobId: params.jobId,
    from: params.from,
    to: params.to,
    reason: params.reason,
    pauseRequested: params.pauseRequested,
    timestamp: new Date().toISOString(),
  });
}

// How long a large-scale job gets, from its own created_at, before the
// stale-heartbeat recovery check (recoverStaleLargeScaleJob, below) is
// even allowed to consider it — a job legitimately has NO heartbeat yet
// for the brief window between being created and its first successful
// progress write (or, on a database missing updated_at/last_heartbeat
// entirely, forever). Without this grace period, recoverStaleLargeScaleJob
// falls back to `created_at` as `lastSignal`, and any read of a job that
// races ahead of its own first heartbeat write reads an "age" that's only
// as small as the DB round-trip took — that's still correctly under
// STALE_JOB_RECOVERY_THRESHOLD_MS, so this isn't why a job at age zero
// would ever be treated as stale — but it's cheap, real insurance against
// exactly that class of race (clock skew between app/DB servers, a slow
// first write, a future field this function starts trusting), and it's
// what makes requirement 3/5's "must not treat a job in its startup phase
// as paused" true independent of the exact timing of the first heartbeat.
const STARTUP_GRACE_PERIOD_MS = 2 * 60 * 1000; // 2 minutes

export async function createScraperJob(requestedCount: number): Promise<{ job: ScraperJobRow | null; error?: string }> {
  const supabase = createAdminClient<ScraperJobsDatabase>();
  const { data, error } = await supabase
    .from("scraper_jobs")
    .insert({ requested_count: requestedCount, status: "queued" })
    .select()
    .single();

  if (error || !data) {
    console.error("[scraper-jobs] Failed to create job:", error);
    return { job: null, error: error?.message ?? "Failed to create scraper job." };
  }

  console.log(`[scraper-jobs] Job created: ${data.id} (requested ${requestedCount})`);
  return { job: data };
}

export async function markScraperJobRunning(jobId: string): Promise<void> {
  const supabase = createAdminClient<ScraperJobsDatabase>();
  const nowIso = new Date().toISOString();

  let { error } = await supabase
    .from("scraper_jobs")
    .update({ status: "running", updated_at: nowIso, last_heartbeat: nowIso })
    .eq("id", jobId);

  if (error && isMissingColumnError(error)) {
    ({ error } = await supabase.from("scraper_jobs").update({ status: "running" }).eq("id", jobId));
  }

  if (error) {
    console.error("[scraper-jobs] Failed to mark job running:", jobId, error);
  } else {
    console.log(`[scraper-jobs] Job ${jobId} marked running`);
  }
}

export interface ScraperJobProgressUpdate {
  scrapedCount: number;
  scoredCount: number;
  passedCount: number;
  insertedCount: number;
  // Both optional/best-effort — see this file's own header comment on why
  // a database might not have error_count/last_url yet.
  errorCount?: number;
  lastProcessedUrl?: string | null;
}

// Doubles as this job's heartbeat — called once per round (see
// runAdminScraper's onProgress callback), which is exactly the signal a
// stale-job check needs: if `last_heartbeat`/`updated_at` hasn't moved in
// several minutes, the job is provably not making progress anymore
// (crashed process, unhandled hang, etc.), regardless of what `status`
// still says. updated_at/last_heartbeat are written best-effort — a
// database without those columns (see this file's own header comment)
// still gets its counts updated correctly, it just can't support
// staleness detection.
export async function updateScraperJobProgress(jobId: string, progress: ScraperJobProgressUpdate): Promise<void> {
  const supabase = createAdminClient<ScraperJobsDatabase>();
  const nowIso = new Date().toISOString();

  // Core fields every known version of this table (including the
  // mismatched live one this bug's investigation found) is guaranteed to
  // have — see this file's own header comment.
  const corePayload = {
    status: "running" as const,
    scraped_count: progress.scrapedCount,
    scored_count: progress.scoredCount,
    passed_count: progress.passedCount,
    inserted_count: progress.insertedCount,
  };

  // updated_at/last_heartbeat are the heartbeat this job's staleness check
  // (see ImportListingView.tsx's isJobStale) depends on — tried as their
  // OWN fallback tier, separate from error_count/last_url, so a database
  // that has the former but not the latter (exactly what this bug's
  // investigation found live) still gets a working heartbeat on every
  // round instead of only once (from markScraperJobRunning) for the whole
  // run. Dropping all four at once the moment ANY one is missing would
  // silently make every later round's "is this job still alive" check
  // look stale even on a perfectly healthy run.
  const heartbeatPayload = { ...corePayload, updated_at: nowIso, last_heartbeat: nowIso };
  const fullPayload = {
    ...heartbeatPayload,
    ...(progress.errorCount != null ? { error_count: progress.errorCount } : {}),
    ...(progress.lastProcessedUrl != null ? { last_url: progress.lastProcessedUrl } : {}),
  };

  let { error } = await supabase.from("scraper_jobs").update(fullPayload).eq("id", jobId);
  let wrote = "status/counts + heartbeat + error_count/last_url";

  if (error && isMissingColumnError(error)) {
    ({ error } = await supabase.from("scraper_jobs").update(heartbeatPayload).eq("id", jobId));
    wrote = "status/counts + heartbeat only (error_count/last_url column(s) missing)";
  }

  if (error && isMissingColumnError(error)) {
    ({ error } = await supabase.from("scraper_jobs").update(corePayload).eq("id", jobId));
    wrote = "status/counts only (heartbeat column(s) missing too)";
  }

  if (error) {
    console.error("[scraper-jobs] Failed to update job progress:", jobId, error);
  } else {
    console.log(
      `[scraper-jobs] Job ${jobId} progress (wrote: ${wrote}) — scraped ${progress.scrapedCount}, ` +
        `scored ${progress.scoredCount}, passed ${progress.passedCount}, inserted ${progress.insertedCount}` +
        (progress.errorCount != null ? `, errors ${progress.errorCount}` : "") +
        (progress.lastProcessedUrl ? `, last URL: ${progress.lastProcessedUrl}` : ""),
    );
  }
}

export async function completeScraperJob(jobId: string, insertedCount: number): Promise<void> {
  const supabase = createAdminClient<ScraperJobsDatabase>();
  const nowIso = new Date().toISOString();

  let { error } = await supabase
    .from("scraper_jobs")
    .update({ status: "completed", inserted_count: insertedCount, completed_at: nowIso, updated_at: nowIso })
    .eq("id", jobId);

  if (error && isMissingColumnError(error)) {
    console.warn(
      "[scraper-jobs] completed_at/updated_at not found on this database's scraper_jobs table — " +
        "retrying with just status+inserted_count so the job doesn't get stuck at 'running' forever.",
    );
    ({ error } = await supabase
      .from("scraper_jobs")
      .update({ status: "completed", inserted_count: insertedCount })
      .eq("id", jobId));
  }

  if (error) {
    console.error("[scraper-jobs] Failed to mark job completed:", jobId, error);
  } else {
    console.log(`[scraper-jobs] Job ${jobId} completed (inserted ${insertedCount})`);
    logJobStatusTransition({ jobId, from: "running", to: "completed", reason: "target_reached", pauseRequested: false });
  }
}

// ---------------------------------------------------------------------------
// Large-scale continuous ingestion job tracking — additive to everything
// above (createScraperJob/markScraperJobRunning/updateScraperJobProgress/
// completeScraperJob/failScraperJob are all unchanged and still used by the
// existing Style-Aware Scraper and Continuous Import admin UI cards).
// ---------------------------------------------------------------------------

/**
 * Stale-job recovery — a large-scale job whose last_heartbeat is older
 * than STALE_JOB_RECOVERY_THRESHOLD_MS is treated as dead rather than
 * "running": added after a real job (target 50,000, batch 20/86) was
 * found stuck at status='running' with its heartbeat frozen for 40+
 * minutes and no error ever recorded — nothing already in this file
 * (retry counts, consecutive-failure counts) can fire again once the
 * process that was supposed to advance those has itself gone silent.
 *
 * Recovers to 'paused' rather than a new 'failed'/'interrupted' status:
 * this database's scraper_jobs_status_check constraint (supabase/schema.sql)
 * only allows 'pending' | 'queued' | 'running' | 'paused' | 'completed' |
 * 'failed', and 'paused' already has fully-working "preserve checkpoint,
 * resumable via the existing /api/admin-scraper/large-scale resume path"
 * semantics in this exact codebase — reusing it needs no schema migration
 * and no changes to claimJobForResume/the resume path itself. Every
 * counter/checkpoint column is left untouched; only `status` changes.
 *
 * The `.eq("status", job.status)` guard mirrors claimJobForResume's own
 * optimistic-concurrency pattern — only claims the row if its status
 * hasn't changed since it was read (e.g. it didn't just complete/get
 * paused by the admin a moment ago).
 */
export async function recoverStaleLargeScaleJob(job: ScraperJobRow): Promise<ScraperJobRow> {
  if (job.status !== "running" && job.status !== "pending") return job;

  // Startup grace period (see STARTUP_GRACE_PERIOD_MS's own comment) —
  // checked against created_at UNCONDITIONALLY, before even looking at
  // last_heartbeat/updated_at: a job in its first couple of minutes of
  // life is in its startup phase almost by definition, and must never be
  // recovered to 'paused' no matter what its heartbeat fields say (or
  // don't say yet).
  const ageSinceCreatedMs = Date.now() - new Date(job.created_at).getTime();
  if (ageSinceCreatedMs <= STARTUP_GRACE_PERIOD_MS) return job;

  const lastSignal = job.last_heartbeat ?? job.updated_at ?? job.created_at;
  const ageMs = Date.now() - new Date(lastSignal).getTime();
  if (ageMs <= STALE_JOB_RECOVERY_THRESHOLD_MS) return job;

  console.warn(
    `[scraper-jobs] Job ${job.id} stale — no heartbeat in ${Math.round(ageMs / 1000)}s ` +
      `(threshold ${STALE_JOB_RECOVERY_THRESHOLD_MS / 1000}s). Recovering to 'paused' so its checkpoint ` +
      "stays resumable instead of leaving it stuck at 'running' forever.",
  );

  const supabase = createAdminClient<ScraperJobsDatabase>();
  const { data, error } = await supabase
    .from("scraper_jobs")
    .update({ status: "paused" })
    .eq("id", job.id)
    .eq("status", job.status)
    .select()
    .maybeSingle();

  if (error) {
    console.error("[scraper-jobs] Failed to recover stale job:", job.id, error);
    return job;
  }

  if (data) {
    logJobStatusTransition({
      jobId: job.id,
      from: job.status,
      to: "paused",
      reason: "stale_heartbeat_recovery",
      pauseRequested: false,
    });
  }

  return data ?? job;
}

/**
 * Concurrency guard for Inventory Growth — finds an existing large-scale
 * job that's still active, so the API route can refuse to start a second
 * one concurrently (see /api/admin-scraper/large-scale/route.ts's own
 * check). Checks BOTH 'pending' and 'running', not just 'running':
 * createLargeScaleScraperJob (below) always creates a large-scale job
 * with status 'pending', and updateLargeScaleScraperJobProgress
 * deliberately never writes `status` at all anymore (see that function's
 * own header comment — it used to silently un-pause an already-paused job
 * the moment its next progress write landed) — so 'pending' is what an
 * actively-running large-scale job's status looks like for its entire
 * life, from creation through completion/failure/pause. 'running' is only
 * still checked here because rows created before that fix can still carry
 * it; a literal "status = running" check alone would never match any job
 * created since, making this guard a no-op for current and future runs.
 * Paused/completed/failed jobs are correctly NOT matched — those are
 * exactly the states a new run (or a resume) is allowed to start from.
 */
export async function getActiveLargeScaleJob(): Promise<ScraperJobRow | null> {
  const supabase = createAdminClient<ScraperJobsDatabase>();

  const { data, error } = await supabase
    .from("scraper_jobs")
    .select("*")
    .not("target_count", "is", null)
    .in("status", ["pending", "running"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    // Best-effort, same "a broken check must never block the real feature"
    // posture as this file's other read paths (e.g. getScraperJobRow) —
    // fails open (treated as "no active job found") rather than refusing
    // every future Start click just because this one lookup errored.
    console.error("[scraper-jobs] Failed to check for an active large-scale job:", error);
    return null;
  }

  if (!data) return null;

  // Stale-job recovery — see recoverStaleLargeScaleJob's own header
  // comment. A job recovered to 'paused' here is correctly no longer
  // "active": this mirrors the existing behavior just below for any
  // other already-paused job, letting a fresh Start proceed instead of
  // permanently refusing it with "Inventory Growth is already running"
  // for a run that has actually gone silent.
  const recovered = await recoverStaleLargeScaleJob(data);
  return recovered.status === "paused" ? null : recovered;
}

export async function createLargeScaleScraperJob(
  targetCount: number,
  totalBatches: number,
  mode: string,
): Promise<{ job: ScraperJobRow | null; error?: string }> {
  const supabase = createAdminClient<ScraperJobsDatabase>();
  const nowIso = new Date().toISOString();

  // Three tiers, each a STRICT superset of the one below it, so a column
  // missing from one tier can never take down a column that's actually
  // writable — the bug this replaces bundled target_count (which the live
  // table already had) together with total_batches/mode (which it didn't),
  // so the whole insert failed and the fallback dropped target_count too
  // even though nothing was wrong with that column.
  //
  // completed_at/error_message are explicitly cleared here (requirement 1:
  // "Starting Inventory Growth must always create... into a runnable
  // state") even though this is a brand-new row that could never have had
  // either set — cheap insurance against a future change that starts this
  // job from an existing row instead. last_heartbeat/updated_at are set to
  // NOW at creation time, in the SAME tier as target_count/current_round
  // (the exact group of columns this file's own header comment confirms
  // arrived together on the live table) — this is what closes the window
  // where recoverStaleLargeScaleJob could otherwise see a job with no
  // heartbeat at all yet and fall back to created_at alone; a fresh job
  // now always has a real, current heartbeat the instant it exists,
  // independent of when/whether the follow-up checkpoint write lands.
  const corePayload = {
    requested_count: targetCount,
    status: "pending" as const,
    completed_at: null,
    error_message: null,
  };
  const trackedPayload = {
    ...corePayload,
    target_count: targetCount,
    current_round: 0,
    last_heartbeat: nowIso,
    updated_at: nowIso,
  };
  const fullPayload = { ...trackedPayload, total_batches: totalBatches, mode };

  let { data, error } = await supabase.from("scraper_jobs").insert(fullPayload).select().single();
  let wrote = "full (target_count + total_batches + mode + current_round)";

  if (error && isMissingColumnError(error)) {
    console.warn(
      `[scraper-jobs] Large-scale job create: full tier failed (${error.message}) — ` +
        "total_batches/mode not found on this database yet, falling back to target_count + current_round only. " +
        "Run the latest supabase/schema.sql to enable full progress tracking.",
    );
    wrote = "tracked (target_count + current_round only — total_batches/mode column(s) missing)";
    ({ data, error } = await supabase.from("scraper_jobs").insert(trackedPayload).select().single());
  }

  if (error && isMissingColumnError(error)) {
    console.warn(
      `[scraper-jobs] Large-scale job create: tracked tier ALSO failed (${error.message}) — ` +
        "falling back to requested_count + status only.",
    );
    wrote = "core only (requested_count + status — target_count/current_round column(s) missing)";
    ({ data, error } = await supabase.from("scraper_jobs").insert(corePayload).select().single());
  }

  if (error || !data) {
    console.error("[scraper-jobs] Failed to create large-scale job:", error);
    return { job: null, error: error?.message ?? "Failed to start large-scale ingestion." };
  }

  console.log(
    `[scraper-jobs] Large-scale job created: ${data.id} (target ${targetCount}, ~${totalBatches} batches, ` +
      `${mode} mode) — wrote: ${wrote}`,
  );
  logJobStatusTransition({ jobId: data.id, from: null, to: data.status, reason: "start", pauseRequested: false });
  return { job: data };
}

export interface LargeScaleJobProgressUpdate {
  insertedCount: number;
  validCount: number;
  duplicateCount: number;
  rejectedCount: number;
  // New (Inventory Growth/Bulk Importer architecture-parity fix, dashboard
  // requirement: "Database insert failures") — same tiered-fallback
  // treatment as queriesCompleted/pagesSearched/uniqueUrlsDiscovered
  // below: a genuinely new column, so it gets the richest tier rather than
  // risking dragging valid_count/duplicate_count/rejected_count down with
  // it on a database that hasn't run the newest migration yet.
  insertFailedCount?: number;
  // New (dashboard requirements: "URLs extracted successfully" / "extraction
  // failures by reason") — same tiered-fallback treatment as insertFailedCount
  // above: genuinely new columns, so they get the richest tier.
  extractedSuccessfullyCount?: number;
  extractionFailuresByReason?: Record<string, number>;
  currentBatch: number;
  failedBatchCount?: number;
  // Optional/best-effort like the rest of this update — populated once
  // callers started reporting interim (mid-batch) progress; older calls
  // that don't have it yet just leave scraped_count untouched.
  scrapedCount?: number;
  // Persisted together as `checkpoint` so a resumed run (see
  // resumeScraperJob, src/app/actions/admin-scraper.ts) can seed its own
  // seenUrls set from where the paused run left off (instead of
  // re-discovering/re-trying candidates already tried) AND reconstruct
  // the exact same LargeScaleAdminScraperOptions without those needing to
  // be passed in by hand — checkpoint is a single JSON column, so both
  // are always written together or the later write would silently drop
  // whichever key isn't included this time.
  seenUrls?: string[];
  checkpointOptions?: Record<string, unknown>;
  // Discovery-scaling dashboard numbers (src/lib/inventory/
  // scaled-discovery.ts) — the newest, least-likely-to-exist-yet columns
  // of this whole update, so they get their own richest tier (see below)
  // rather than being bundled into `fullPayload`, which would otherwise
  // risk taking valid_count/duplicate_count/rejected_count down with them
  // on a database that hasn't run the newest schema.sql migration yet.
  queriesCompleted?: number;
  pagesSearched?: number;
  uniqueUrlsDiscovered?: number;
}

/**
 * Tiered fallback, each tier a STRICT superset of the one below — this is
 * the fix for the bug where current_round/checkpoint (columns the live
 * database HAS) were getting bundled into the same payload as valid_count/
 * duplicate_count/rejected_count/error_count (columns it DIDN'T have yet),
 * so one missing column took the whole write down and every call silently
 * degraded all the way to corePayload (status + inserted_count only) even
 * though current_round/checkpoint themselves were perfectly writable.
 *
 * trackedPayload is the new middle tier that closes that gap: on a
 * database that hasn't run the latest supabase/schema.sql (missing
 * valid_count/duplicate_count/rejected_count/error_count) it still
 * persists current_round + checkpoint + heartbeat, which is what the
 * "Current batch: 0 / ?" and stuck-checkpoint symptoms actually needed.
 *
 * Deliberately never writes `status` — this used to unconditionally set
 * status: "running" on every call, including the ordinary per-batch write
 * that fires the moment a batch finishes. Since a pause can only take
 * effect at the NEXT batch boundary (see runLargeScaleAdminScraper's own
 * header comment), an admin pausing WHILE a batch is still in flight —
 * completely normal, and the whole point of interim progress reporting is
 * to make that batch take longer to notice — would have that pause
 * silently reverted back to "running" by this exact function the instant
 * the in-flight batch's own progress write landed, found live while
 * verifying interim progress reporting. Nothing else in this codebase
 * checks for the literal string "running" (isPaused/resume both check
 * specifically for "paused"; the admin UI's own phase logic treats
 * anything non-terminal/non-paused as "running" for display, regardless
 * of the DB value) — so status is left alone here entirely and only ever
 * changed by pauseScraperJobRow/completeScraperJob/failScraperJob.
 */
export async function updateLargeScaleScraperJobProgress(jobId: string, progress: LargeScaleJobProgressUpdate): Promise<void> {
  const supabase = createAdminClient<ScraperJobsDatabase>();
  const nowIso = new Date().toISOString();

  const corePayload = {
    inserted_count: progress.insertedCount,
  };
  const trackedPayload = {
    ...corePayload,
    current_round: progress.currentBatch,
    // scraped_count is one of the ORIGINAL scraper_jobs columns (predates
    // the large-scale/valid_count/duplicate_count/etc. migration), so it's
    // safe in this tier rather than needing the richer one below.
    ...(progress.scrapedCount != null ? { scraped_count: progress.scrapedCount } : {}),
    ...(progress.seenUrls
      ? { checkpoint: { seenUrls: progress.seenUrls, options: progress.checkpointOptions } }
      : {}),
  };
  const trackedHeartbeatPayload = { ...trackedPayload, updated_at: nowIso, last_heartbeat: nowIso };
  const fullPayload = {
    ...trackedHeartbeatPayload,
    valid_count: progress.validCount,
    duplicate_count: progress.duplicateCount,
    rejected_count: progress.rejectedCount,
    ...(progress.failedBatchCount != null ? { error_count: progress.failedBatchCount } : {}),
  };
  const dashboardPayload = {
    ...fullPayload,
    ...(progress.queriesCompleted != null ? { queries_completed: progress.queriesCompleted } : {}),
    ...(progress.pagesSearched != null ? { pages_searched: progress.pagesSearched } : {}),
    ...(progress.uniqueUrlsDiscovered != null ? { unique_urls_discovered: progress.uniqueUrlsDiscovered } : {}),
    ...(progress.insertFailedCount != null ? { insert_failed_count: progress.insertFailedCount } : {}),
    ...(progress.extractedSuccessfullyCount != null
      ? { extracted_successfully_count: progress.extractedSuccessfullyCount }
      : {}),
    ...(progress.extractionFailuresByReason != null
      ? { extraction_failures_by_reason: progress.extractionFailuresByReason }
      : {}),
  };

  type ScraperJobUpdate = ScraperJobsDatabase["public"]["Tables"]["scraper_jobs"]["Update"];
  const tiers: Array<{ name: string; payload: ScraperJobUpdate }> = [
    { name: "dashboard (full + queries/pages/unique-URL discovery counts)", payload: dashboardPayload },
    { name: "full (valid/duplicate/rejected/error counts + heartbeat + current_round + checkpoint)", payload: fullPayload },
    { name: "tracked + heartbeat (no valid/duplicate/rejected/error counts)", payload: trackedHeartbeatPayload },
    { name: "tracked, no heartbeat (current_round + checkpoint only)", payload: trackedPayload },
    { name: "core only (status + inserted_count)", payload: corePayload },
  ];

  let error: { code?: string; message: string } | null = null;
  let tierUsed: string | null = null;

  for (const tier of tiers) {
    ({ error } = await supabase.from("scraper_jobs").update(tier.payload).eq("id", jobId));

    if (!error) {
      tierUsed = tier.name;
      break;
    }

    if (!isMissingColumnError(error)) break; // Not a schema issue — retrying a narrower payload won't help.

    // FIX 4 — log the full context of every downgrade instead of hiding
    // it: which payload was attempted, the exact Supabase error, and
    // which tier is being fallen back to next.
    console.warn(
      `[scraper-jobs] Large-scale progress: tier "${tier.name}" failed for job ${jobId} — falling back.\n` +
        `  Attempted payload: ${JSON.stringify(tier.payload)}\n` +
        `  Supabase error: ${JSON.stringify(error)}`,
    );
  }

  if (error) {
    console.error(
      `[scraper-jobs] Failed to update large-scale job progress for ${jobId} — every tier failed.\n` +
        `  Last attempted payload: ${JSON.stringify(tiers[tiers.length - 1].payload)}\n` +
        `  Supabase error: ${JSON.stringify(error)}`,
    );
  } else {
    console.log(`[scraper-jobs] Large-scale progress write succeeded at tier: ${tierUsed}`);
    console.log(
      `[scraper-jobs] Large-scale job ${jobId} batch ${progress.currentBatch} — ` +
        `valid ${progress.validCount}, duplicate ${progress.duplicateCount}, rejected ${progress.rejectedCount}, ` +
        `insert failed ${progress.insertFailedCount ?? 0}, inserted ${progress.insertedCount}, ` +
        `extracted ok ${progress.extractedSuccessfullyCount ?? 0}`,
    );
  }
}

/** Full row fetch — used by runLargeScaleAdminScraper to check, before
 * starting each new batch, whether an admin has paused this job in the
 * meantime (see this file's own header comment on why pause/resume works
 * this way rather than truly suspending an in-flight execution). */
export async function getScraperJobRow(jobId: string): Promise<ScraperJobRow | null> {
  const supabase = createAdminClient<ScraperJobsDatabase>();
  const { data, error } = await supabase.from("scraper_jobs").select("*").eq("id", jobId).maybeSingle();

  if (error) {
    console.error("[scraper-jobs] Failed to fetch job row:", jobId, error);
    return null;
  }

  return data;
}

/**
 * Flips a job to 'paused' — only from a state where "pause" is meaningful
 * (pending/queued/running); a no-op against an already-terminal job. The
 * running loop itself (runLargeScaleAdminScraper) is what actually stops
 * — this just sets the flag it checks before each batch. There is no way
 * to interrupt a batch already in flight; pause takes effect at the next
 * batch boundary.
 */
export async function pauseScraperJobRow(jobId: string): Promise<{ error?: string }> {
  const supabase = createAdminClient<ScraperJobsDatabase>();
  const { data, error } = await supabase
    .from("scraper_jobs")
    .update({ status: "paused" })
    .eq("id", jobId)
    .in("status", ["pending", "queued", "running"])
    .select("status")
    .maybeSingle();

  if (error) {
    console.error("[scraper-jobs] Failed to pause job:", jobId, error);
    return { error: error.message };
  }

  console.log(`[scraper-jobs] Job ${jobId} paused`);
  if (data) {
    logJobStatusTransition({ jobId, from: "running", to: "paused", reason: "user_pause_request", pauseRequested: true });
  }
  return {};
}

/**
 * Atomically transitions a large-scale job from 'paused' to 'running' —
 * the resume-lifecycle fix (see /api/admin-scraper/large-scale/route.ts's
 * own Resume path). updateLargeScaleScraperJobProgress deliberately never
 * writes `status` at all (see that function's own header comment on why —
 * it used to silently un-pause an already-paused job the moment its next
 * progress write landed), which is exactly why nothing else in a resumed
 * run's own code path was ever setting status back to something other
 * than 'paused' — a successfully resumed job just sat at 'paused' in the
 * DB for its entire (real, actively-executing) run, indistinguishable
 * from never having resumed at all.
 *
 * The `.eq("status", "paused")` guard on the update is what makes this
 * safe against a double-click: Postgres serializes concurrent writers to
 * the same row, so only the FIRST resume request's update can ever match
 * (and claim) a given paused row — a second, near-simultaneous resume
 * request for the same job runs its update after the first has already
 * flipped status to 'running', matches zero rows, and gets `claimed:
 * false` back, telling the caller not to start a second background
 * execution for the same job.
 */
export async function claimJobForResume(jobId: string): Promise<{ claimed: boolean; job: ScraperJobRow | null }> {
  const supabase = createAdminClient<ScraperJobsDatabase>();
  const nowIso = new Date().toISOString();

  // Requirement 2/3 — resuming must not silently leave the row's OWN
  // heartbeat/error state behind: a job that was paused a while ago (that
  // is, after all, usually WHY there's something to resume) can easily
  // carry a last_heartbeat/updated_at far older than
  // STALE_JOB_RECOVERY_THRESHOLD_MS. Left untouched, the very next
  // getScraperJobStatus poll after this resume calls
  // recoverStaleLargeScaleJob against that same old timestamp and flips
  // the job straight back to 'paused' before a single batch runs — which
  // is indistinguishable, from the admin's side, from "I clicked Resume
  // and it immediately paused itself." Resetting both here, in the SAME
  // atomic claim as the status flip, is what makes a resumed job's
  // "startup state" actually committed before anything reads it.
  const richPayload = { status: "running" as const, last_heartbeat: nowIso, updated_at: nowIso, error_message: null };

  let { data, error } = await supabase
    .from("scraper_jobs")
    .update(richPayload)
    .eq("id", jobId)
    .eq("status", "paused")
    .select()
    .maybeSingle();

  if (error && isMissingColumnError(error)) {
    ({ data, error } = await supabase
      .from("scraper_jobs")
      .update({ status: "running" as const })
      .eq("id", jobId)
      .eq("status", "paused")
      .select()
      .maybeSingle());
  }

  if (error) {
    console.error("[scraper-jobs] Failed to claim job for resume:", jobId, error);
    return { claimed: false, job: null };
  }

  if (data) {
    logJobStatusTransition({ jobId, from: "paused", to: "running", reason: "resume", pauseRequested: false });
  }

  return { claimed: Boolean(data), job: data };
}

// P0 launch-readiness fix — process-batch/route.ts's own status check
// (`job.status === "pending" || "running"`) does NOT prevent two
// concurrent calls for the SAME job from both passing it and both calling
// runLargeScaleAdminScraper at once: status stays 'running' across many
// sequential batch calls by design, so it can't double as a per-attempt
// mutex the way claimJobForResume's paused->running flip does above. A
// short-lived lease closes that gap the same way scraper_url_queue's own
// claimed_at closes the analogous per-URL race (see url-queue.ts).
const BATCH_LEASE_DURATION_MS = 90_000; // comfortably longer than SINGLE_BATCH_CALL_TIMEOUT_MS x SINGLE_BATCH_CALL_MAX_ATTEMPTS

/**
 * Atomically claims this job for one batch attempt — succeeds only when
 * there is no lease at all, or the existing lease has expired (the
 * previous holder crashed/timed out before releasing it). A concurrent
 * caller's own claim attempt, racing this one, matches zero rows (the
 * lease this call just set no longer satisfies "no lease or expired") and
 * gets `claimed: false` back, telling it not to run a batch at all this
 * poll tick — the exact same "lose the race, do nothing" shape
 * claimJobForResume already established for resume requests.
 */
export async function claimBatchLease(jobId: string): Promise<{ claimed: boolean; leaseId: string | null }> {
  const supabase = createAdminClient<ScraperJobsDatabase>();
  const nowIso = new Date().toISOString();
  const leaseId = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + BATCH_LEASE_DURATION_MS).toISOString();

  const { data, error } = await supabase
    .from("scraper_jobs")
    .update({ batch_lease_id: leaseId, batch_lease_expires_at: expiresAt })
    .eq("id", jobId)
    .in("status", ["pending", "running"])
    .or(`batch_lease_id.is.null,batch_lease_expires_at.lt.${nowIso}`)
    .select("id")
    .maybeSingle();

  if (error) {
    if (isMissingColumnError(error)) {
      // Database hasn't run the latest migration yet — fail open (treat as
      // claimed) rather than permanently blocking every batch call; this
      // matches every other "possibly not migrated yet" column in this
      // file's own established posture. Overlap protection is simply
      // unavailable until the migration runs, not a hard outage.
      return { claimed: true, leaseId: null };
    }
    console.error("[scraper-jobs] Failed to claim batch lease:", jobId, error);
    return { claimed: false, leaseId: null };
  }

  return { claimed: Boolean(data), leaseId: data ? leaseId : null };
}

/**
 * Releases a batch lease this call itself holds — guarded by leaseId (not
 * just jobId) so a call whose lease has ALREADY expired and been reclaimed
 * by a new attempt can never clear the new holder's lease out from under
 * it. Best-effort: if this fails, the lease simply expires on its own
 * after BATCH_LEASE_DURATION_MS, same as a crashed request would.
 */
export async function releaseBatchLease(jobId: string, leaseId: string | null): Promise<void> {
  if (!leaseId) return; // Migration not applied (see claimBatchLease) — nothing to release.
  const supabase = createAdminClient<ScraperJobsDatabase>();

  const { error } = await supabase
    .from("scraper_jobs")
    .update({ batch_lease_id: null, batch_lease_expires_at: null })
    .eq("id", jobId)
    .eq("batch_lease_id", leaseId);

  if (error && !isMissingColumnError(error)) {
    console.error("[scraper-jobs] Failed to release batch lease:", jobId, error);
  }
}

export async function failScraperJob(jobId: string, errorMessage: string): Promise<void> {
  const supabase = createAdminClient<ScraperJobsDatabase>();
  const nowIso = new Date().toISOString();

  let { error } = await supabase
    .from("scraper_jobs")
    .update({ status: "failed", error_message: errorMessage, completed_at: nowIso, updated_at: nowIso })
    .eq("id", jobId);

  if (error && isMissingColumnError(error)) {
    console.warn(
      "[scraper-jobs] completed_at/updated_at not found on this database's scraper_jobs table — " +
        "retrying with just status+error_message so the job doesn't get stuck at 'running' forever.",
    );
    ({ error } = await supabase
      .from("scraper_jobs")
      .update({ status: "failed", error_message: errorMessage })
      .eq("id", jobId));
  }

  if (error) {
    console.error("[scraper-jobs] Failed to mark job failed:", jobId, error);
  } else {
    console.log(`[scraper-jobs] Job ${jobId} failed: ${errorMessage}`);
    // Requirement 7 — resource/startup failures (missing browser, memory
    // guard, a Supabase error, an uncaught exception) MUST surface as a
    // real 'failed' status with last_error populated, never be left to
    // silently decay into 'paused' 20 minutes later via
    // recoverStaleLargeScaleJob's stale-heartbeat check. Every caller of
    // this function (process-batch/route.ts's catch block, the large-scale
    // start route's own catch block, the batch-retry-ceiling check) is
    // exactly one of those cases.
    logJobStatusTransition({ jobId, from: "running", to: "failed", reason: errorMessage, pauseRequested: false });
  }
}
