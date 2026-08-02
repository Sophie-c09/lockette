// Periodic "is this still for sale on the original site" sweep — triggered
// by Vercel Cron (see vercel.json) once a day at 06:00 UTC. Never linked
// from the app itself; the only caller is Vercel's scheduler (or a manual
// curl with the right secret, for testing).
//
// SCHEDULE NOTE: this originally ran every 20 minutes, but Vercel's Hobby
// plan only allows once-daily cron schedules, so vercel.json's entry was
// changed to "0 6 * * *" to keep deploys working. The route's own
// RECHECK_INTERVAL_MINUTES below is unrelated to the cron's own cadence
// (it's the "how stale can a listing's last check be before this run picks
// it up again" window) and is left as-is; it just means, at once-a-day
// invocation, effectively every active listing is eligible each run rather
// than only the ones stale by exactly 20 minutes. Move to a sub-daily
// schedule (or a paid plan) later if fresher availability data is needed.
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

// P0 launch-readiness fix — a SINGLE unavailable signal used to flip a
// listing straight to 'unavailable', with no memory of prior checks. A
// transient false positive (an ambiguous banner, a misfired phrase match)
// could remove a genuinely still-active listing on one bad read. Requiring
// several CONSECUTIVE unavailable signals — reset to 0 by any run that
// does NOT return "unavailable" (see below) — makes an accidental removal
// require the source page to look sold/removed on every check across
// several separate days (this cron runs once daily), not just once.
const CONSECUTIVE_UNAVAILABLE_THRESHOLD = 3;

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
    .select("id, product_url, last_checked_at, consecutive_unavailable_checks, availability_check_count")
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

  const summary = { checked: 0, unavailable: 0, markedUnavailable: 0, inconclusive: 0, skipped: 0 };

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
    const availabilityCheckCount = (listing.availability_check_count ?? 0) + 1;

    if (result.outcome === "unavailable") {
      summary.unavailable++;
      const consecutiveUnavailableChecks = (listing.consecutive_unavailable_checks ?? 0) + 1;
      const reachedThreshold = consecutiveUnavailableChecks >= CONSECUTIVE_UNAVAILABLE_THRESHOLD;

      debugLog(`Listing ${listing.id} got an unavailable signal (${consecutiveUnavailableChecks} consecutive)`, {
        signalSource: result.signalSource,
        detail: result.detail,
        reachedThreshold,
      });

      // Below the threshold: record the signal (so the NEXT run knows how
      // many consecutive hits there have been) but leave status alone —
      // requiring several consecutive hits before treating this as
      // confirmed, not a guess from one page load. `.eq("status", "active")`
      // guards against a race with a concurrent admin action on the same row.
      const { error: updateError } = await supabase
        .from("listings")
        .update({
          ...(reachedThreshold ? { status: "unavailable" as const, removal_reason: result.detail } : {}),
          last_checked_at: now,
          availability_check_count: availabilityCheckCount,
          consecutive_unavailable_checks: consecutiveUnavailableChecks,
        })
        .eq("id", listing.id)
        .eq("status", "active");

      if (updateError) {
        console.error("[check-listing-status] Failed to update listing after an unavailable signal:", updateError);
      } else if (reachedThreshold) {
        summary.markedUnavailable++;
      }
      return;
    }

    // Inconclusive (or a confirmed-available JSON-LD signal, which
    // detectUnavailabilitySignal also reports as inconclusive — see that
    // module's own comment) — the spec's own failsafe: never guess. A
    // fetch that failed, was blocked, or genuinely had no recognizable
    // signal resets consecutive_unavailable_checks to 0 (preserving what
    // "consecutive" actually means — see this route's own threshold
    // comment above) and stamps last_available_at, since this run did NOT
    // find a confirmed-unavailable signal either way. Status itself is
    // left exactly as it was for a later retry.
    summary.inconclusive++;
    const { error: stampError } = await supabase
      .from("listings")
      .update({
        last_checked_at: now,
        last_available_at: now,
        availability_check_count: availabilityCheckCount,
        consecutive_unavailable_checks: 0,
      })
      .eq("id", listing.id);
    if (stampError) {
      console.error("[check-listing-status] Failed to stamp last_checked_at:", stampError);
    }
  });

  debugLog("Batch complete", summary);
  return NextResponse.json({ ...summary, total: candidates.length });
}
