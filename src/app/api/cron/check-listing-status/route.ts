// Periodic "is this still for sale on the original site" sweep — triggered
// by Vercel Cron (see vercel.json) every 20 minutes. Never linked from the
// app itself; the only caller is Vercel's scheduler (or a manual curl with
// the right secret, for testing).
//
// Batches (25 listings/run, oldest-checked-first) and rate-limits its own
// concurrency (see CONCURRENCY below) rather than firing all requests at
// once — "don't hammer sites" from the spec. Never blocks the rest of the
// app: this route runs entirely on its own schedule, outside any user
// request.
import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { checkListingAvailability } from "@/lib/listing-availability-check";
import { mapWithConcurrency } from "@/lib/concurrency";

// Vercel's default serverless function timeout (10s on Hobby) isn't enough
// for a batch of external fetches each with their own 10s timeout (see
// fetchHtml) — this route can legitimately take longer, bounded by
// BATCH_SIZE / CONCURRENCY * FETCH_TIMEOUT in the worst case (every fetch
// timing out).
export const maxDuration = 60;

const BATCH_SIZE = 25;
const RECHECK_INTERVAL_MINUTES = 20;
// How many original-site fetches run at once — bounded so a batch that
// happens to share one domain (e.g. several Depop listings) doesn't
// hammer it with 25 simultaneous requests, while still finishing the
// whole batch well inside maxDuration.
const CONCURRENCY = 5;

function debugLog(message: string, extra?: unknown): void {
  console.log(`[check-listing-status] ${message}`, extra ?? "");
}

export async function GET(request: Request) {
  // CRON_SECRET must be set and match — fails closed (401) if the env var
  // itself is missing, rather than accepting every request until someone
  // remembers to set it. Checked before any Supabase access, per the spec's
  // own ordering.
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = request.headers.get("authorization");

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createAdminClient();
  const cutoff = new Date(Date.now() - RECHECK_INTERVAL_MINUTES * 60 * 1000).toISOString();

  const { data: listings, error } = await supabase
    .from("listings")
    .select("id, product_url, last_checked_at")
    .eq("status", "active")
    .or(`last_checked_at.is.null,last_checked_at.lt.${cutoff}`)
    .order("last_checked_at", { ascending: true, nullsFirst: true })
    .limit(BATCH_SIZE);

  if (error) {
    console.error("[check-listing-status] Failed to fetch listings to check:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const candidates = listings ?? [];
  debugLog(`Checking ${candidates.length} listing(s)`);

  const summary = { checked: 0, unavailable: 0, inconclusive: 0, skipped: 0 };

  await mapWithConcurrency(candidates, CONCURRENCY, async (listing) => {
    const now = new Date().toISOString();

    if (!listing.product_url) {
      // Nothing to fetch — still stamp last_checked_at so this row isn't
      // re-selected on every single run just to be skipped again.
      summary.skipped++;
      const { error: stampError } = await supabase
        .from("listings")
        .update({ last_checked_at: now })
        .eq("id", listing.id);
      if (stampError) {
        console.error("[check-listing-status] Failed to stamp last_checked_at (no product_url):", stampError);
      }
      return;
    }

    const result = await checkListingAvailability(listing.product_url);
    summary.checked++;

    if (result.outcome === "unavailable") {
      summary.unavailable++;
      debugLog(`Listing ${listing.id} flagged unavailable`, {
        signalSource: result.signalSource,
        detail: result.detail,
      });
      const { error: updateError } = await supabase
        .from("listings")
        .update({ status: "unavailable", last_checked_at: now })
        .eq("id", listing.id)
        .eq("status", "active");
      if (updateError) {
        console.error("[check-listing-status] Failed to mark listing unavailable:", updateError);
      }
      return;
    }

    // Inconclusive — the spec's own failsafe: never guess. Fetch failed,
    // was blocked, or genuinely had no recognizable signal — either way,
    // only the checked-at timestamp moves; status is left exactly as it
    // was for a later retry.
    summary.inconclusive++;
    const { error: stampError } = await supabase
      .from("listings")
      .update({ last_checked_at: now })
      .eq("id", listing.id);
    if (stampError) {
      console.error("[check-listing-status] Failed to stamp last_checked_at:", stampError);
    }
  });

  debugLog("Batch complete", summary);
  return NextResponse.json({ ...summary, total: candidates.length });
}
