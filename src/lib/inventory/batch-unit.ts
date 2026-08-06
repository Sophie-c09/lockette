// Shared "process exactly ONE bounded batch of a large-scale Inventory
// Growth job" pipeline — extracted from process-batch/route.ts (Render-
// worker migration) so both that Vercel route AND
// src/workers/inventory-growth-worker.ts invoke the exact same
// implementation. Neither caller duplicates this logic; they only differ
// in WHO drives the outer loop (one HTTP request vs. a long-running
// process's own while-loop) and HOW LONG one unit is allowed to run
// (SINGLE_BATCH_CALL_TIMEOUT_MS, bounded by Vercel's maxDuration, vs.
// WORKER_BATCH_TIMEOUT_MS, a pure hang-detection watchdog with no request
// lifetime to fit inside).
//
// This function does NOT claim or release the batch lease itself — the
// caller does that (process-batch/route.ts claims once per HTTP request;
// the worker claims once per job acquisition and reuses the same leaseId
// across many consecutive calls to this function, renewing it on its own
// timer). This function only USES the passed-in leaseId to guard every
// write it makes, exactly as before.
import { runLargeScaleAdminScraper, type LargeScaleAdminScraperOptions, type LargeScaleProgress } from "@/lib/admin-scraper";
import { SCRAPER_CONFIG } from "@/lib/scraper-config";
import {
  getScraperJobRow,
  updateLargeScaleScraperJobProgress,
  completeScraperJob,
  failScraperJob,
  type ScraperJobRow,
} from "@/lib/scraper-jobs";

// Zero-progress-watchdog fix — same "small consecutive threshold, then
// stop truthfully" shape as this codebase's other bounded-retry safety
// nets (e.g. MAX_GENERATION_ATTEMPTS, LARGE_SCALE_MAX_CONSECUTIVE_BATCH_FAILURES).
// 3 real, back-to-back zero-progress calls (each its own watchdog window)
// is a strong enough signal that this isn't a marketplace just being
// briefly slow between hits.
const ZERO_PROGRESS_BATCH_THRESHOLD = 3;

// Turns one runLargeScaleAdminScraper progress snapshot (cumulative WITHIN
// this single call only — see LargeScaleProgress's own comment) into the
// same job.X + progress.X shape the final write below already uses,
// against the FIXED `baseJob` row read once before this unit started —
// never re-fetched or re-accumulated between calls — so an interim write
// (mid-attempt) and the final write (once the attempt finishes) always
// agree on the same absolute totals regardless of which one physically
// lands in Postgres last. currentBatch/seenUrls/checkpointOptions are
// deliberately left at their PRE-this-attempt values (or omitted) here:
// this batch hasn't actually completed yet, so current_round must not
// advance and the checkpoint must not be rewritten until it does.
function buildInterimProgressPayload(baseJob: ScraperJobRow, progress: LargeScaleProgress) {
  return {
    insertedCount: baseJob.inserted_count + progress.insertedCount,
    validCount: (baseJob.valid_count ?? 0) + progress.validCount,
    duplicateCount: (baseJob.duplicate_count ?? 0) + progress.duplicateCount,
    rejectedCount: (baseJob.rejected_count ?? 0) + progress.rejectedCount,
    insertFailedCount: (baseJob.insert_failed_count ?? 0) + progress.insertFailedCount,
    extractedSuccessfullyCount: (baseJob.extracted_successfully_count ?? 0) + progress.extractedSuccessfullyCount,
    extractionFailuresByReason: (() => {
      const merged = { ...(baseJob.extraction_failures_by_reason ?? {}) };
      for (const [reason, count] of Object.entries(progress.extractionFailuresByReason)) {
        merged[reason] = (merged[reason] ?? 0) + count;
      }
      return merged;
    })(),
    scrapedCount: (baseJob.scraped_count ?? 0) + progress.scrapedCount,
    currentBatch: baseJob.current_round ?? 0,
    queriesCompleted: (baseJob.queries_completed ?? 0) + progress.queriesCompleted,
    pagesSearched: (baseJob.pages_searched ?? 0) + progress.pagesSearched,
    uniqueUrlsDiscovered: (baseJob.unique_urls_discovered ?? 0) + progress.uniqueUrlsDiscovered,
  };
}

