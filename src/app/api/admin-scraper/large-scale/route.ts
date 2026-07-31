// Large-scale continuous ingestion — "build and maintain a 50,000+ listing
// inventory over time" (src/lib/scraper-config.ts's TARGET_INVENTORY_SIZE).
//
// PRODUCTION CRASH ROOT CAUSE (confirmed live, not guessed): this route
// used to import runLargeScaleAdminScraper directly from
// @/lib/admin-scraper and invoke it via after() to keep the scraper
// running in the background past this request's own response. Two real,
// separate problems with that:
//
//   1. @/lib/admin-scraper.ts transitively imports playwright (via
//      src/lib/browser-concurrency.ts, extraction/browser-extractor.ts,
//      marketplace-discovery.ts, inventory/scaled-discovery.ts) — a
//      native-binary package Next's bundler was trying to statically
//      bundle for this serverless Function. Reproduced directly against
//      production with curl: this route (and /api/admin-scraper/run,
//      which imports the same module) returned Vercel's generic static
//      /500 HTML error page — `x-matched-path: /500`, not this file's
//      own JSON at all — while routes that don't import admin-scraper.ts
//      (/api/inventory/index, /api/stripe/webhook) responded normally.
//      That's exactly what the frontend's old unconditional
//      response.json() call turned into
//      `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
//      Fixed at the config level too (next.config.ts's
//      serverExternalPackages) — but this route no longer needs that
//      import AT ALL once point 2 below is fixed, removing the risk
//      twice over for the one route real users actually click.
//
//   2. Attaching the ENTIRE long-running discovery/extraction loop to a
//      single request via after() cannot actually finish a
//      50,000-listing run: Vercel kills the underlying Function once
//      maxDuration elapses regardless of after()'s own "keeps running
//      past the response" behavior, which only extends how long THIS
//      SAME invocation stays alive — it is not a real background-worker
//      lifetime, and the scraper's own multi-hour target was never
//      going to survive that.
//
// This route now ONLY validates the request and creates/resumes the job
// row in Supabase, returning the job id immediately with status "queued".
// It never imports or calls the scraper. The actual bounded, resumable
// work happens in process-batch/route.ts (one batch per call, well
// inside this Function's own duration limit), invoked repeatedly by the
// admin dashboard's own polling loop (ImportListingView.tsx) while the
// job is active and the dashboard stays open.
import { NextResponse } from "next/server";
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
  createLargeScaleScraperJob,
  getActiveLargeScaleJob,
  claimJobForResume,
  updateLargeScaleScraperJobProgress,
  getScraperJobRow,
  failScraperJob,
} from "@/lib/scraper-jobs";
import type { ListingsDatabase } from "@/lib/supabase/listings.types";

export const maxDuration = 30;

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

// Sanitized shape requested for this feature: never the raw internal
// error, just a stable code + a short, safe details string. The full
// error (including stack) is always logged server-side first — see every
// catch block below.
function sanitizedErrorResponse(details: string, status: number) {
  return NextResponse.json(
    { error: "Failed to start inventory growth", code: "INVENTORY_GROWTH_START_FAILED", details },
    { status },
  );
}

