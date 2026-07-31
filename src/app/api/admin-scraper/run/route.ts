// Background entry point for the Style-Aware Admin Scraper — replaces the
// old synchronous runStyleAwareScrape Server Action (src/app/actions/admin-scraper.ts),
// which used to await runAdminScraper's full multi-minute run inside one
// request/response cycle. This route instead creates a scraper_jobs row,
// returns its id immediately, and runs the actual scrape via after() —
// scheduled work that keeps executing after the response has already been
// sent, so it no longer depends on the admin's browser staying connected.
// The admin UI (ImportListingView.tsx) polls getScraperJobStatus
// (src/app/actions/admin-scraper.ts) against that row for progress.
//
// This route lives under /api/, not /admin/ — src/app/admin/layout.tsx's
// shared auth gate only covers page routes, not API routes, so the admin
// check below is this route's own, real enforcement boundary (not
// decorative), same convention as /api/bulk-import/discover.
//
// Caveat worth being explicit about: after()'s own docs state it "will run
// for the platform's default or configured max duration of your route" —
// it is NOT a true unbounded background worker. maxDuration below is set
// as high as this codebase's own existing precedent goes (matching
// /api/bulk-import/discover's 300s), so a scrape genuinely has minutes to
// run, and it now survives the admin closing their tab — but if this app
// is ever deployed as a real Vercel serverless Function (see vercel.json's
// cron config and check-listing-status/route.ts's own maxDuration
// comments), execution is still capped at whatever that route's
// maxDuration resolves to on the actual hosting plan. On a persistent
// Node.js server (e.g. `next start` outside Vercel Functions), there is no
// such additional cap at all.
//
// This caveat matters a lot more now that this route runs
// runContinuousAdminScraper (src/lib/admin-scraper.ts) instead of a single
// runAdminScraper batch — continuous ingestion is explicitly meant to keep
// importing "over time" across many batches, which can easily run well
// past 300s. On a real Vercel Function this background work would still
// be cut off at that ceiling (whatever's already been inserted stays
// inserted — each batch commits its own rows before the next one starts —
// but scraper_jobs would never see completeScraperJob called, so the job
// row stays "running"/stale rather than reporting a clean stop reason).
// On a persistent Node.js server there is no such cap.
import { NextResponse, after } from "next/server";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { isCurrentUserAdmin } from "@/lib/admin";
import { SCRAPER_CONFIG } from "@/lib/scraper-config";
// Type-only — erased entirely at compile time (no runtime import/require
// call ever happens for it), so this can never be the source of a
// module-evaluation crash the way a VALUE import of "@/lib/admin-scraper"
// could be (see this route's own dynamic import of runContinuousAdminScraper
// below, and that module's own transitively-Playwright-importing
// dependency graph).
import type { AdminScraperOptions } from "@/lib/admin-scraper";
import {
  createScraperJob,
  markScraperJobRunning,
  updateScraperJobProgress,
  completeScraperJob,
  failScraperJob,
} from "@/lib/scraper-jobs";

export const maxDuration = 300;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const strings = value.filter((entry): entry is string => typeof entry === "string");
  return strings.length > 0 ? strings : null;
}

// Sanitized shape, same convention as /api/admin-scraper/large-scale's own
// sanitizedErrorResponse — a stable code + a short details string, never
// a raw internal error. The full error (message + stack) is always
// logged server-side first, in every catch block below. `error` is a
// generic, stable label — `details` is where the REAL underlying reason
// lives (e.g. "Cannot find module '.../playwright-core/browsers.json'"),
// per this feature's own "do not hide the actual exception behind a
// generic message" requirement — see parseApiResponse's own handling of
// this same field (src/lib/api-response.ts).
function sanitizedErrorResponse(details: string, status: number) {
  return NextResponse.json(
    { error: "Failed to start the scraper", code: "ADMIN_SCRAPER_RUN_START_FAILED", details },
    { status },
  );
}

// Structured per-stage tracing (Continuous Import startup-failure
// investigation) — one line per stage of the 7-step start flow, so a
// future failure can be pinned to an EXACT stage from logs alone, rather
// than only "the handler threw, somewhere."
function logStartStage(stage: string, createdJobId: string | null): void {
  console.info("[CONTINUOUS_IMPORT][START_STAGE]", {
    stage,
    jobId: createdJobId,
    timestamp: new Date().toISOString(),
  });
}