export interface BatchUnitParams {
  // Log-line prefix identifying the caller (e.g. "admin-scraper/large-scale/process-batch" or "inventory-growth-worker").
  logPrefix: string;
  jobId: string;
  // The job row as read once, immediately before this unit started — see
  // buildInterimProgressPayload's own comment on why this must stay fixed
  // for the whole call rather than being re-fetched partway through.
  job: ScraperJobRow;
  leaseId: string;
  // External abort source — process-batch/route.ts ties this to its own
  // per-request AbortController (fired only by the internal watchdog
  // today); the worker ties this to SIGTERM/SIGINT and to its own
  // lease-renewal timer detecting lease loss.
  signal: AbortSignal;
  batchTimeoutMs: number;
  maxAttemptsPerBatch: number;
}

export interface BatchUnitResult {
  jobId: string;
  status: "running" | "completed" | "failed" | "paused";
  batchRan: boolean;
  warning?: string;
  // Concurrency/cancellation fix — false means this execution's work could
  // NOT be confirmed stopped within its watchdog's own grace period. The
  // caller must NOT release the batch lease when this is false — see each
  // caller's own release logic.
  shouldReleaseLease: boolean;
  cancellationConfirmed: boolean;
}

/** Runs exactly one bounded batch attempt against an ALREADY-claimed job
 * lease, persists its progress (lease-guarded throughout), and decides any
 * terminal status transition. Does not claim or release the lease itself. */
