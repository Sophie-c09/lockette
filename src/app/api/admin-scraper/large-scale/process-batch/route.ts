// Processes exactly ONE bounded batch of a large-scale Inventory Growth
// job per call (embedded/local mode) — the "actual work" half of the
// architecture fix described in ../route.ts's own header comment. That
// route only ever creates or resumes the job row and returns immediately;
// this route is where runLargeScaleAdminScraper (and therefore playwright,
// transitively — see next.config.ts's own comment) actually runs, always
// awaited synchronously within THIS request/response cycle, bounded to
// maxBatches: 1 so a single call finishes well inside this Function's own
// maxDuration rather than attaching an open-ended run to any one request.
//
// RENDER-WORKER MIGRATION — this route no longer OWNS batch execution.
// When INVENTORY_WORKER_MODE=external (scraper-config.ts), a dedicated,
// continuously-running process (src/workers/inventory-growth-worker.ts)
// claims jobs and runs batches itself, entirely outside any Vercel
// request; this route then only reports status so the admin dashboard's
// existing poll loop (ImportListingView.tsx, unchanged) gets a truthful,
// no-op response instead of racing the worker to claim the same job's
// batch lease. In the default/local ("embedded") mode, this route's
// original behavior — actually running one batch per call — is preserved
// unchanged, for local dev and any deployment that hasn't set up the
// external worker yet. The two modes can never run scraping
// simultaneously for the same job: claimBatchLease's own atomic
// "no lease or expired" condition is the same mutex either caller uses.
//
// Invoked repeatedly by the admin dashboard's own polling loop
// (ImportListingView.tsx) for as long as the job stays 'pending'/'running'
// and the dashboard tab stays open. Progress (seenUrls + resolved options)
// is round-tripped through the job's own `checkpoint` column between
// calls, the same mechanism the pause/resume flow already relies on.
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isCurrentUserAdmin } from "@/lib/admin";
import { SINGLE_BATCH_CALL_TIMEOUT_MS, SINGLE_BATCH_CALL_MAX_ATTEMPTS, INVENTORY_WORKER_MODE } from "@/lib/scraper-config";
import { getScraperJobRow, claimBatchLease, releaseBatchLease, type ScraperJobRow } from "@/lib/scraper-jobs";
import { runBatchUnit, type BatchUnitResult } from "@/lib/inventory/batch-unit";
import { getWorkerHealthSummary } from "@/lib/worker/worker-health";

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

    console.info("[INVENTORY_GROWTH][TRACE]", { jobId, stage: "request_received", timestamp: new Date().toISOString() });

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

    // External worker mode, OR auto-detected healthy worker — see this
    // file's own header comment. Report status only; NEVER claim the
    // lease or invoke the scraper here, so this route can never compete
    // with the dedicated worker for the same job. The dashboard's poll
    // loop keeps calling this route unchanged — it just gets a "queued
    // for worker" response instead of a batch result.
    //
    // Final Inventory Growth stabilization pass — root-cause finding:
    // production had a real, deployed, healthy Render worker
    // (render-worker-1, alive with a fresh heartbeat) sitting permanently
    // idle, because INVENTORY_WORKER_MODE was never actually set to
    // "external" on Vercel — this route's own dashboard poll (every ~2s)
    // won the batch-lease race against the worker's own slower poll
    // interval on every single job, every time, so Vercel kept running
    // every batch itself via the OLD short-HTTP-window path this whole
    // migration exists to get away from. Checking worker health directly
    // — regardless of the env var — means the system self-configures
    // correctly the moment a real worker is alive, with no Vercel
    // redeploy or env var required. INVENTORY_WORKER_MODE=external is
    // still honored as an explicit override (e.g. to force this behavior
    // even before a worker's first heartbeat lands).
    const workerHealth = await getWorkerHealthSummary();
    if (INVENTORY_WORKER_MODE === "external" || workerHealth.classification === "online") {
      return NextResponse.json({
        success: true,
        jobId,
        status: job.status,
        batchRan: false,
        queuedForWorker: true,
        workerStatus: workerHealth.classification,
        ...(workerHealth.classification !== "online"
          ? {
              warning:
                workerHealth.classification === "not_configured"
                  ? "No Inventory Growth worker has ever reported in — this job is queued but nothing is currently " +
                    "processing it. Deploy and start the Render worker (npm run worker:inventory-growth)."
                  : "The Inventory Growth worker's last heartbeat is stale — it may have crashed or be restarting. " +
                    "This job stays queued and will resume automatically once the worker is back.",
            }
          : {}),
      });
    }

    // --- Embedded/local mode — no healthy worker detected, and no explicit
    // external-mode override; original behavior, unchanged below --------
    // P0 launch-readiness fix — the status check above does NOT prevent
    // two concurrent process-batch calls for the SAME job from both
    // reaching here (status stays "running" across many sequential calls
    // by design). A short lease (see claimBatchLease's own comment) makes
    // sure only one of them actually runs a batch this poll tick; the
    // other treats it exactly like the status mismatch above — not an
    // error, just "nothing to do this tick."
    const { claimed, leaseId } = await claimBatchLease(jobId);
    if (!claimed) {
      console.log(`[${routeName}] Lost the race for this job's batch lease — another call is already processing it`, {
        userId: user.id,
        jobId,
      });
      return NextResponse.json({ success: true, jobId, status: job.status, batchRan: false });
    }

    // Concurrency/cancellation fix — the lease must only be released once
    // we're actually confident this execution's work has stopped (see
    // runOneBatch's own return value and the header comment on
    // cancellationConfirmed). Releasing unconditionally in a `finally` —
    // the previous behavior — is exactly what let a leaked, still-running
    // background execution and a brand-new execution both hold a valid
    // lease at overlapping times.
    let releaseLease = true;
    try {
      const { response, shouldReleaseLease } = await runOneBatch({ routeName, userId: user.id, jobId, job, leaseId: leaseId! });
      releaseLease = shouldReleaseLease;
      return response;
    } finally {
      if (releaseLease) {
        await releaseBatchLease(jobId, leaseId);
      } else {
        console.warn(
          `[${routeName}] NOT releasing batch lease for job ${jobId} — cancellation could not be confirmed; ` +
            "the lease is held until it naturally expires so no second execution can start concurrently.",
        );
      }
    }
  } catch (error) {
    console.error(`[${routeName}] Uncaught error processing batch`, {
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return sanitizedErrorResponse(error instanceof Error ? error.message : "Unexpected server error.", 500);
  }
}

interface RunOneBatchResult {
  response: Response;
  // Concurrency/cancellation fix — false means this execution's work
  // could NOT be confirmed stopped. The caller (POST, above) must NOT
  // release the batch lease in that case — see runBatchUnit's own comment.
  shouldReleaseLease: boolean;
}

// Thin wrapper around the shared batch-unit pipeline (src/lib/inventory/
// batch-unit.ts) — builds this route's own AbortController (exposed for a
// future pause/lease-loss trigger; the internal watchdog is what actually
// fires it today) and converts the shared result into this route's exact,
// pre-existing public response shape.
async function runOneBatch({
  routeName,
  userId,
  jobId,
  job,
  leaseId,
}: {
  routeName: string;
  userId: string;
  jobId: string;
  job: ScraperJobRow;
  leaseId: string;
}): Promise<RunOneBatchResult> {
  const abortController = new AbortController();

  const result: BatchUnitResult = await runBatchUnit({
    logPrefix: routeName,
    jobId,
    job,
    leaseId,
    signal: abortController.signal,
    batchTimeoutMs: SINGLE_BATCH_CALL_TIMEOUT_MS,
    maxAttemptsPerBatch: SINGLE_BATCH_CALL_MAX_ATTEMPTS,
  });

  console.log(`[${routeName}] Batch complete`, { userId, jobId, status: result.status, batchRan: result.batchRan });

  return {
    response: NextResponse.json({
      success: true,
      jobId: result.jobId,
      status: result.status,
      batchRan: result.batchRan,
      ...(result.warning ? { warning: result.warning } : {}),
    }),
    shouldReleaseLease: result.shouldReleaseLease,
  };
}
