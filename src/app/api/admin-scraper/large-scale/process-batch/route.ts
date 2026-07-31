// Processes exactly ONE bounded batch of a large-scale Inventory Growth
// job per call — the "actual work" half of the architecture fix described
// in ../route.ts's own header comment. That route only ever creates or
// resumes the job row and returns immediately; this route is the only
// place runLargeScaleAdminScraper (and therefore playwright, transitively
// — see next.config.ts's own comment) actually runs, always awaited
// synchronously within THIS request/response cycle (never via after()),
// bounded to maxBatches: 1 so a single call finishes well inside this
// Function's own maxDuration rather than attaching an open-ended run to
// any one request.
//
// Invoked repeatedly by the admin dashboard's own polling loop
// (ImportListingView.tsx) for as long as the job stays 'pending'/'running'
// and the dashboard tab stays open — the persistent execution this
// feature needs, without requiring a dedicated background-worker
// deployment or a sub-daily Vercel Cron schedule (not available on the
// Hobby plan — see supabase/migrations' own cron-frequency history).
// Progress (seenUrls + resolved options) is round-tripped through the
// job's own `checkpoint` column between calls, the same mechanism the
// pause/resume flow already relies on.
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isCurrentUserAdmin } from "@/lib/admin";
import { runLargeScaleAdminScraper, type LargeScaleAdminScraperOptions } from "@/lib/admin-scraper";
import { SCRAPER_CONFIG } from "@/lib/scraper-config";
import {
  getScraperJobRow,
  updateLargeScaleScraperJobProgress,
  completeScraperJob,
  failScraperJob,
} from "@/lib/scraper-jobs";

export const maxDuration = 60;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function sanitizedErrorResponse(message: string, status: number) {
  return NextResponse.json(
    {
      error: "Failed to process the next inventory growth batch",
      code: "INVENTORY_GROWTH_BATCH_FAILED",
      details: message,
    },
    { status },
  );
}