export async function POST(request: Request) {
  const routeName = "admin-scraper/large-scale";

  // Set the moment createLargeScaleScraperJob returns a row — requirement
  // 7: if anything AFTER that point throws (the checkpoint write, or
  // anything else added here later), the job must be left 'failed' with
  // last_error populated, not stuck at 'pending' with no error recorded
  // at all (which recoverStaleLargeScaleJob would otherwise, eventually,
  // silently reinterpret as a pause nobody requested).
  let createdJobId: string | null = null;

  // Everything below is wrapped so this handler ALWAYS returns a Response,
  // even if something throws synchronously (e.g. createAdminClient()
  // throwing when SUPABASE_SERVICE_ROLE_KEY isn't loaded) rather than
  // letting an uncaught exception propagate out of POST() with no
  // response ever sent — which is what a browser's fetch() surfaces as a
  // network-level failure or a framework error page, not a readable JSON
  // error the frontend's own safe parser (src/lib/api-response.ts) can
  // show.
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user || !(await isCurrentUserAdmin(supabase, user.id))) {
      console.warn(`[${routeName}] Unauthorized start/resume attempt`, { userId: user?.id ?? null });
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

    // --- Resume path -----------------------------------------------------
    if (typeof input.resumeJobId === "string") {
      console.log(`[${routeName}] Resume requested`, { userId: user.id, jobId: input.resumeJobId });

      const existing = await getScraperJobRow(input.resumeJobId);
      if (!existing) {
        return NextResponse.json({ success: false, error: "Job not found.", code: "JOB_NOT_FOUND" }, { status: 404 });
      }

      // Atomic claim — this update, not the read above, is what actually
      // decides whether this request gets to resume the job (TOCTOU-safe
      // against a double-click starting two overlapping resumes).
      const { claimed, job } = await claimJobForResume(input.resumeJobId);
      if (!claimed || !job) {
        const current = await getScraperJobRow(input.resumeJobId);
        return NextResponse.json(
          {
            success: false,
            error: `Job is '${current?.status ?? existing.status}', not paused — nothing to resume.`,
            code: "JOB_NOT_PAUSED",
          },
          { status: 400 },
        );
      }

      console.log(`[${routeName}] Resume claimed — job left queued for process-batch`, { userId: user.id, jobId: job.id });
      // No scraper invocation here — see this file's own header comment.
      // The admin dashboard's polling loop calls .../process-batch next.
      return NextResponse.json({ success: true, jobId: job.id, status: "queued" });
    }

    // --- Start path --------------------------------------------------------
    const targetInventorySize =
      typeof input.targetInventorySize === "number" && input.targetInventorySize > 0
        ? Math.floor(input.targetInventorySize)
        : TARGET_INVENTORY_SIZE;
    const batchSize =
      typeof input.batchSize === "number" && input.batchSize > 0 ? Math.floor(input.batchSize) : BATCH_SIZE;
    const mode: ScraperMode = input.mode === "fast" ? "fast" : DEFAULT_SCRAPER_MODE;
    // OVERNIGHT_MODE (requirement 5) — "runs continuously... does not stop
    // after fixed batches." Every real stop condition (target reached,
    // paused, too many consecutive failures) is unaffected; this only
    // picks a much higher maxBatches ceiling, now enforced across every
    // process-batch call for this job rather than within one request.
    const isOvernight = input.overnightMode === true;
    const maxBatches = isOvernight ? OVERNIGHT_MAX_BATCHES : MAX_BATCHES;
    const isAggressive = input.aggressiveMode === true;
    const maxDiscoveryPagesPerQuery =
      typeof input.maxDiscoveryPagesPerQuery === "number" && input.maxDiscoveryPagesPerQuery > 0
        ? Math.floor(input.maxDiscoveryPagesPerQuery)
        : undefined;

    // Required diagnostics (route name, user id — never credentials —
    // target count, batch size, and every selected mode) logged before
    // any DB work, so a later failure in this same request still leaves
    // a trace of exactly what was requested.
    console.log(`[${routeName}] Start requested`, {
      userId: user.id,
      targetInventorySize,
      batchSize,
      mode,
      overnightMode: isOvernight,
      aggressiveMode: isAggressive,
    });

    // Concurrency guard — refuse to start a second large-scale job while
    // one is already active. Paused/completed/failed jobs are correctly
    // NOT matched, so those can still start fresh or be resumed above.
    const activeJob = await getActiveLargeScaleJob();
    if (activeJob) {
      return NextResponse.json(
        { success: false, error: "Inventory Growth is already running", code: "ALREADY_RUNNING", activeJobId: activeJob.id },
        { status: 409 },
      );
    }

    // Plain object, not the LargeScaleAdminScraperOptions type — this
    // route deliberately never imports @/lib/admin-scraper.ts (see this
    // file's own header comment). checkpointOptions is typed as
    // Record<string, unknown> in updateLargeScaleScraperJobProgress
    // regardless, and process-batch/route.ts (which DOES import that
    // type) reads this same shape back out of the job's checkpoint.
    const options: Record<string, unknown> = {
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
    if (!job) {
      console.error(`[${routeName}] createLargeScaleScraperJob failed`, { userId: user.id, createError });
      return sanitizedErrorResponse(createError ?? "Failed to create the scraper job.", 500);
    }
    createdJobId = job.id;

    // Persists the resolved options into the job's own checkpoint (seenUrls
    // explicitly [], not omitted — updateLargeScaleScraperJobProgress only
    // writes the checkpoint column at all when seenUrls is truthy, and an
    // omitted key here would otherwise silently drop checkpointOptions too)
    // so process-batch/route.ts — which never sees this request's body —
    // can rebuild the exact same options on its very first call.
    await updateLargeScaleScraperJobProgress(job.id, {
      insertedCount: 0,
      validCount: 0,
      duplicateCount: 0,
      rejectedCount: 0,
      currentBatch: 0,
      seenUrls: [],
      checkpointOptions: options,
    });

    console.log(`[${routeName}] Job created and queued`, { userId: user.id, jobId: job.id });
    return NextResponse.json({ success: true, jobId: job.id, status: "queued" });
  } catch (error) {
    // Full server-side log — route name, user id (if we got that far),
    // and the complete stack. The client only ever sees the sanitized
    // shape below.
    const message = error instanceof Error ? error.message : "Unexpected server error.";
    console.error(`[${routeName}] Uncaught error in POST handler`, {
      message,
      stack: error instanceof Error ? error.stack : undefined,
    });

    // Requirement 7 — a job row already exists at this point only if the
    // exception happened AFTER createLargeScaleScraperJob returned (e.g.
    // the checkpoint write below it throwing for some reason not already
    // handled internally) — that row must not be left at 'pending'
    // forever with no error recorded; mark it 'failed' with the real
    // error before responding.
    if (createdJobId) {
      await failScraperJob(createdJobId, message);
    }

    return sanitizedErrorResponse(message, 500);
  }
}