export async function runBatchUnit(params: BatchUnitParams): Promise<BatchUnitResult> {
  const { logPrefix, jobId, job, leaseId, signal, batchTimeoutMs, maxAttemptsPerBatch } = params;

  console.log(`[${logPrefix}] Processing one batch unit`, {
    jobId,
    leaseId,
    currentStatus: job.status,
    currentRound: job.current_round ?? 0,
    targetCount: job.target_count ?? null,
  });

  const checkpoint = job.checkpoint ?? {};
  const savedOptions = (checkpoint.options as LargeScaleAdminScraperOptions | undefined) ?? {
    maxPrice: SCRAPER_CONFIG.maxPrice,
    minStyleScore: SCRAPER_CONFIG.minStyleScore,
    minImageScore: SCRAPER_CONFIG.minImageScore,
    allowedSources: SCRAPER_CONFIG.allowedSources,
    brandMode: null,
    categoryFilter: null,
  };

  const options: LargeScaleAdminScraperOptions = {
    ...savedOptions,
    seenUrls: checkpoint.seenUrls ?? [],
    // This call only ever runs ONE batch, however many the job's own
    // overall run was configured for — savedOptions.maxBatches (from the
    // original Start request) still caps the TOTAL number of batches
    // across every call combined, checked below.
    maxBatches: 1,
  };

  const totalBatchesAllowed = savedOptions.maxBatches ?? Number.POSITIVE_INFINITY;
  if ((job.current_round ?? 0) >= totalBatchesAllowed) {
    const failResult = await failScraperJob(
      jobId,
      "Reached the maximum batch count without hitting the target — see server logs for details.",
      leaseId,
    );
    return { jobId, status: "failed", batchRan: false, shouldReleaseLease: failResult.applied, cancellationConfirmed: true };
  }

  console.info("[INVENTORY_GROWTH][TRACE]", {
    jobId,
    stage: "invoking_runner",
    perBatchTimeoutMs: batchTimeoutMs,
    maxAttemptsPerBatch,
    timestamp: new Date().toISOString(),
  });

  let result: Awaited<ReturnType<typeof runLargeScaleAdminScraper>>;
  try {
    result = await runLargeScaleAdminScraper(options, {
      isPaused: async () => {
        const current = await getScraperJobRow(jobId);
        return current?.status === "paused";
      },
      perBatchTimeoutMs: batchTimeoutMs,
      maxAttemptsPerBatch,
      signal,
      // Interim persistence — without this, a batch attempt that gets
      // watchdogged (or that simply hasn't finished yet) contributes
      // NOTHING to the job row until/unless it fully completes. Persisted
      // against the FIXED `job` snapshot (see buildInterimProgressPayload's
      // own comment) so this can never double-count against the
      // authoritative write below. Lease-guarded — a stale interim write
      // (this execution's lease already superseded) is logged and
      // otherwise ignored; it must never retry or fall back to an
      // unguarded write.
      onProgress: async (progress) => {
        try {
          const interimResult = await updateLargeScaleScraperJobProgress(
            jobId,
            buildInterimProgressPayload(job, progress),
            leaseId,
          );
          if (!interimResult.applied) {
            console.warn(`[${logPrefix}] Interim progress write skipped for job ${jobId} — this execution's lease is stale.`);
          }
        } catch (progressError) {
          console.error(`[${logPrefix}] Interim progress write failed:`, progressError);
        }
      },
    });
  } catch (batchError) {
    const message = batchError instanceof Error ? batchError.message : "Unexpected error running this batch.";
    console.error(`[${logPrefix}] Batch attempt threw — marking job failed`, {
      jobId,
      message,
      stack: batchError instanceof Error ? batchError.stack : undefined,
    });
    const failResult = await failScraperJob(jobId, message, leaseId);
    return { jobId, status: "failed", batchRan: false, shouldReleaseLease: failResult.applied, cancellationConfirmed: true };
  }

  // Concurrency/cancellation fix — Section 5 timeout semantics. If this
  // attempt's own cancellation could NOT be confirmed, the underlying
  // discovery/extraction work may still be running in the background
  // using this SAME leaseId — the write below is still safe (lease-
  // guarded, and this execution still legitimately holds it), but the
  // lease itself must not be released afterward, so a brand-new execution
  // can't start a second, overlapping one while the first might still be
  // mutating state.
  if (!result.cancellationConfirmed) {
    console.error(
      `[${logPrefix}] Batch attempt for job ${jobId} could not confirm cancellation — holding the lease until ` +
        "it naturally expires instead of releasing it.",
      { lastBatchError: result.lastBatchError },
    );
  }

  // False-zero-progress fix — withBatchWatchdog's own "settled within the
  // grace period, but via an error rather than a real result" branch (see
  // admin-scraper.ts) returns a hardcoded zeroResult() with EVERY total set
  // to 0, even when this same attempt's own interim onProgress callback
  // (above) already committed real, lease-guarded progress to the DB
  // moments earlier. result.totalX therefore cannot be trusted on its own
  // to mean "nothing happened this unit" — it can just mean "the FINAL
  // return value was zeroed out after the real work was already
  // persisted." Re-reading the job row right now (reflecting every interim
  // write made during this very attempt, whatever result.totalX claims)
  // and taking the larger of that vs. the naive job.X + result.totalX sum
  // is what actually answers "did anything real land in the database this
  // unit" — and, as a direct side effect, also closes a latent
  // monotonicity gap where this final write could otherwise regress a
  // counter an interim write had already advanced past what result.totalX
  // alone would compute.
  const latestPersisted = await getScraperJobRow(jobId);
  function committed(base: number, delta: number, latest: number | null | undefined): number {
    return Math.max(base + delta, latest ?? 0);
  }

  const insertedCount = committed(job.inserted_count, result.totalImported, latestPersisted?.inserted_count);
  const validCount = committed(job.valid_count ?? 0, result.totalValid, latestPersisted?.valid_count);
  const duplicateCount = committed(job.duplicate_count ?? 0, result.totalDuplicates, latestPersisted?.duplicate_count);
  const rejectedCount = committed(job.rejected_count ?? 0, result.totalRejected, latestPersisted?.rejected_count);
  const insertFailedCount = committed(job.insert_failed_count ?? 0, result.totalInsertFailed, latestPersisted?.insert_failed_count);
  const scrapedCount = committed(job.scraped_count ?? 0, result.totalScraped, latestPersisted?.scraped_count);
  const extractedSuccessfullyCount = committed(
    job.extracted_successfully_count ?? 0,
    result.totalExtractedSuccessfully,
    latestPersisted?.extracted_successfully_count,
  );
  const extractionFailuresByReason = { ...(job.extraction_failures_by_reason ?? {}) };
  for (const [reason, count] of Object.entries(result.extractionFailuresByReason)) {
    extractionFailuresByReason[reason] = (extractionFailuresByReason[reason] ?? 0) + count;
  }
  const queriesCompleted = committed(job.queries_completed ?? 0, result.totalQueriesCompleted, latestPersisted?.queries_completed);
  const pagesSearched = committed(job.pages_searched ?? 0, result.totalPagesSearched, latestPersisted?.pages_searched);
  const uniqueUrlsDiscovered = committed(
    job.unique_urls_discovered ?? 0,
    result.totalUniqueUrlsDiscovered,
    latestPersisted?.unique_urls_discovered,
  );
  // Concurrency fix — current_round only ever advances once the batch's
  // cancellation is confirmed (a genuinely finished, one-way-or-another
  // attempt); an unconfirmed attempt might still be running and must not
  // let this call's poll advance the round counter out from under it.
  const currentRound = (job.current_round ?? 0) + (result.cancellationConfirmed ? result.batchesRun : 0);

  // Productive-progress predicate — Section 3 of the false-zero-progress
  // fix: ANY trusted, actually-committed counter increasing over its
  // PRE-unit value (job.X, the fixed snapshot from before this attempt
  // started) means real work happened this unit, regardless of what
  // result.totalX alone claims. Compares the values ABOVE (already
  // reconciled against the live DB), not result.totalX directly — this is
  // what correctly credits a unit whose interim writes committed real
  // listings before its final result got zeroed out by a late/aborted
  // settle (see `committed()`'s own comment).
  const progressedThisUnit =
    insertedCount > job.inserted_count ||
    validCount > (job.valid_count ?? 0) ||
    duplicateCount > (job.duplicate_count ?? 0) ||
    rejectedCount > (job.rejected_count ?? 0) ||
    extractedSuccessfullyCount > (job.extracted_successfully_count ?? 0) ||
    queriesCompleted > (job.queries_completed ?? 0) ||
    pagesSearched > (job.pages_searched ?? 0) ||
    uniqueUrlsDiscovered > (job.unique_urls_discovered ?? 0);

  const previousZeroProgressStreak =
    (job.checkpoint as { consecutiveZeroProgressBatches?: number } | null)?.consecutiveZeroProgressBatches ?? 0;

  // Section 4 — only a genuinely SETTLED unit (cancellationConfirmed) with
  // no committed progress increments the streak. An unconfirmed unit is
  // still unwinding — it may yet commit real progress via a later interim
  // write from the SAME leaked continuation — so its streak is left
  // UNCHANGED (neither incremented nor reset) rather than assumed either
  // way; the next call that actually settles is what decides.
  const thisCallMadeZeroProgress =
    result.cancellationConfirmed && result.stopReason === "max_batches_reached" && !progressedThisUnit;

  const zeroProgressStreak = !result.cancellationConfirmed
    ? previousZeroProgressStreak
    : progressedThisUnit
      ? 0
      : previousZeroProgressStreak + 1;

  if (thisCallMadeZeroProgress) {
    console.error(`[${logPrefix}] Zero-progress batch for job ${jobId} (streak ${zeroProgressStreak}/${ZERO_PROGRESS_BATCH_THRESHOLD})`, {
      lastBatchError: result.lastBatchError,
    });
  } else if (progressedThisUnit && previousZeroProgressStreak > 0) {
    console.log(
      `[${logPrefix}] Job ${jobId} made real committed progress this unit — resetting zero-progress streak ` +
        `from ${previousZeroProgressStreak} to 0.`,
    );
  }

  const progressWrite = await updateLargeScaleScraperJobProgress(
    jobId,
    {
      insertedCount,
      validCount,
      duplicateCount,
      rejectedCount,
      insertFailedCount,
      extractedSuccessfullyCount,
      extractionFailuresByReason,
      scrapedCount,
      currentBatch: currentRound,
      seenUrls: result.seenUrls,
      checkpointOptions: savedOptions as unknown as Record<string, unknown>,
      queriesCompleted,
      pagesSearched,
      uniqueUrlsDiscovered,
      consecutiveZeroProgressBatches: zeroProgressStreak,
    },
    leaseId,
  );

  if (!progressWrite.applied) {
    console.warn(`[${logPrefix}] Progress write for job ${jobId} was stale — a newer execution already owns this job's lease.`);
    return { jobId, status: job.status as BatchUnitResult["status"], batchRan: false, shouldReleaseLease: false, cancellationConfirmed: result.cancellationConfirmed };
  }

  if (zeroProgressStreak >= ZERO_PROGRESS_BATCH_THRESHOLD) {
    const reason =
      `${zeroProgressStreak} consecutive batches produced no discovery/extraction progress ` +
      `(zero queries, pages, discovered URLs, extraction attempts, and outcomes) — stopping instead of ` +
      `continuing toward batch ${savedOptions.maxBatches ?? "?"}.` +
      (result.lastBatchError ? ` Last error: ${result.lastBatchError}` : "");
    console.error(`[${logPrefix}] ${reason}`);
    const failResult = await failScraperJob(jobId, reason, leaseId);
    return { jobId, status: "failed", batchRan: false, shouldReleaseLease: failResult.applied, cancellationConfirmed: true };
  }

  if (result.cancellationConfirmed) {
    if (result.stopReason === "paused") {
      console.log(`[${logPrefix}] Job ${jobId} stopped cleanly for pause.`);
    } else if (result.stopReason === "target_reached") {
      await completeScraperJob(jobId, insertedCount, leaseId);
    } else if (result.stopReason === "consecutive_failures") {
      await failScraperJob(jobId, "Too many consecutive batches failed in a row — see server logs for details.", leaseId);
    }
  }

  console.log(`[${logPrefix}] Batch unit complete`, {
    jobId,
    stopReason: result.stopReason,
    batchesRun: result.batchesRun,
    cancellationConfirmed: result.cancellationConfirmed,
    insertedCount,
  });
  console.info("[INVENTORY_GROWTH][TRACE]", {
    jobId,
    stage: "metrics_row_updated",
    stopReason: result.stopReason,
    cancellationConfirmed: result.cancellationConfirmed,
    queriesCompleted,
    pagesSearched,
    insertedCount,
    timestamp: new Date().toISOString(),
  });

  const status: BatchUnitResult["status"] = !result.cancellationConfirmed
    ? "running"
    : result.stopReason === "target_reached"
      ? "completed"
      : result.stopReason === "consecutive_failures"
        ? "failed"
        : result.stopReason === "paused"
          ? "paused"
          : "running";

  return {
    jobId,
    status,
    batchRan: result.cancellationConfirmed && result.batchesRun > 0,
    ...(!result.cancellationConfirmed
      ? {
          warning:
            "This batch's cancellation could not be confirmed within the grace period — the underlying work " +
            "may still be running in the background. The batch lease is being held until it naturally expires " +
            "to prevent a second, overlapping execution from starting.",
        }
      : {}),
    shouldReleaseLease: result.cancellationConfirmed,
    cancellationConfirmed: result.cancellationConfirmed,
  };
}
