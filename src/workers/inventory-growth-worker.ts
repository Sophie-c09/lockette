// Dedicated, continuously-running Inventory Growth background worker —
// Render-worker migration. Moves batch execution OUT of Vercel's
// request-bounded process-batch route (see that route's own header
// comment) and into one long-lived process, specifically because a real
// production batch has been observed taking ~268s end to end, longer than
// that route's own SINGLE_BATCH_CALL_TIMEOUT_MS (50s) can ever
// accommodate no matter how it's tuned.
//
// Responsibilities (see this migration's own spec): claiming active jobs,
// discovery, Playwright browser work, URL queue processing, extraction,
// validation, listing insertion, job progress, heartbeat, retry/recovery,
// target completion. Vercel remains responsible for the web app, admin
// dashboard, auth, job creation, and pause/resume/cancel controls — this
// process never creates a job and never serves HTTP.
//
// Deliberately reuses the EXACT same pipeline process-batch/route.ts calls
// (src/lib/inventory/batch-unit.ts's runBatchUnit, itself built on
// runLargeScaleAdminScraper) — this file only supplies a different OUTER
// driver (a while-loop instead of one HTTP request per unit) and different
// timing (WORKER_BATCH_TIMEOUT_MS, WORKER_LEASE_RENEWAL_INTERVAL_MS —
// scraper-config.ts — instead of Vercel's maxDuration-bound values). No
// scraper logic is duplicated.
//
// Run locally with: npm run worker:inventory-growth
// (or directly: npx tsx --env-file=.env.local src/workers/inventory-growth-worker.ts)
//
// Never imported by any src/app route/page/component — Next's build never
// sees this file, and it never runs during `next build`/`next dev`
// startup; it only ever runs as this process's own entrypoint, started
// separately on Render (see Dockerfile.worker/render.yaml).
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import {
  getActiveLargeScaleJob,
  getScraperJobRow,
  claimBatchLease,
  renewBatchLease,
  releaseBatchLease,
  type ScraperJobRow,
} from "@/lib/scraper-jobs";
import { runBatchUnit } from "@/lib/inventory/batch-unit";
import { upsertWorkerHealth } from "@/lib/worker/worker-health";
import { abortableDelay } from "@/lib/concurrency";
import { forceCloseAllTrackedBrowsers, getActiveBrowserCount } from "@/lib/browser-concurrency";
import {
  WORKER_IDLE_POLL_INTERVAL_MS,
  WORKER_LEASE_RENEWAL_INTERVAL_MS,
  WORKER_BATCH_TIMEOUT_MS,
  WORKER_SHUTDOWN_GRACE_MS,
  WORKER_HEARTBEAT_INTERVAL_MS,
  LARGE_SCALE_BATCH_COOLDOWN_MS,
} from "@/lib/scraper-config";

// Stable for this process's entire lifetime — set explicitly via WORKER_ID
// (useful for a fixed identity across restarts on the same Render
// instance) or generated once at startup. Never regenerated per job/unit.
const WORKER_ID = process.env.WORKER_ID || `worker-${hostname()}-${process.pid}-${randomUUID().slice(0, 8)}`;
const APP_VERSION = process.env.RENDER_GIT_COMMIT || process.env.npm_package_version || "unknown";
const STARTED_AT = new Date().toISOString();

let shuttingDown = false;
let currentStage = "starting";
let currentJobId: string | null = null;
let lastSuccessfulUnitAt: string | null = null;
let lastSuccessfulUnit: string | null = null;
let lastError: string | null = null;

async function reportHealth(): Promise<void> {
  await upsertWorkerHealth({
    workerId: WORKER_ID,
    startedAt: STARTED_AT,
    currentJobId,
    currentStage,
    activeBrowserCount: getActiveBrowserCount(),
    lastSuccessfulUnitAt,
    lastSuccessfulUnit,
    lastError,
    appVersion: APP_VERSION,
  });
}

// Independent of lease renewal below (that's per-job; this is "is the
// worker process itself alive," true even while idle with no job at all —
// see WORKER_HEARTBEAT_INTERVAL_MS's own comment).
const heartbeatInterval = setInterval(() => {
  reportHealth().catch((error) => console.error("[inventory-growth-worker] Heartbeat upsert failed:", error));
}, WORKER_HEARTBEAT_INTERVAL_MS);

