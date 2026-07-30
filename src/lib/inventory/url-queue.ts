// Persistent URL queue (OVERNIGHT_AGGRESSIVE, requirement 1/3) — the
// actual fix for "inventory acquisition blocked by expensive enrichment":
// discovery's ONLY job is finding candidate URLs and writing them here;
// extraction workers claim batches from this table independently,
// completely decoupled from however discovery is currently pacing. Same
// proven shape as src/lib/inventory/enrichment-queue.ts (stale-claim
// reclaim, bounded batch claims, never a full-table load) — deliberately
// not a third variant of that same pattern, just applied to raw URLs
// instead of already-imported listings.
import { createAdminClient } from "@/lib/supabase/admin";
import type { UrlQueueDatabase, UrlQueueRow } from "@/lib/supabase/url-queue.types";

function client() {
  return createAdminClient<UrlQueueDatabase>();
}

function isMissingTableError(error: { code?: string; message: string }): boolean {
  return (
    error.code === "42P01" ||
    error.code === "PGRST205" ||
    /relation .* does not exist/i.test(error.message) ||
    /could not find the table/i.test(error.message)
  );
}

// Every function below already logged its own failures, but as a plain
// console.error indistinguishable from a transient network blip — for the
// actual live failure mode (scraper_url_queue not existing on this
// database at all, confirmed directly), that meant EVERY discovery/
// extraction call in aggressive mode was silently failing the same way,
// forever, with no signal pointing at the real, fixable cause. This
// surfaces that specific case with one clear, actionable, greppable
// warning instead.
function warnIfMissingTable(fn: string, error: { code?: string; message: string }): void {
  if (isMissingTableError(error)) {
    console.error(
      `[url-queue] ${fn} failed — scraper_url_queue does not exist on this database. ` +
        "Aggressive/overnight mode (OVERNIGHT_AGGRESSIVE) cannot discover or extract anything until " +
        "the latest supabase/schema.sql migration for this table is applied.",
    );
  }
}

export interface UrlQueueEntry {
  url: string;
  platform: string;
  query: string;
  page: number;
}

/**
 * Enqueues discovered URLs — upserted on the `url` unique index, so
 * re-discovering the same URL (a different query/page surfacing
 * something already queued) just leaves the existing row alone rather
 * than creating a second extraction job for it. Never throws (best-
 * effort, same posture as enrichment-queue.ts): a failed enqueue means
 * this run's own in-memory discovery count is slightly ahead of what's
 * durably queued, not a correctness problem for the caller.
 */
export async function enqueueUrls(entries: UrlQueueEntry[]): Promise<void> {
  if (entries.length === 0) return;
  const supabase = client();

  const { error } = await supabase.from("scraper_url_queue").upsert(
    entries.map((entry) => ({
      url: entry.url,
      platform: entry.platform,
      query: entry.query,
      page: entry.page,
      status: "pending" as const,
    })),
    { onConflict: "url", ignoreDuplicates: true },
  );

  if (error) {
    console.error("[url-queue] Failed to enqueue URLs:", error);
    warnIfMissingTable("enqueueUrls", error);
    return;
  }

  // Discovery/extraction handoff tracing — the counterpart to
  // scaled-discovery.ts's own "[DISCOVERY] URLs discovered" log. Comparing
  // the two directly answers "did what discovery found actually reach the
  // queue" without needing to separately poll getUrlQueueStats. Note this
  // logs `entries.length` attempted, not rows actually inserted —
  // `ignoreDuplicates: true` means some of these may already exist
  // (re-discovered on a different query/page) and are silently no-ops on
  // conflict; Postgres/PostgREST doesn't report how many of an upsert
  // batch were skipped as pre-existing vs newly inserted, so this can't
  // distinguish the two without a separate follow-up query this function
  // deliberately doesn't add (see this file's own header comment on
  // staying best-effort/cheap).
  console.log("[url-queue] Inserted into extraction queue", {
    attempted: entries.length,
    platforms: Array.from(new Set(entries.map((entry) => entry.platform))),
  });
}

// Same reasoning as enrichment-queue.ts's own STALE_PROCESSING_THRESHOLD_MS
// — a URL stuck 'claimed' this long means whatever extraction worker
// claimed it crashed/was killed mid-batch, not that it's still genuinely
// being worked on.
const STALE_CLAIM_THRESHOLD_MS = 10 * 60 * 1000;

