// Large-scale continuous ingestion — "build and maintain a 50,000+ listing
// inventory over time" (src/lib/scraper-config.ts's TARGET_INVENTORY_SIZE).
// A separate route from /api/admin-scraper/run/route.ts on purpose: that
// route (and runContinuousAdminScraper) is unchanged and still backs the
// existing Style-Aware Scraper / Continuous Import admin UI cards. This
// one runs runLargeScaleAdminScraper (src/lib/admin-scraper.ts) instead —
// same after()-based "return the job id immediately, keep working in the
// background" shape, same maxDuration caveat (see that other route's own
// header comment: after() only runs for the platform's configured max
// duration; on a persistent Node.js server outside a serverless Function
// there is no additional cap, which is what actually lets a run long
// enough to matter for a 50,000-listing target complete at all here).
//
// One request body shape, two behaviors:
//   - { targetInventorySize?, batchSize?, maxPrice?, allowedSources?,
//       brandMode?, categoryFilter?, mode? } — starts a NEW job.
//   - { resumeJobId } — resumes a PAUSED job: reads that job's own
//     checkpoint (seenUrls + the options it was started with) and starts
//     a fresh background run continuing from there. This is a NEW
//     after()-bound execution, not the original paused one un-suspended —
//     see runLargeScaleAdminScraper's own header comment on why "resume"
//     has to work this way given no persistent worker/queue exists.
import { NextResponse, after } from "next/server";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isCurrentUserAdmin } from "@/lib/admin";
import {
  SCRAPER_CONFIG,
  TARGET_INVENTORY_SIZE,
  BATCH_SIZE,
  MAX_BATCHES,
  DEFAULT_SCRAPER_MODE,
  OVERNIGHT_MODE,
  OVERNIGHT_MAX_BATCHES,
  type ScraperMode,
} from "@/lib/scraper-config";
import {
  runLargeScaleAdminScraper,
  type LargeScaleAdminScraperOptions,
} from "@/lib/admin-scraper";
import {
  createLargeScaleScraperJob,
  getActiveLargeScaleJob,
  claimJobForResume,
  updateLargeScaleScraperJobProgress,
  getScraperJobRow,
  completeScraperJob,
  failScraperJob,
} from "@/lib/scraper-jobs";
import type { ListingsDatabase } from "@/lib/supabase/listings.types";

export const maxDuration = 300;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const strings = value.filter((entry): entry is string => typeof entry === "string");
  return strings.length > 0 ? strings : null;
}

async function currentListingsCount(): Promise<number> {
  const supabase = createAdminClient<ListingsDatabase>();
  const { count, error } = await supabase.from("listings").select("id", { count: "exact", head: true });
  if (error) {
    console.error("[admin-scraper-large-scale] Failed to read current inventory count:", error);
    return 0;
  }
  return count ?? 0;
}