// Process-wide shutdown signal — SIGTERM/SIGINT abort this immediately;
// every in-flight job's own AbortController (below) is bridged to it, so
// one signal reaches every layer of in-flight discovery/extraction work
// (the same cancellation wiring process-batch/route.ts already relies on
// — see admin-scraper.ts's withBatchWatchdog and scaled-discovery.ts's
// crawlPlatform for how an aborted signal actually stops in-flight
// Playwright work).
const processShutdownController = new AbortController();

/** Runs one job to whatever stopping point it reaches on its own (target
 * reached, paused, failed, or an unconfirmed-cancellation attempt this
 * worker must stop looping on) — claims the lease once, renews it on its
 * own timer for as long as this job keeps running, and releases it only
 * when safe to do so (mirrors process-batch/route.ts's own
 * shouldReleaseLease contract exactly). */
async function runJobToStoppingPoint(job: ScraperJobRow): Promise<void> {
  currentStage = "claiming_job";
  const { claimed, leaseId } = await claimBatchLease(job.id, WORKER_ID);
  if (!claimed || !leaseId) {
    // Lost the race (a future second worker) or migration not applied yet
    // (leaseId null) — either way, nothing to do this tick; the outer loop
    // will look for an eligible job again after a short idle delay.
    return;
  }

  currentJobId = job.id;
  currentStage = "processing_batch";

  // Per-job abort source — aborts on process shutdown OR this job's own
  // lease being lost/superseded (renewal failure, below). Deliberately
  // separate from processShutdownController: losing THIS job's lease must
  // not affect any other in-flight work, and the process controller must
  // remain reusable across every future job this same process picks up.
  const jobAbortController = new AbortController();
  const onProcessShutdown = () => jobAbortController.abort(processShutdownController.signal.reason);
  if (processShutdownController.signal.aborted) {
    jobAbortController.abort(processShutdownController.signal.reason);
  } else {
    processShutdownController.signal.addEventListener("abort", onProcessShutdown, { once: true });
  }

  let leaseLost = false;
  const renewalInterval = setInterval(() => {
    renewBatchLease(job.id, leaseId)
      .then(({ renewed }) => {
        if (!renewed && !leaseLost) {
          leaseLost = true;
          console.error(
            `[inventory-growth-worker] Lease renewal failed for job ${job.id} — another execution now owns it. ` +
              "Aborting this worker's in-flight work for this job.",
          );
          jobAbortController.abort(new Error("Batch lease lost/superseded during renewal"));
        }
      })
      .catch((error) => console.error("[inventory-growth-worker] Lease renewal call threw:", error));
  }, WORKER_LEASE_RENEWAL_INTERVAL_MS);

  let shouldReleaseLease = true;
  try {
    let currentJobRow = job;

    // "Process bounded units repeatedly" — each call is exactly one
    // bounded batch (maxBatches: 1 internally, same as process-batch/
    // route.ts), looped here instead of by repeated HTTP requests.
    //
    // maxAttemptsPerBatch: 1, NOT MAX_BATCH_RETRIES — confirmed live during
    // this migration's own local proof: when an attempt's watchdog times
    // out and cancellation can't be confirmed, its underlying work keeps
    // running detached in the background (same disclosed limitation as
    // process-batch/route.ts). Retrying with a SECOND attempt on top of
    // that (what MAX_BATCH_RETRIES would do — it's built for a standalone,
    // no-outer-loop run) starts a second, concurrent crawl while the
    // first's leaked continuation may still be alive — wasteful and
    // confusing even though not unsafe (the lease guard still prevents any
    // actual corruption). One attempt per unit, same posture as
    // process-batch/route.ts's own SINGLE_BATCH_CALL_MAX_ATTEMPTS: THIS
    // while loop is the real retry mechanism, not an inner one.
    while (!shuttingDown && !leaseLost) {
      const result = await runBatchUnit({
        logPrefix: "inventory-growth-worker",
        jobId: job.id,
        job: currentJobRow,
        leaseId,
        signal: jobAbortController.signal,
        batchTimeoutMs: WORKER_BATCH_TIMEOUT_MS,
        maxAttemptsPerBatch: 1,
      });

      shouldReleaseLease = result.shouldReleaseLease;
      lastSuccessfulUnitAt = new Date().toISOString();
      lastSuccessfulUnit = `job ${job.id}: status=${result.status}, batchRan=${result.batchRan}`;
      lastError = result.warning ?? null;

      if (result.status === "completed" || result.status === "failed" || result.status === "paused") break;

      // Cancellation/concurrency safety — an attempt whose cancellation
      // could NOT be confirmed may still be running in the background
      // using this SAME leaseId (see runBatchUnit's own comment). This
      // worker must NOT immediately start a second, overlapping unit
      // reusing that lease — two simultaneously-active callers sharing one
      // leaseId could race each other's writes, since the lease guard only
      // blocks a DIFFERENT/superseded lease, not a second concurrent
      // caller with the SAME one. Stop looping on this job; the outer loop
      // will only be able to reclaim it once the lease naturally expires
      // (by then any leaked continuation's writes are safely superseded).
      if (!result.cancellationConfirmed) break;

      if (shuttingDown || leaseLost) break;

      try {
        await abortableDelay(LARGE_SCALE_BATCH_COOLDOWN_MS, jobAbortController.signal);
      } catch {
        break; // Aborted during the cooldown — stop, same as any other abort path.
      }

      const refreshed = await getScraperJobRow(job.id);
      if (!refreshed) break;
      currentJobRow = refreshed;
    }
  } finally {
    clearInterval(renewalInterval);
    processShutdownController.signal.removeEventListener("abort", onProcessShutdown);

    if (shouldReleaseLease && !leaseLost) {
      await releaseBatchLease(job.id, leaseId);
    } else {
      console.warn(
        `[inventory-growth-worker] NOT releasing batch lease for job ${job.id} — ` +
          (leaseLost ? "lease was lost/superseded." : "cancellation could not be confirmed.") +
          " It will expire naturally so no overlapping execution can start.",
      );
    }

    currentJobId = null;
    currentStage = "idle";
  }
}

