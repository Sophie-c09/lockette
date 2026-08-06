// Final Inventory Growth stabilization pass — explicit, admin-triggered
// cancellation, distinct from pause (resumable) and from a genuine
// failure (failScraperJob). See cancelScraperJob's own header comment in
// scraper-jobs.ts for the full behavior (truthful terminal state, lease
// cleared, only this job's own claimed queue rows released, already-
// inserted listings untouched).
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isCurrentUserAdmin } from "@/lib/admin";
import { cancelScraperJob } from "@/lib/scraper-jobs";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export async function POST(request: Request) {
  const routeName = "admin-scraper/large-scale/cancel";

  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user || !(await isCurrentUserAdmin(supabase, user.id))) {
      console.warn(`[${routeName}] Unauthorized cancel attempt`, { userId: user?.id ?? null });
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

    const { canceled, error } = await cancelScraperJob(jobId);
    if (!canceled) {
      return NextResponse.json({ success: false, error: error ?? "Could not cancel this job.", code: "CANCEL_REFUSED" }, { status: 400 });
    }

    console.log(`[${routeName}] Job canceled`, { userId: user.id, jobId });
    return NextResponse.json({ success: true, jobId, status: "canceled" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected server error.";
    console.error(`[${routeName}] Uncaught error`, { message, stack: error instanceof Error ? error.stack : undefined });
    return NextResponse.json({ error: "Failed to cancel this job", code: "CANCEL_FAILED", details: message }, { status: 500 });
  }
}
