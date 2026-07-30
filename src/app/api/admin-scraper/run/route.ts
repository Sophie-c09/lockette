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
import { runContinuousAdminScraper, type AdminScraperOptions } from "@/lib/admin-scraper";
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

export async function POST(request: Request) {
  console.log("[admin-scraper-run] Scraper started — request received");

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user || !(await isCurrentUserAdmin(supabase, user.id))) {
    return NextResponse.json({ error: "Not authorized." }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
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

  const { job, error: createError } = await createScraperJob(limit);
  if (!job) {
    return NextResponse.json({ error: createError ?? "Failed to start the scraper." }, { status: 500 });
  }

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
      console.error("[admin-scraper-run] Background scrape failed:", error);
      await failScraperJob(job.id, error instanceof Error ? error.message : "The scraper failed unexpectedly.");
    }
  });

  return NextResponse.json({ jobId: job.id });
}