async function mainLoop(): Promise<void> {
  currentStage = "idle";
  await reportHealth().catch(() => {});

  while (!shuttingDown) {
    let job: ScraperJobRow | null = null;
    try {
      job = await getActiveLargeScaleJob();
    } catch (error) {
      console.error("[inventory-growth-worker] Failed to look up an eligible job:", error);
    }

    if (!job) {
      currentStage = "idle";
      currentJobId = null;
      try {
        await abortableDelay(WORKER_IDLE_POLL_INTERVAL_MS, processShutdownController.signal);
      } catch {
        break; // Aborted during idle sleep — shutting down.
      }
      continue;
    }

    try {
      await runJobToStoppingPoint(job);
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      console.error(`[inventory-growth-worker] Uncaught error processing job ${job.id}:`, error);
      currentStage = "idle";
      currentJobId = null;
    }
  }
}

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return; // Idempotent — a second SIGTERM/SIGINT must not double-run this.
  shuttingDown = true;
  currentStage = "shutting_down";
  console.log(
    `[inventory-growth-worker] Received ${signal} — stopping cleanly (up to ${WORKER_SHUTDOWN_GRACE_MS}ms grace period)...`,
  );
  await reportHealth().catch(() => {});

  processShutdownController.abort(new Error(`Worker received ${signal}`));

  // mainLoopPromise (declared below) never rejects — it has its own
  // top-level .catch() — so a plain .then() is enough to know when it's
  // actually finished.
  let mainLoopDone = false;
  const watchedMainLoop = mainLoopPromise.then(() => {
    mainLoopDone = true;
  });

  await Promise.race([watchedMainLoop, new Promise<void>((resolve) => setTimeout(resolve, WORKER_SHUTDOWN_GRACE_MS))]);

  if (!mainLoopDone) {
    console.error(
      "[inventory-growth-worker] Shutdown grace period elapsed with work still in flight — forcing browser " +
        "cleanup and exiting anyway (in-flight discovery/extraction may still be settling in the background; " +
        "its own lease was left unreleased, see runJobToStoppingPoint's own comment).",
    );
    await forceCloseAllTrackedBrowsers(`worker shutdown (${signal}) grace period elapsed`).catch((error) => {
      console.error("[inventory-growth-worker] Forced browser cleanup during shutdown failed:", error);
    });
  }

  clearInterval(heartbeatInterval);
  currentStage = "stopped";
  await reportHealth().catch(() => {});
  console.log("[inventory-growth-worker] Exiting.");
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

console.log(`[inventory-growth-worker] Starting — worker_id=${WORKER_ID}, app_version=${APP_VERSION}`);
const mainLoopPromise = mainLoop().catch((error) => {
  console.error("[inventory-growth-worker] Main loop crashed:", error);
  process.exitCode = 1;
});
