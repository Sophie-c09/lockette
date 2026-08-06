// Narrow admin recovery action for the zero-progress false-failure bug
// (see resumeFalselyFailedZeroProgressJob's own header comment in
// scraper-jobs.ts) — deliberately its own tiny route rather than folded
// into the existing Start/Resume route (../route.ts), so that route's
// own, already-tested paused->running resume behavior is never touched.
// Only ever resumes a job whose error_message matches the zero-progress
// watchdog's exact wording; refuses everything else. Preserves every
// existing counter, checkpoint seenUrls/options, and every already-
// inserted listing untouched — only status/error_message/checkpoint's
// zero-progress streak change.
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isCurrentUserAdmin } from "@/lib/admin";
import { resumeFalselyFailedZeroProgressJob } from "@/lib/scraper-jobs";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export async function POST(request: Request) {
  const routeName = "admin-scraper/large-scale/recover-zero-progress";

  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user || !(await isCurrentUserAdmin(supabase, user.id))) {
      console.warn(`[${routeName}] Unauthorized recovery attempt`, { userId: user?.id ?? null });
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

    const { resumed, job, error } = await resumeFalselyFailedZeroProgressJob(jobId);
    if (!resumed) {
      console.warn(`[${routeName}] Recovery refused`, { userId: user.id, jobId, error });
      return NextResponse.json({ success: false, error: error ?? "Could not recover this job.", code: "RECOVERY_REFUSED" }, { status: 400 });
    }

    console.log(`[${routeName}] Job recovered from false zero-progress failure`, { userId: user.id, jobId });
    return NextResponse.json({ success: true, jobId, status: job?.status ?? "running" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected server error.";
    console.error(`[${routeName}] Uncaught error`, { message, stack: error instanceof Error ? error.stack : undefined });
    return NextResponse.json(
      { error: "Failed to recover this job", code: "RECOVERY_FAILED", details: message },
      { status: 500 },
    );
  }
}