/**
 * Claims up to `batchSize` URLs by flipping them to 'claimed' — bounded,
 * never the whole queue. Prefers genuinely 'pending' rows, but also
 * reclaims any 'claimed' row stuck past STALE_CLAIM_THRESHOLD_MS (a
 * crashed prior extraction worker), so a crash mid-run never permanently
 * strands those URLs. Independent of whatever discovery is doing at the
 * same moment — this is what "extraction workers consume queue items
 * independently" actually means in a single Node process: extraction
 * reads whatever is durably queued right now, regardless of whether this
 * exact discovery pass has finished, is still running, or already
 * crashed.
 */
export async function claimNextUrls(batchSize: number): Promise<UrlQueueRow[]> {
  const supabase = client();
  const staleCutoff = new Date(Date.now() - STALE_CLAIM_THRESHOLD_MS).toISOString();

  const { data: candidates, error: selectError } = await supabase
    .from("scraper_url_queue")
    .select("*")
    .or(`status.eq.pending,and(status.eq.claimed,created_at.lt.${staleCutoff})`)
    .order("created_at", { ascending: true })
    .limit(batchSize);

  if (selectError || !candidates || candidates.length === 0) {
    if (selectError) {
      console.error("[url-queue] Failed to read pending URLs:", selectError);
      warnIfMissingTable("claimNextUrls", selectError);
    } else {
      // Extraction-worker tracing — an empty claim is completely normal
      // (the queue really is drained, or discovery just hasn't produced
      // anything yet), but it looks IDENTICAL in the metrics dashboard to
      // "claimNextUrls is failing every time against a missing/misconfigured
      // table" (see warnIfMissingTable's own comment) unless this specific,
      // no-error case is also logged — otherwise a real "worker is running
      // but genuinely has nothing to do" and a silent failure are
      // indistinguishable from the outside.
      console.log("[EXTRACTION WORKER] claimNextUrls found nothing pending — queue is empty");
    }
    return [];
  }

  const ids = candidates.map((row) => row.id);
  const { error: updateError } = await supabase.from("scraper_url_queue").update({ status: "claimed" }).in("id", ids);

  if (updateError) {
    warnIfMissingTable("claimNextUrls", updateError);
    console.error("[url-queue] Failed to claim batch:", updateError);
    return [];
  }

  console.log("[EXTRACTION WORKER] claimed batch from queue", { count: candidates.length });

  return candidates.map((row) => ({ ...row, status: "claimed" as const }));
}

export async function markUrlExtracted(id: string): Promise<void> {
  const supabase = client();
  const { error } = await supabase
    .from("scraper_url_queue")
    .update({ status: "extracted", processed_at: new Date().toISOString() })
    .eq("id", id);

  if (error) console.error("[url-queue] Failed to mark URL extracted:", id, error);
}

/**
 * Increments attempt_count; only flips to a terminal 'failed' status once
 * it reaches maxAttempts — otherwise leaves it 'pending' so the next
 * claim retries it, same retry shape as enrichment-queue.ts's
 * failEnrichmentJob.
 */
export async function markUrlFailed(row: UrlQueueRow, maxAttempts: number): Promise<void> {
  const supabase = client();
  const attemptCount = row.attempt_count + 1;
  const status = attemptCount >= maxAttempts ? "failed" : "pending";

  const { error } = await supabase
    .from("scraper_url_queue")
    .update({ status, attempt_count: attemptCount, ...(status === "failed" ? { processed_at: new Date().toISOString() } : {}) })
    .eq("id", row.id);

  if (error) {
    console.error("[url-queue] Failed to record URL failure:", row.id, error);
    warnIfMissingTable("markUrlFailed", error);
  }
}

export interface UrlQueueStats {
  pending: number;
  claimed: number;
  extracted: number;
  failed: number;
}

export async function getUrlQueueStats(): Promise<UrlQueueStats> {
  const supabase = client();
  const [pending, claimed, extracted, failed] = await Promise.all([
    supabase.from("scraper_url_queue").select("id", { count: "exact", head: true }).eq("status", "pending"),
    supabase.from("scraper_url_queue").select("id", { count: "exact", head: true }).eq("status", "claimed"),
    supabase.from("scraper_url_queue").select("id", { count: "exact", head: true }).eq("status", "extracted"),
    supabase.from("scraper_url_queue").select("id", { count: "exact", head: true }).eq("status", "failed"),
  ]);

  // Previously silent — a missing table made every count in the returned
  // stats look like a genuinely empty (0/0/0/0) queue, indistinguishable
  // from "aggressive mode simply hasn't found anything yet."
  for (const result of [pending, claimed, extracted, failed]) {
    if (result.error) {
      warnIfMissingTable("getUrlQueueStats", result.error);
      break;
    }
  }

  return {
    pending: pending.count ?? 0,
    claimed: claimed.count ?? 0,
    extracted: extracted.count ?? 0,
    failed: failed.count ?? 0,
  };
}
