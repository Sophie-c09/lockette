// AI Enrichment Queue (Part 6) — decouples scraping from AI visual
// analysis. enqueueListingForEnrichment is called right after a listing
// is imported (by inventory-indexer.ts, never by the scraper itself —
// see that file's own header comment: scraping must never wait on this).
// claimNextEnrichmentBatch / completeEnrichmentJob / failEnrichmentJob are
// what a processor (inventory-indexer.ts) uses to work through the queue
// in bounded batches, never loading the whole queue into memory.
import { createAdminClient } from "@/lib/supabase/admin";
import type { ListingEnrichmentQueueDatabase, EnrichmentQueueRow } from "@/lib/supabase/listing-enrichment-queue.types";

function client() {
  return createAdminClient<ListingEnrichmentQueueDatabase>();
}

/**
 * One row per listing — `listing_id` has a unique index (schema.sql), so
 * re-enqueuing an already-queued listing updates that same row (resets it
 * to 'pending') instead of creating a second job for it.
 */
export async function enqueueListingForEnrichment(listingId: string): Promise<void> {
  const supabase = client();
  const { error } = await supabase
    .from("listing_enrichment_queue")
    .upsert({ listing_id: listingId, status: "pending" }, { onConflict: "listing_id" });

  if (error) {
    console.error("[enrichment-queue] Failed to enqueue listing:", listingId, error);
  }
}

export async function enqueueListingsForEnrichment(listingIds: string[]): Promise<void> {
  if (listingIds.length === 0) return;
  const supabase = client();
  const { error } = await supabase
    .from("listing_enrichment_queue")
    .upsert(
      listingIds.map((listing_id) => ({ listing_id, status: "pending" as const })),
      { onConflict: "listing_id" },
    );

  if (error) {
    console.error("[enrichment-queue] Failed to enqueue listings batch:", error);
  }
}

// If a job has been stuck 'processing' this long, treat whatever process
// claimed it as crashed/killed mid-batch rather than genuinely still
// working — Part 2's own crash-resilience requirement ("if the server
// crashes, do not lose progress, resume from checkpoint"). The
// enrichment queue's own row-level status IS the checkpoint: nothing
// separate to persist, since a crash just leaves some rows stuck here,
// and this reclaim step is what lets a later run pick them back up
// instead of losing them forever.
const STALE_PROCESSING_THRESHOLD_MS = 10 * 60 * 1000;

/**
 * Claims up to `batchSize` jobs by flipping them to 'processing' —
 * bounded, never the whole queue (Part 14: never load all listings into
 * memory). Prefers genuinely 'pending' jobs, but also reclaims any
 * 'processing' job stuck past STALE_PROCESSING_THRESHOLD_MS (a crashed
 * prior run), so a server crash mid-batch never permanently strands
 * those listings. Not a true row-level lock (no SELECT ... FOR UPDATE
 * SKIP LOCKED — this codebase's admin-only, single-operator-at-a-time
 * usage pattern doesn't need one), but the status flip alone is enough
 * to stop the SAME processor's own next poll from re-claiming a job it
 * just took.
 */
export async function claimNextEnrichmentBatch(batchSize: number): Promise<EnrichmentQueueRow[]> {
  const supabase = client();
  const staleCutoff = new Date(Date.now() - STALE_PROCESSING_THRESHOLD_MS).toISOString();

  const { data: candidates, error: selectError } = await supabase
    .from("listing_enrichment_queue")
    .select("*")
    .or(`status.eq.pending,and(status.eq.processing,created_at.lt.${staleCutoff})`)
    .order("created_at", { ascending: true })
    .limit(batchSize);

  if (selectError || !candidates || candidates.length === 0) {
    if (selectError) console.error("[enrichment-queue] Failed to read pending jobs:", selectError);
    return [];
  }

  const ids = candidates.map((row) => row.id);
  const { error: updateError } = await supabase
    .from("listing_enrichment_queue")
    .update({ status: "processing" })
    .in("id", ids);

  if (updateError) {
    console.error("[enrichment-queue] Failed to claim batch:", updateError);
    return [];
  }

  return candidates.map((row) => ({ ...row, status: "processing" as const }));
}

export async function completeEnrichmentJob(jobId: string): Promise<void> {
  const supabase = client();
  const { error } = await supabase
    .from("listing_enrichment_queue")
    .update({ status: "completed", completed_at: new Date().toISOString() })
    .eq("id", jobId);

  if (error) console.error("[enrichment-queue] Failed to mark job completed:", jobId, error);
}

/**
 * Increments `attempts`; only flips to a terminal 'failed' status once
 * `attempts` reaches maxAttempts — otherwise leaves it 'pending' so the
 * next batch claim retries it (Part 2/14's "retry failed operations").
 */
export async function failEnrichmentJob(job: EnrichmentQueueRow, errorMessage: string, maxAttempts: number): Promise<void> {
  const supabase = client();
  const attempts = job.attempts + 1;
  const status = attempts >= maxAttempts ? "failed" : "pending";

  const { error } = await supabase
    .from("listing_enrichment_queue")
    .update({ status, attempts, error: errorMessage, ...(status === "failed" ? { completed_at: new Date().toISOString() } : {}) })
    .eq("id", job.id);

  if (error) console.error("[enrichment-queue] Failed to record job failure:", job.id, error);
}

export interface EnrichmentQueueStats {
  pending: number;
  processing: number;
  completed: number;
  failed: number;
}

export async function getEnrichmentQueueStats(): Promise<EnrichmentQueueStats> {
  const supabase = client();
  const [pending, processing, completed, failed] = await Promise.all([
    supabase.from("listing_enrichment_queue").select("id", { count: "exact", head: true }).eq("status", "pending"),
    supabase.from("listing_enrichment_queue").select("id", { count: "exact", head: true }).eq("status", "processing"),
    supabase.from("listing_enrichment_queue").select("id", { count: "exact", head: true }).eq("status", "completed"),
    supabase.from("listing_enrichment_queue").select("id", { count: "exact", head: true }).eq("status", "failed"),
  ]);

  return {
    pending: pending.count ?? 0,
    processing: processing.count ?? 0,
    completed: completed.count ?? 0,
    failed: failed.count ?? 0,
  };
}