export async function POST(request: Request) {
  const routeName = "admin-scraper/run";
  console.log(`[${routeName}] Scraper started — request received`);

  // Set the moment createScraperJob returns a row — if the dynamic import
  // below (or anything else after this point) throws, this job must be
  // left 'failed' with a real error, not orphaned at its initial status
  // forever — same reasoning as /api/admin-scraper/large-scale's own
  // createdJobId tracking.
  let createdJobId: string | null = null;

  // "Continuous Import returns HTML instead of JSON" root cause #1
  // (fixed previously): this handler had NO outer try/catch — any
  // synchronous throw before the response was sent propagated straight
  // out of POST() as an uncaught exception, and Next.js/Vercel's own
  // crash handling served its generic HTML error page instead of this
  // route's JSON. Wrapping everything below in one try/catch, same as
  // the sibling /api/admin-scraper/large-scale routes, is what makes this
  // handler ALWAYS return a Response no matter what throws.
  //
  // Root cause #2 (this pass): a try/catch INSIDE this function body
  // cannot catch a failure in this file's own top-level `import`
  // statements — those are evaluated when the MODULE loads, before any
  // of this function's own code (including the try block itself) ever
  // runs. "@/lib/admin-scraper" (runContinuousAdminScraper) transitively
  // imports Playwright (browser-concurrency.ts, extraction/
  // browser-extractor.ts, marketplace-discovery.ts, inventory/
  // scaled-discovery.ts — confirmed via `npx madge` against this exact
  // route) — if evaluating that module ever throws, on the module graph
  // built for THIS route specifically, no try/catch written here could
  // ever have caught it, no matter how defensively this function body is
  // written. A dynamic `await import(...)`, by contrast, runs AT
  // RUNTIME — inside this function, inside this try block — so its
  // rejection is just another value this catch already handles.
  try {
    logStartStage("authenticate_user", createdJobId);
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    logStartStage("verify_admin", createdJobId);
    if (!user || !(await isCurrentUserAdmin(supabase, user.id))) {
      console.warn(`[${routeName}] Unauthorized start attempt`, { userId: user?.id ?? null });
      return NextResponse.json({ error: "Not authorized." }, { status: 401 });
    }

    logStartStage("parse_request", createdJobId);
    let body: unknown;
    try {
      body = await request.json();
    } catch (error) {
      console.error(`[${routeName}] Invalid request body`, { userId: user.id, error });
      return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
    }

    const input = isRecord(body) ? body : {};
    const limit =
      typeof input.limit === "number" && input.limit > 0 ? Math.floor(input.limit) : SCRAPER_CONFIG.limit;

    const options: AdminScraperOptions = {
      maxPrice: typeof input.maxPrice === "number" ? input.maxPrice : SCRAPER_CONFIG.maxPrice,
      minStyleScore: SCRAPER_CONFIG.minStyleScore,
      minImageScore: SCRAPER_CONFIG.minImageScore,
      allowedSources: parseStringArray(input.allowedSources) ?? SCRAPER_CONFIG.allowedSources,
      brandMode: parseStringArray(input.brandMode),
      categoryFilter: parseStringArray(input.categoryFilter),
      limit,
    };

    logStartStage("create_scraper_job", createdJobId);
    const { job, error: createError } = await createScraperJob(limit);
    if (!job) {
      console.error(`[${routeName}] createScraperJob failed`, { userId: user.id, createError });
      return sanitizedErrorResponse(createError ?? "Failed to create the scraper job.", 500);
    }
    createdJobId = job.id;

    console.log(`[${routeName}] Job created`, { userId: user.id, jobId: job.id, limit });
    logStartStage("scraper_job_created", createdJobId);

    // Dynamic import, not a top-level one — see this function's own
    // comment above for why. Evaluated here, still inside this try block,
    // BEFORE the response is returned: if loading this module throws, the
    // outer catch below marks the already-created job 'failed' (via
    // createdJobId) and returns a real error response, instead of either
    // crashing uncaught (the original bug) or silently returning a
    // `{ jobId }` success response for a job that can now never actually
    // run.
    logStartStage("dynamic_import_admin_scraper", createdJobId);
    const { runContinuousAdminScraper } = await import("@/lib/admin-scraper");
    logStartStage("dynamic_import_succeeded", createdJobId);

    logStartStage("register_background_runner", createdJobId);
    after(async () => {
      try {
        await markScraperJobRunning(job.id);

        const result = await runContinuousAdminScraper(options, (progress) =>
          updateScraperJobProgress(job.id, {
            scrapedCount: progress.scrapedCount,
            scoredCount: progress.scoredCount,
            passedCount: progress.passedCount,
            insertedCount: progress.insertedCount,
            errorCount: progress.errorCount,
            lastProcessedUrl: progress.lastProcessedUrl,
          }),
        );

        // "consecutive_failures" is the one stop reason that means every
        // recent batch actually errored out (not just found nothing) — every
        // other stop reason (target/max-batches/no-new-listings) means the
        // run did real, legitimate work and just stopped for a normal
        // reason, same as a single batch's own shortfall not being an error.
        if (result.stopReason === "consecutive_failures") {
          const lastError = result.batches.at(-1)?.error ?? "The scraper failed too many times in a row.";
          await failScraperJob(job.id, lastError);
        } else {
          await completeScraperJob(job.id, result.totalImported);
        }

        revalidatePath("/admin/listings");
        revalidatePath("/admin/import");
      } catch (error) {
        console.error(`[${routeName}] Background scrape failed:`, error);
        await failScraperJob(job.id, error instanceof Error ? error.message : "The scraper failed unexpectedly.");
      }
    });

    logStartStage("return_response", createdJobId);
    return NextResponse.json({ jobId: job.id });
  } catch (error) {
    // Whatever stage's log line above this is the LAST one that printed
    // is the stage that was in progress when this fired — there's no
    // stage-by-stage try/catch (that would just re-implement the same
    // "mark failed, return JSON" logic seven times), so this one catch
    // covers every stage; the log trail is what pins down which one.
    logStartStage("failed", createdJobId);
    // Full server-side log — route name, and the complete stack. The
    // client only ever sees the sanitized shape below.
    const message = error instanceof Error ? error.message : "Unexpected server error.";
    console.error("[CONTINUOUS_IMPORT][UNHANDLED]", {
      route: routeName,
      message,
      stack: error instanceof Error ? error.stack : undefined,
    });

    // A job row already exists at this point only if the exception
    // happened AFTER createScraperJob returned (e.g. the dynamic import
    // above throwing) — that row must not be left at its initial status
    // forever with no error recorded.
    if (createdJobId) {
      await failScraperJob(createdJobId, message);
    }

    return sanitizedErrorResponse(message, 500);
  }
}