export async function POST(request: Request) {
  const routeName = "admin-scraper/large-scale/process-batch";

  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user || !(await isCurrentUserAdmin(supabase, user.id))) {
      console.warn(`[${routeName}] Unauthorized batch request`, { userId: user?.id ?? null });
      return NextResponse.json({ success: false, error: "Not authorized.", code: "UNAUTHORIZED" }, { status: 401 });
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch (error) {
      console.error(`[${routeName}] Invalid request body`, { userId: user.id, error });
      return NextResponse.json({ success: false, error: "Invalid request body.", code: "INVALID_BODY" }, { status: 400 });
    }

    const input = isRecord(body) ? body : {};
    const jobId = typeof input.jobId === "string" ? input.jobId : null;
    if (!jobId) {
      return NextResponse.json({ success: false, error: "jobId is required.", code: "MISSING_JOB_ID" }, { status: 400 });
    }

    const job = await getScraperJobRow(jobId);
    if (!job) {
      return NextResponse.json({ success: false, error: "Job not found.", code: "JOB_NOT_FOUND" }, { status: 404 });
    }

    // Not an error — the polling loop calling this stops on its own once
    // it sees a paused/terminal status from the job row itself; a request
    // that arrives just after that transition (or a duplicate/overlapping
    // call) simply has nothing to do.
    if (job.status !== "pending" && job.status !== "running") {
      return NextResponse.json({ success: true, jobId, status: job.status, batchRan: false });
    }

    console.log(`[${routeName}] Processing one batch`, {
      userId: user.id,
      jobId,
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
      // This request only ever runs ONE batch, however many the job's own
      // overall run was configured for — savedOptions.maxBatches (from
      // the original Start request) still caps the TOTAL number of
      // batches across every process-batch call combined, checked below.
      maxBatches: 1,
    };

    const totalBatchesAllowed = savedOptions.maxBatches ?? Number.POSITIVE_INFINITY;
    if ((job.current_round ?? 0) >= totalBatchesAllowed) {
      await failScraperJob(jobId, "Reached the maximum batch count without hitting the target — see server logs for details.");
      return NextResponse.json({ success: true, jobId, status: "failed", batchRan: false });
    }

    // Requirement 7 — a resource failure (missing browser, memory guard,
    // a Supabase error) or any other uncaught exception INSIDE this batch
    // attempt must become a real 'failed' status with last_error
    // populated, not be left to sit at 'running' with a frozen heartbeat
    // until recoverStaleLargeScaleJob silently reinterprets that, up to
    // STALE_JOB_RECOVERY_THRESHOLD_MS later, as a pause nobody requested.
    let result: Awaited<ReturnType<typeof runLargeScaleAdminScraper>>;
    try {
      result = await runLargeScaleAdminScraper(options, {
        isPaused: async () => {
          const current = await getScraperJobRow(jobId);
          return current?.status === "paused";
        },
      });
    } catch (batchError) {
      const message = batchError instanceof Error ? batchError.message : "Unexpected error running this batch.";
      console.error(`[${routeName}] Batch attempt threw — marking job failed`, {
        userId: user.id,
        jobId,
        message,
        stack: batchError instanceof Error ? batchError.stack : undefined,
      });
      await failScraperJob(jobId, message);
      return NextResponse.json({ success: true, jobId, status: "failed", batchRan: false });
    }

    // Cumulative totals — this call's own result only covers the ONE
    // batch it just ran, not the job's whole history, so every count is
    // added on top of what was already persisted from earlier calls.
    const insertedCount = job.inserted_count + result.totalImported;
    const validCount = (job.valid_count ?? 0) + result.totalValid;
    const duplicateCount = (job.duplicate_count ?? 0) + result.totalDuplicates;
    const rejectedCount = (job.rejected_count ?? 0) + result.totalRejected;
    const insertFailedCount = (job.insert_failed_count ?? 0) + result.totalInsertFailed;
    const scrapedCount = (job.scraped_count ?? 0) + result.totalScraped;
    const extractedSuccessfullyCount = (job.extracted_successfully_count ?? 0) + result.totalExtractedSuccessfully;
    const extractionFailuresByReason = { ...(job.extraction_failures_by_reason ?? {}) };
    for (const [reason, count] of Object.entries(result.extractionFailuresByReason)) {
      extractionFailuresByReason[reason] = (extractionFailuresByReason[reason] ?? 0) + count;
    }
    const queriesCompleted = (job.queries_completed ?? 0) + result.totalQueriesCompleted;
    const pagesSearched = (job.pages_searched ?? 0) + result.totalPagesSearched;
    const uniqueUrlsDiscovered = (job.unique_urls_discovered ?? 0) + result.totalUniqueUrlsDiscovered;
    const currentRound = (job.current_round ?? 0) + result.batchesRun;

    await updateLargeScaleScraperJobProgress(jobId, {
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
    });

    if (result.stopReason === "paused") {
      // Status is already 'paused' (pauseScraperJob set it directly) —
      // completeScraperJob/failScraperJob would incorrectly overwrite it.
      console.log(`[${routeName}] Job ${jobId} stopped cleanly for pause.`);
    } else if (result.stopReason === "target_reached") {
      await completeScraperJob(jobId, insertedCount);
    } else if (result.stopReason === "consecutive_failures") {
      await failScraperJob(jobId, "Too many consecutive batches failed in a row — see server logs for details.");
    }
    // Any other stopReason (max_batches_reached, from this call's own
    // maxBatches: 1 cap) just means "one batch done, more to do" — the
    // job status stays 'running' for the next process-batch call to pick
    // up; nothing else to do here.

    console.log(`[${routeName}] Batch complete`, {
      userId: user.id,
      jobId,
      stopReason: result.stopReason,
      batchesRun: result.batchesRun,
      insertedCount,
    });

    return NextResponse.json({
      success: true,
      jobId,
      status: result.stopReason === "target_reached" ? "completed" : result.stopReason === "consecutive_failures" ? "failed" : result.stopReason === "paused" ? "paused" : "running",
      batchRan: result.batchesRun > 0,
    });
  } catch (error) {
    console.error(`[${routeName}] Uncaught error processing batch`, {
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return sanitizedErrorResponse(error instanceof Error ? error.message : "Unexpected server error.", 500);
  }
}