export async function POST(request: Request) {
  // Diagnostic — "frontend shows failed to fetch when starting Inventory
  // Growth" investigation. Printed before anything else in the handler,
  // including auth, so a request that fails before ever reaching a
  // response still leaves a trace of having arrived at all.
  console.log("[route] request received");

  // Everything below is wrapped so this handler ALWAYS returns a Response,
  // even if something throws synchronously (e.g. createAdminClient()
  // throwing when SUPABASE_SERVICE_ROLE_KEY isn't loaded — see its own
  // comment) rather than returning an {error} result. Before this, an
  // uncaught throw anywhere in this function propagated straight out of
  // POST() with no try/catch at all beyond the narrow request.json() one
  // — exactly the gap that can make a request look like it never got a
  // response, rather than a clean error the frontend's own fetch() call
  // can read and display.
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user || !(await isCurrentUserAdmin(supabase, user.id))) {
      console.log("[route] response sent");
      return NextResponse.json({ success: false, error: "Not authorized." }, { status: 401 });
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      console.log("[route] response sent");
      return NextResponse.json({ success: false, error: "Invalid request body." }, { status: 400 });
    }

    const input = isRecord(body) ? body : {};

    // --- Resume path -----------------------------------------------------
    if (typeof input.resumeJobId === "string") {
      const existing = await getScraperJobRow(input.resumeJobId);
      if (!existing) {
        console.log("[route] response sent");
        return NextResponse.json({ success: false, error: "Job not found." }, { status: 404 });
      }

      // Atomic claim (resume-lifecycle fix) — this update, not the read
      // above, is what actually decides whether this request gets to
      // resume the job. It's the only thing standing between a genuine
      // resume and a double-click starting two background executions for
      // the same job: only the request whose UPDATE actually matches a
      // still-'paused' row (claimed: true) proceeds past this point: see
      // claimJobForResume's own header comment for why the read above can't
      // be trusted for that decision on its own (TOCTOU).
      const { claimed, job } = await claimJobForResume(input.resumeJobId);
      if (!claimed || !job) {
        // Re-read rather than trusting `existing.status` here — under a
        // race (two near-simultaneous resume clicks) `existing` can be
        // stale by the time the claim above ran, which would otherwise
        // report the job as still 'paused' in the very error message
        // explaining that it's no longer paused.
        const current = await getScraperJobRow(input.resumeJobId);
        console.log("[route] response sent");
        return NextResponse.json(
          {
            success: false,
            error: `Job is '${current?.status ?? existing.status}', not paused — nothing to resume.`,
          },
          { status: 400 },
        );
      }

      const checkpoint = job.checkpoint ?? {};
      const resumedOptions = (checkpoint.options as LargeScaleAdminScraperOptions | undefined) ?? {
        maxPrice: SCRAPER_CONFIG.maxPrice,
        minStyleScore: SCRAPER_CONFIG.minStyleScore,
        minImageScore: SCRAPER_CONFIG.minImageScore,
        allowedSources: SCRAPER_CONFIG.allowedSources,
        brandMode: null,
        categoryFilter: null,
      };

      const options: LargeScaleAdminScraperOptions = {
        ...resumedOptions,
        seenUrls: checkpoint.seenUrls ?? [],
      };

      await updateLargeScaleScraperJobProgress(job.id, {
        insertedCount: job.inserted_count,
        validCount: job.valid_count ?? 0,
        duplicateCount: job.duplicate_count ?? 0,
        rejectedCount: job.rejected_count ?? 0,
        insertFailedCount: job.insert_failed_count ?? 0,
        extractedSuccessfullyCount: job.extracted_successfully_count ?? 0,
        extractionFailuresByReason: job.extraction_failures_by_reason ?? {},
        scrapedCount: job.scraped_count ?? 0,
        currentBatch: job.current_round ?? 0,
        queriesCompleted: job.queries_completed ?? 0,
        pagesSearched: job.pages_searched ?? 0,
        uniqueUrlsDiscovered: job.unique_urls_discovered ?? 0,
      });

      // Fire-and-forget by design — runLargeScaleInBackground is a plain
      // (non-async) function whose only job is to call after() synchronously
      // and return; it never returns a Promise for this route to (wrongly)
      // await, so it cannot delay the response below. See after()'s own
      // Next.js contract: it must be invoked during the request's own
      // synchronous/awaited execution (which this is), and it runs its
      // callback only once the response has actually been sent.
      runLargeScaleInBackground(job.id, options);

      console.log("[route] response sent");
      return NextResponse.json({ success: true, jobId: job.id });
    }

    // --- Start path --------------------------------------------------------
    // TEMPORARY diagnostic — "Inventory Growth never reaches batch 1" investigation.
    console.log("[diag] 1. API route received Start request", { body: input });

    // Concurrency guard — refuse to start a second large-scale job while one
    // is already active (see getActiveLargeScaleJob's own header comment for
    // why this checks 'pending' as well as 'running'). Paused/completed/
    // failed jobs are correctly NOT matched, so those can still start fresh
    // or be resumed via the Resume path above.
    const activeJob = await getActiveLargeScaleJob();
    if (activeJob) {
      console.log("[route] response sent");
      return NextResponse.json(
        { success: false, error: "Inventory Growth is already running", activeJobId: activeJob.id },
        { status: 409 },
      );
    }

    const targetInventorySize =
      typeof input.targetInventorySize === "number" && input.targetInventorySize > 0
        ? Math.floor(input.targetInventorySize)
        : TARGET_INVENTORY_SIZE;
    const batchSize =
      typeof input.batchSize === "number" && input.batchSize > 0 ? Math.floor(input.batchSize) : BATCH_SIZE;
    const mode: ScraperMode = input.mode === "fast" ? "fast" : DEFAULT_SCRAPER_MODE;
    // OVERNIGHT_MODE (requirement 5) — "runs continuously... does not stop
    // after fixed batches." Every real stop condition (target reached,
    // paused, too many consecutive failures) is unaffected; this only picks
    // a much higher maxBatches ceiling. See scraper-config.ts's own comment
    // on OVERNIGHT_MAX_BATCHES for why it's a higher backstop, not "no
    // limit."
    const isOvernight = input.overnightMode === true;
    const maxBatches = isOvernight ? OVERNIGHT_MAX_BATCHES : MAX_BATCHES;
    // OVERNIGHT_AGGRESSIVE — independent of overnightMode (orthogonal
    // settings, see LargeScaleAdminScraperOptions' own comment): "how long
    // to keep going" vs. "how each batch acquires listings."
    const isAggressive = input.aggressiveMode === true;
    const maxDiscoveryPagesPerQuery =
      typeof input.maxDiscoveryPagesPerQuery === "number" && input.maxDiscoveryPagesPerQuery > 0
        ? Math.floor(input.maxDiscoveryPagesPerQuery)
        : undefined;

    const options: LargeScaleAdminScraperOptions = {
      maxPrice: typeof input.maxPrice === "number" ? input.maxPrice : SCRAPER_CONFIG.maxPrice,
      minStyleScore: SCRAPER_CONFIG.minStyleScore,
      minImageScore: SCRAPER_CONFIG.minImageScore,
      allowedSources: parseStringArray(input.allowedSources) ?? SCRAPER_CONFIG.allowedSources,
      brandMode: parseStringArray(input.brandMode),
      categoryFilter: parseStringArray(input.categoryFilter),
      targetInventorySize,
      batchSize,
      maxBatches,
      mode,
      ...(isOvernight ? { runMode: OVERNIGHT_MODE } : {}),
      ...(maxDiscoveryPagesPerQuery != null ? { maxDiscoveryPagesPerQuery } : {}),
      aggressiveAcquisition: isAggressive,
    };

    const currentCount = await currentListingsCount();
    const estimatedTotalBatches = Math.min(
      maxBatches,
      Math.max(1, Math.ceil(Math.max(0, targetInventorySize - currentCount) / batchSize)),
    );

    const { job, error: createError } = await createLargeScaleScraperJob(targetInventorySize, estimatedTotalBatches, mode);
    // TEMPORARY diagnostic — "Inventory Growth never reaches batch 1" investigation.
    console.log("[diag] 2. createLargeScaleScraperJob completed", { jobId: job?.id, createError });
    if (!job) {
      console.log("[route] response sent");
      return NextResponse.json(
        { success: false, error: createError ?? "Failed to start large-scale ingestion." },
        { status: 500 },
      );
    }

    // Fire-and-forget — see the resume path's own comment on why this
    // cannot delay the response below.
    runLargeScaleInBackground(job.id, options);

    console.log("[route] response sent");
    return NextResponse.json({ success: true, jobId: job.id });
  } catch (error) {
    // Safety net for exactly the failure mode reported: without this, an
    // exception thrown anywhere above (not just a query returning
    // {error}, but e.g. createAdminClient() throwing synchronously)
    // propagated out of POST() with no response ever sent — which is what
    // a browser's fetch() surfaces as "Failed to fetch," not as a
    // readable error. This guarantees a JSON response even then.
    console.error("[admin-scraper-large-scale] Uncaught error in POST handler:", error);
    console.log("[route] response sent");
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Unexpected server error." },
      { status: 500 },
    );
  }
}

