// Manually invokes the exact same production code path route.ts's resume
// branch + runLargeScaleInBackground use — run here as a plain detached
// script (not inside Next's after()) purely so its console output can be
// captured to a log file for the throughput audit, since the live
// next-server process's stdio is unreachable (revoked fds, no controlling
// terminal). No application code is modified by this script.
import {
  claimJobForResume,
  getScraperJobRow,
  updateLargeScaleScraperJobProgress,
  completeScraperJob,
  failScraperJob,
} from "@/lib/scraper-jobs";
import { runLargeScaleAdminScraper, type LargeScaleAdminScraperOptions } from "@/lib/admin-scraper";
import { SCRAPER_CONFIG } from "@/lib/scraper-config";

const JOB_ID = "7da0928b-1045-4728-8120-be1855ce0284";

async function main() {
  const existing = await getScraperJobRow(JOB_ID);
  if (!existing) {
    console.error("Job not found:", JOB_ID);
    return;
  }
  console.log("Existing job status before claim:", existing.status);

  const { claimed, job } = await claimJobForResume(JOB_ID);
  if (!claimed || !job) {
    console.error("Could not claim job for resume — status was:", existing.status);
    return;
  }
  console.log(`[diag] Resumed job ${job.id} — claimed, status now 'running'`);

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
    scrapedCount: job.scraped_count ?? 0,
    currentBatch: job.current_round ?? 0,
    queriesCompleted: job.queries_completed ?? 0,
    pagesSearched: job.pages_searched ?? 0,
    uniqueUrlsDiscovered: job.unique_urls_discovered ?? 0,
  });

  console.log(`[diag] Starting runLargeScaleAdminScraper for job ${job.id} with options:`, options);

  try {
    const result = await runLargeScaleAdminScraper(options, {
      onProgress: (progress) => {
        console.log(`[diag] onProgress fired for job ${job.id}`, progress);
        return updateLargeScaleScraperJobProgress(job.id, {
          insertedCount: progress.insertedCount,
          validCount: progress.validCount,
          duplicateCount: progress.duplicateCount,
          rejectedCount: progress.rejectedCount,
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
        const currentJob = await getScraperJobRow(job.id);
        return currentJob?.status === "paused";
      },
    });

    await updateLargeScaleScraperJobProgress(job.id, {
      insertedCount: result.totalImported,
      validCount: result.totalValid,
      duplicateCount: result.totalDuplicates,
      rejectedCount: result.totalRejected,
      scrapedCount: result.totalScraped,
      currentBatch: result.batchesRun,
      seenUrls: result.seenUrls,
      checkpointOptions: options as unknown as Record<string, unknown>,
      queriesCompleted: result.totalQueriesCompleted,
      pagesSearched: result.totalPagesSearched,
      uniqueUrlsDiscovered: result.totalUniqueUrlsDiscovered,
    });

    if (result.stopReason === "paused") {
      console.log(`[diag] Job ${job.id} stopped cleanly for pause.`);
    } else if (result.stopReason === "consecutive_failures") {
      await failScraperJob(job.id, "Too many consecutive batches failed in a row — see logs for details.");
    } else {
      await completeScraperJob(job.id, result.totalImported);
    }
    console.log(`[diag] Run finished. stopReason=${result.stopReason}`);
  } catch (error) {
    console.error("[diag] Background run failed:", error);
    await failScraperJob(job.id, error instanceof Error ? error.message : "The large-scale scraper failed unexpectedly.");
  }
}

main();
