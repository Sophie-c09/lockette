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

// Job-scoped queue migration (supabase/migrations/
// 20260806000000_add_scraper_url_queue_job_id.sql) may not be applied on
// every database yet — same tiered-fallback posture as every other
// possibly-missing column in this codebase (see scraper-jobs.ts's own
// isMissingColumnError).
function isMissingJobIdColumnError(error: { code?: string; message: string }): boolean {
  return error.code === "PGRST204" || /column .* does not exist/i.test(error.message);
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
// `jobId`, when passed (final Inventory Growth stabilization pass — see
// this file's own header comment on job-scoped queue ownership), is
// stamped onto every row in this batch. Applied ONLY on first insert —
// `ignoreDuplicates: true` means a URL re-discovered by a DIFFERENT job
// while still queued under an earlier job's ownership is correctly left
// alone (job_id stays whatever it was first set to; a URL is a global
// dedup key regardless of which job found it first, same posture
// scraper_discovery_history already takes). Omitting jobId (any
// non-job-scoped caller) leaves job_id null — a legacy/unassigned row,
// safe and untouched by job-scoped claiming (see claimNextUrls).
export async function enqueueUrls(entries: UrlQueueEntry[], jobId?: string): Promise<void> {
  if (entries.length === 0) return;
  const supabase = client();

  async function attemptEnqueue(withJobId: boolean) {
    return supabase.from("scraper_url_queue").upsert(
      entries.map((entry) => ({
        url: entry.url,
        platform: entry.platform,
        query: entry.query,
        page: entry.page,
        status: "pending" as const,
        ...(withJobId && jobId ? { job_id: jobId } : {}),
      })),
      { onConflict: "url", ignoreDuplicates: true },
    );
  }

  let { error } = await attemptEnqueue(true);
  if (error && jobId && isMissingJobIdColumnError(error)) {
    // job_id migration not applied yet on this database — fall back to
    // the exact pre-migration behavior rather than failing every enqueue.
    ({ error } = await attemptEnqueue(false));
  }

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
 *
 * P0 launch-readiness fixes (two real, not hypothetical, races):
 *
 * 1. Staleness used to be measured against `created_at` (when the URL was
 *    ENQUEUED, not when it was actually claimed) — a URL claimed shortly
 *    before it would've gone stale anyway was immediately eligible for a
 *    second worker to reclaim it. `claimed_at` is now stamped fresh at the
 *    moment of THIS claim, so the staleness clock always measures actual
 *    claim duration.
 * 2. The claim used to SELECT candidate ids, then unconditionally UPDATE
 *    by those ids with no re-check — if a second concurrent
 *    claimNextUrls() call claimed one of the same rows in between, this
 *    call would still forcibly re-claim it, and both callers would
 *    process the same URL. The UPDATE below re-applies the identical
 *    pending/stale-claimed condition (not just the ids), so a row another
 *    caller already won no longer matches and is silently left alone —
 *    `.select()` on the update reports back exactly which rows THIS call
 *    actually won, rather than trusting the ids collected a moment
 *    earlier.
 */
// `jobId`, when passed, scopes both the SELECT and the claiming UPDATE to
// `job_id = jobId` — this worker/route only ever claims rows it discovered
// itself, never a different job's (or a legacy, unassigned) row. Omitting
// jobId preserves the exact pre-migration, global-claim behavior (any
// caller that hasn't been updated to pass one, or a database that hasn't
// run the job_id migration yet — see isMissingJobIdColumnError's fallback
// below).
export async function claimNextUrls(batchSize: number, jobId?: string): Promise<UrlQueueRow[]> {
  const supabase = client();
  const staleCutoff = new Date(Date.now() - STALE_CLAIM_THRESHOLD_MS).toISOString();
  const claimableFilter = `status.eq.pending,and(status.eq.claimed,claimed_at.lt.${staleCutoff})`;

  async function selectCandidates(withJobId: boolean) {
    let query = supabase.from("scraper_url_queue").select("*").or(claimableFilter);
    if (withJobId && jobId) query = query.eq("job_id", jobId);
    return query.order("created_at", { ascending: true }).limit(batchSize);
  }

  let { data: candidates, error: selectError } = await selectCandidates(true);
  if (selectError && jobId && isMissingJobIdColumnError(selectError)) {
    ({ data: candidates, error: selectError } = await selectCandidates(false));
  }

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
  const claimedAt = new Date().toISOString();

  const { data: won, error: updateError } = await supabase
    .from("scraper_url_queue")
    .update({ status: "claimed", claimed_at: claimedAt })
    .in("id", ids)
    .or(claimableFilter)
    .select("*");

  if (updateError) {
    warnIfMissingTable("claimNextUrls", updateError);
    console.error("[url-queue] Failed to claim batch:", updateError);
    return [];
  }

  const wonRows = won ?? [];
  if (wonRows.length < candidates.length) {
    // Not an error — just means a concurrent claim beat this call to some
    // of the same rows between the SELECT and this UPDATE. Logged so this
    // race is visible in metrics rather than silently losing candidates.
    console.log("[EXTRACTION WORKER] lost the race for some candidates to a concurrent claim", {
      selected: candidates.length,
      won: wonRows.length,
    });
  }
  console.log("[EXTRACTION WORKER] claimed batch from queue", { count: wonRows.length });

  return wonRows.map((row) => ({ ...row, status: "claimed" as const }));
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

/**
 * Cancellation fix — releases a row THIS execution had claimed but never
 * got a definite outcome for (the batch was aborted before extraction
 * finished), back to 'pending' so a future run can claim and try it for
 * real — never markUrlFailed, which would count against attempt_count for
 * a URL that was never actually given a real attempt. Scoped by exact row
 * id AND `status = 'claimed'` — if this same row somehow already reached
 * 'extracted'/'failed' by the time this runs (a genuine result landed in
 * the same narrow window as the abort), that outcome is left alone rather
 * than being overwritten back to 'pending'.
 */
export async function releaseClaimedUrl(id: string): Promise<void> {
  const supabase = client();
  const { error } = await supabase
    .from("scraper_url_queue")
    .update({ status: "pending" })
    .eq("id", id)
    .eq("status", "claimed");

  if (error) console.error("[url-queue] Failed to release claimed URL back to pending:", id, error);
}

export interface UrlQueueStats {
  pending: number;
  claimed: number;
  extracted: number;
  failed: number;
}

// Diagnostics (final Inventory Growth stabilization pass) — "how long has
// the oldest still-pending URL been waiting" is a much more direct signal
// of a genuine discovery/extraction stall than raw counts alone (a queue
// can sit at a healthy-looking depth while every row in it has been stuck
// for hours because nothing is actually claiming them).
export async function getOldestPendingUrlAgeMs(jobId?: string): Promise<number | null> {
  const supabase = client();
  let query = supabase.from("scraper_url_queue").select("created_at").eq("status", "pending").order("created_at", { ascending: true }).limit(1);
  if (jobId) query = query.eq("job_id", jobId);
  const { data, error } = await query;
  if (error || !data || data.length === 0) return null;
  return Date.now() - new Date(data[0].created_at).getTime();
}

// `jobId`, when passed, scopes every count to `job_id = jobId` — "current
// workers active"/"extraction queue depth" etc. for a SPECIFIC job, not
// the lifetime global queue (which mixes in other jobs' and legacy,
// unassigned rows — confirmed live: 974+ historical failed rows from
// jobs that no longer exist, which made a genuinely healthy new job's own
// queue depth indistinguishable from a stuck one). Omitting jobId
// preserves the original global view, still useful for admin-wide/
// cross-job visibility.
export async function getUrlQueueStats(jobId?: string): Promise<UrlQueueStats> {
  const supabase = client();

  async function countByStatus(status: "pending" | "claimed" | "extracted" | "failed", withJobId: boolean) {
    let query = supabase.from("scraper_url_queue").select("id", { count: "exact", head: true }).eq("status", status);
    if (withJobId && jobId) query = query.eq("job_id", jobId);
    return query;
  }

  let [pending, claimed, extracted, failed] = await Promise.all([
    countByStatus("pending", true),
    countByStatus("claimed", true),
    countByStatus("extracted", true),
    countByStatus("failed", true),
  ]);

  if (jobId && [pending, claimed, extracted, failed].some((result) => result.error && isMissingJobIdColumnError(result.error))) {
    // job_id migration not applied yet — fall back to the global view
    // rather than reporting every count as an error.
    [pending, claimed, extracted, failed] = await Promise.all([
      countByStatus("pending", false),
      countByStatus("claimed", false),
      countByStatus("extracted", false),
      countByStatus("failed", false),
    ]);
  }

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