function runLargeScaleInBackground(jobId: string, options: LargeScaleAdminScraperOptions) {
  after(async () => {
    // TEMPORARY diagnostic — "Inventory Growth never reaches batch 1" investigation.
    console.log(`[diag] 3. after() background task began for job ${jobId}`);
    try {
      // TEMPORARY diagnostic — "Inventory Growth never reaches batch 1" investigation.
      console.log(`[diag] 4a. about to call runLargeScaleAdminScraper() for job ${jobId}`);
      const result = await runLargeScaleAdminScraper(options, {
        onProgress: (progress) => {
          // TEMPORARY diagnostic — "Inventory Growth never reaches batch 1" investigation.
          console.log(`[diag] 8. onProgress fired -> attempting updateLargeScaleScraperJobProgress for job ${jobId}`, progress);
          return updateLargeScaleScraperJobProgress(jobId, {
            insertedCount: progress.insertedCount,
            validCount: progress.validCount,
            duplicateCount: progress.duplicateCount,
            rejectedCount: progress.rejectedCount,
            insertFailedCount: progress.insertFailedCount,
            extractedSuccessfullyCount: progress.extractedSuccessfullyCount,
            extractionFailuresByReason: progress.extractionFailuresByReason,
            scrapedCount: progress.scrapedCount,
            currentBatch: progress.currentBatch,
            failedBatchCount: progress.failedBatchCount,
            checkpointOptions: options as unknown as Record<string, unknown>,
            queriesCompleted: progress.queriesCompleted,
            pagesSearched: progress.pagesSearched,
            uniqueUrlsDiscovered: progress.uniqueUrlsDiscovered,
          });
        },
        isPaused: async () => {
          const job = await getScraperJobRow(jobId);
          return job?.status === "paused";
        },
      });

      // Final checkpoint write — captures every URL tried across the
      // whole run, so a later resume (if this stopped for a reason other
      // than reaching the target) starts from the fullest seenUrls set.
      // updateLargeScaleScraperJobProgress never touches `status` (see its
      // own header comment), so this can't stomp the "paused" status
      // pauseScraperJobRow already set even when stopReason is "paused".
      await updateLargeScaleScraperJobProgress(jobId, {
        insertedCount: result.totalImported,
        validCount: result.totalValid,
        duplicateCount: result.totalDuplicates,
        rejectedCount: result.totalRejected,
        insertFailedCount: result.totalInsertFailed,
        extractedSuccessfullyCount: result.totalExtractedSuccessfully,
        extractionFailuresByReason: result.extractionFailuresByReason,
        scrapedCount: result.totalScraped,
        currentBatch: result.batchesRun,
        seenUrls: result.seenUrls,
        checkpointOptions: options as unknown as Record<string, unknown>,
        queriesCompleted: result.totalQueriesCompleted,
        pagesSearched: result.totalPagesSearched,
        uniqueUrlsDiscovered: result.totalUniqueUrlsDiscovered,
      });

      if (result.stopReason === "paused") {
        // Status is already 'paused' (pauseScraperJob set it directly) —
        // completeScraperJob/failScraperJob would incorrectly overwrite it.
        console.log(`[admin-scraper-large-scale] Job ${jobId} stopped cleanly for pause.`);
      } else if (result.stopReason === "consecutive_failures") {
        await failScraperJob(jobId, "Too many consecutive batches failed in a row — see server logs for details.");
      } else {
        await completeScraperJob(jobId, result.totalImported);
      }

      revalidatePath("/admin/listings");
      revalidatePath("/admin/import");
    } catch (error) {
      console.error("[admin-scraper-large-scale] Background run failed:", error);
      await failScraperJob(jobId, error instanceof Error ? error.message : "The large-scale scraper failed unexpectedly.");
    }
  });
}
