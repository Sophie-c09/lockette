"use server";

// Admin-only read for the Style-Aware Scraper's background job status
// (scraper_jobs, see supabase/schema.sql) — the actual scrape no longer
// runs through a Server Action at all (see src/app/api/admin-scraper/run/route.ts's
// own header comment for why); this file now only exists so
// ImportListingView.tsx's polling loop has a quick, admin-gated read to
// call every couple of seconds, same "Server Action for a fast read"
// convention as getImportDashboardStats (src/lib/import-dashboard.ts).
import { createClient } from "@/lib/supabase/server";
import { isCurrentUserAdmin } from "@/lib/admin";
import type { ScraperJobsDatabase } from "@/lib/supabase/scraper-jobs.types";
import { pauseScraperJobRow, recoverStaleLargeScaleJob, getMostRecentNonTerminalLargeScaleJob, type ScraperJobRow } from "@/lib/scraper-jobs";

export async function getScraperJobStatus(jobId: string): Promise<{ job: ScraperJobRow | null; error?: string }> {
  const supabase = await createClient<ScraperJobsDatabase>();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user || !(await isCurrentUserAdmin(supabase, user.id))) {
    return { job: null, error: "Not authorized." };
  }

  const { data, error } = await supabase.from("scraper_jobs").select("*").eq("id", jobId).maybeSingle();

  if (error) {
    console.error("[get-scraper-job-status] Failed to fetch job:", jobId, error);
    return { job: null, error: "Failed to load scraper job status." };
  }

  if (!data) return { job: null };

  // Stale-job recovery — gated to large-scale (Inventory Growth) rows only
  // (target_count is only ever set by createLargeScaleScraperJob) so the
  // Style-Aware Scraper / Continuous Import job lane, which has no
  // paused/resume lifecycle at all, is completely unaffected. This is what
  // makes a stuck Inventory Growth job self-heal into 'paused' on the very
  // next admin-UI poll (ImportListingView.tsx already polls this every few
  // seconds) instead of only when someone next tries to start a new run.
  if (data.target_count == null) return { job: data };

  const recovered = await recoverStaleLargeScaleJob(data);
  return { job: recovered };
}

// Final Inventory Growth stabilization pass — "the admin UI must always
// load the server-authoritative active job on page load... never depend
// on the current browser having created it." Reuses getActiveLargeScaleJob
// (already the same "is there a pending/running large-scale job" check
// the Start route's own concurrency guard and the Render worker's own
// idle-poll both rely on) so a job started from one browser/session is
// immediately visible from any other, purely from server state — no
// localStorage dependency.
export async function getActiveLargeScaleJobStatus(): Promise<{ job: ScraperJobRow | null; error?: string }> {
  const supabase = await createClient<ScraperJobsDatabase>();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user || !(await isCurrentUserAdmin(supabase, user.id))) {
    return { job: null, error: "Not authorized." };
  }

  try {
    const job = await getMostRecentNonTerminalLargeScaleJob();
    return { job };
  } catch (error) {
    console.error("[get-active-large-scale-job-status] Failed to look up the active job:", error);
    return { job: null, error: "Failed to look up the active job." };
  }
}

/**
 * Pauses a running large-scale ingestion job (src/app/api/admin-scraper/large-scale/route.ts) —
 * only sets the flag on the job row; runLargeScaleAdminScraper
 * (src/lib/admin-scraper.ts) is what actually stops, by checking this
 * flag before starting its NEXT batch. A batch already in flight when
 * this is called still runs to completion — there is no way to interrupt
 * it mid-batch. Resuming is a separate call to that same route
 * (`{ resumeJobId }`), not a Server Action, since it needs to start a new
 * after()-bound background run.
 */
export async function pauseScraperJob(jobId: string): Promise<{ error?: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user || !(await isCurrentUserAdmin(supabase, user.id))) {
    return { error: "Not authorized." };
  }

  return pauseScraperJobRow(jobId);
}
