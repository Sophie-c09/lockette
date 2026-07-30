// Part 3 of the AI inventory architecture — the orchestration layer
// sitting ON TOP OF the scraper (src/lib/admin-scraper.ts), not a
// replacement for it (Part 15: "do not rebuild the scraper"). Ties
// together every other new module built for this feature:
//   Fetch imported listings (bounded)
//     -> Validate (listing-quality-gate.ts, Part 4)
//     -> Duplicate-check (duplicate-detection.ts, Part 5)
//     -> Queue AI enrichment (enrichment-queue.ts, Part 6)
//     -> [separately] process the queue: visual-listing-analysis.ts
//        (Part 7) + a real embedding + inventory-quality-score.ts
//        (Part 11) -> write back to `listings` -> mark complete
//
// CRASH RESILIENCE (Part 2): there is no separate JSONB checkpoint blob
// here — the enrichment queue's own row-level status (schema.sql's
// listing_enrichment_queue) IS the checkpoint. A crash mid-run just
// leaves some rows 'processing' (reclaimed by claimNextEnrichmentBatch's
// stale-processing check) or 'pending' (picked up by the next run's own
// claim query) — nothing about "where this run got to" needs to be
// tracked anywhere else.
//
// PERFORMANCE (Part 14): every stage below is bounded by an explicit
// batch size and paginated via `.range()` / queue claims — nothing here
// ever loads the whole `listings` table or the whole queue into memory,
// and no AI call happens synchronously inside the scraper's own request
// path (this whole module runs independently, triggered by an admin
// action or a scheduled job, never by admin-scraper.ts itself).
import { createAdminClient } from "@/lib/supabase/admin";
import type { ListingsDatabase } from "@/lib/supabase/listings.types";
import type { ListingEnrichmentQueueDatabase } from "@/lib/supabase/listing-enrichment-queue.types";
import { evaluateListingQuality } from "@/lib/inventory/listing-quality-gate";
import { checkForDuplicate, computeImageHash } from "@/lib/inventory/duplicate-detection";
import {
  enqueueListingsForEnrichment,
  claimNextEnrichmentBatch,
  completeEnrichmentJob,
  failEnrichmentJob,
} from "@/lib/inventory/enrichment-queue";
import { analyzeListingVisually } from "@/lib/ai/visual-listing-analysis";
import { generateListingSemanticEmbedding } from "@/lib/image-similarity";
import { calculateInventoryQualityScore } from "@/lib/inventory/inventory-quality-score";

const DEFAULT_FETCH_BATCH_SIZE = 500;
const DEFAULT_PROCESS_BATCH_SIZE = 20; // AI-call-bound, deliberately smaller than the fetch/queue stage
const MAX_ENRICHMENT_ATTEMPTS = 3; // matches this feature's own MAX_RETRIES

const LISTING_SELECT_COLUMNS =
  "id, title, description, price, image_url, images, product_url, category, aesthetic_tags, image_score, created_at, last_verified_at";

export interface IndexingStageResult {
  fetched: number;
  approved: number;
  rejected: number;
  duplicates: number;
  queued: number;
}

/**
 * Stage 1 (Parts 3/4/5/6): fetches up to `batchSize` already-imported
 * listings that haven't been through this pipeline yet (no
 * visual_analysis on record), validates each with the quality gate, and
 * checks each survivor against the rest of inventory for duplicates —
 * everything that passes both gets queued for AI enrichment. Never loads
 * more than one bounded page at a time.
 */
export async function indexNewListings(batchSize: number = DEFAULT_FETCH_BATCH_SIZE): Promise<IndexingStageResult> {
  const supabase = createAdminClient<ListingsDatabase>();

  const { data: candidates, error } = await supabase
    .from("listings")
    .select(LISTING_SELECT_COLUMNS)
    .is("visual_analysis", null)
    // 'flagged' included alongside 'active' — a listing awaiting flag
    // review should still get the same visual analysis/embedding pipeline
    // as any other listing (see src/lib/inventory/listing-flagging.ts);
    // 'pending' kept too only for any still-unmigrated historical rows.
    .in("status", ["active", "flagged", "pending"])
    .order("created_at", { ascending: true })
    .limit(batchSize);

  if (error) {
    console.error("[inventory-indexer] Failed to fetch candidate listings:", error);
    return { fetched: 0, approved: 0, rejected: 0, duplicates: 0, queued: 0 };
  }
  if (!candidates || candidates.length === 0) {
    return { fetched: 0, approved: 0, rejected: 0, duplicates: 0, queued: 0 };
  }

  // Exclude listings whose enrichment has already permanently failed
  // (listing_enrichment_queue.status = 'failed' — MAX_ENRICHMENT_ATTEMPTS
  // already exhausted). Without this, a listing that can genuinely never
  // succeed (a dead image URL, say) has visual_analysis stuck null
  // forever, so this same is-it-analyzed-yet filter re-selects it on
  // every single call and re-enqueues it back to 'pending' (the upsert in
  // enqueueListingsForEnrichment has no way to know a prior run already
  // gave up on it) — which would make a full catch-up backfill
  // (runFullInventoryEmbeddingBackfill below) retry it forever instead of
  // ever reaching a stable "nothing left to do" state.
  const { data: alreadyFailedRows } = await createAdminClient<ListingEnrichmentQueueDatabase>()
    .from("listing_enrichment_queue")
    .select("listing_id")
    .in(
      "listing_id",
      candidates.map((candidate) => candidate.id),
    )
    .eq("status", "failed");
  const alreadyFailedIds = new Set((alreadyFailedRows ?? []).map((row) => row.listing_id));
  const eligibleCandidates = candidates.filter((candidate) => !alreadyFailedIds.has(candidate.id));

  let approved = 0;
  let rejected = 0;
  let duplicates = 0;
  const toQueue: string[] = [];

  for (const listing of eligibleCandidates) {
    const quality = evaluateListingQuality(listing);
    if (!quality.approved) {
      rejected++;
      console.log(`[inventory-indexer] Rejected listing ${listing.id} (score ${quality.quality_score}): ${quality.issues.join(", ")}`);
      continue;
    }

    const duplicate = await checkForDuplicate(
      { title: listing.title, product_url: listing.product_url, image_url: listing.image_url },
      listing.id,
    );
    if (duplicate.isDuplicate) {
      duplicates++;
      console.log(`[inventory-indexer] Listing ${listing.id} is a likely duplicate of ${duplicate.matchedListingId} (confidence ${duplicate.confidence})`);
      continue;
    }

    approved++;
    toQueue.push(listing.id);
  }

  await enqueueListingsForEnrichment(toQueue);

  console.log(
    `[inventory-indexer] indexNewListings — fetched ${candidates.length}, approved ${approved}, rejected ${rejected}, duplicates ${duplicates}, queued ${toQueue.length}`,
  );

  return { fetched: candidates.length, approved, rejected, duplicates, queued: toQueue.length };
}

export interface EnrichmentProcessResult {
  processed: number;
  succeeded: number;
  failed: number;
}

/**
 * Stage 2 (Part 6/7/11): claims a bounded batch of queued jobs and, for
 * each, runs the real AI visual analysis + a real image embedding,
 * computes this listing's inventory_quality_score, and writes everything
 * back onto the listing row — one at a time (not Promise.all across the
 * whole batch), since this is AI-call-bound work and this codebase's own
 * existing convention (admin-scraper.ts's ENRICH_BATCH_CONCURRENCY) is to
 * bound AI concurrency deliberately low rather than maximize it. A
 * failure on one listing is retried (up to MAX_ENRICHMENT_ATTEMPTS,
 * enrichment-queue.ts's own failEnrichmentJob) and never aborts the rest
 * of the batch.
 */
export async function processEnrichmentBatch(batchSize: number = DEFAULT_PROCESS_BATCH_SIZE): Promise<EnrichmentProcessResult> {
  const supabase = createAdminClient<ListingsDatabase>();
  const jobs = await claimNextEnrichmentBatch(batchSize);

  let succeeded = 0;
  let failed = 0;

  for (const job of jobs) {
    try {
      const { data: listing, error } = await supabase
        .from("listings")
        .select(LISTING_SELECT_COLUMNS)
        .eq("id", job.listing_id)
        .maybeSingle();

      if (error || !listing) {
        throw new Error(error?.message ?? "Listing not found (may have been removed)");
      }

      // Hybrid search upgrade — embeds image + title + description
      // together (generateListingSemanticEmbedding, image-similarity.ts),
      // not just the image alone, so this listing's visual_embedding
      // carries whatever semantic signal the image doesn't (brand, era,
      // named cut) and vice versa. Still degrades to title/description
      // alone when there's no usable image, rather than skipping the
      // embedding entirely.
      const [analysis, imageEmbedding, imageHash] = await Promise.all([
        analyzeListingVisually(listing),
        generateListingSemanticEmbedding({ imageUrl: listing.image_url, title: listing.title, description: listing.description }),
        computeImageHash(listing.image_url),
      ]);

      if (!analysis) {
        throw new Error("Visual analysis failed or returned nothing");
      }

      const quality = calculateInventoryQualityScore({
        imageCount: listing.images?.length ?? (listing.image_url ? 1 : 0),
        imageScore: listing.image_score ?? null,
        visualAnalysisConfidence: analysis.confidence,
        aestheticTagCount: (listing.aesthetic_tags?.length ?? 0) + analysis.aesthetic_tags.length,
        price: listing.price,
        createdAt: listing.created_at,
        lastVerifiedAt: listing.last_verified_at ?? null,
      });

      const { error: updateError } = await supabase
        .from("listings")
        .update({
          visual_analysis: analysis,
          visual_embedding: imageEmbedding,
          image_hash: imageHash,
          inventory_quality_score: quality.score,
          last_verified_at: new Date().toISOString(),
        })
        .eq("id", job.listing_id);

      if (updateError) throw new Error(updateError.message);

      await completeEnrichmentJob(job.id);
      succeeded++;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.error(`[inventory-indexer] Enrichment failed for listing ${job.listing_id}:`, reason);
      await failEnrichmentJob(job, reason, MAX_ENRICHMENT_ATTEMPTS);
      failed++;
    }
  }

  console.log(`[inventory-indexer] processEnrichmentBatch — claimed ${jobs.length}, succeeded ${succeeded}, failed ${failed}`);

  return { processed: jobs.length, succeeded, failed };
}

export interface InventoryIndexerResult {
  indexing: IndexingStageResult;
  enrichment: EnrichmentProcessResult;
}

/**
 * The full Part 3 flow in one call: queue whatever's newly indexable,
 * then process one bounded batch of the enrichment queue. Safe to call
 * repeatedly/on a schedule (a cron route, or an admin-triggered action) —
 * each call only ever touches bounded batches, and every stage is
 * independently resumable via its own persisted state (the listings
 * table's own visual_analysis column for stage 1, the enrichment queue's
 * own row statuses for stage 2), so calling this again after a crash
 * just continues from wherever those rows say it left off.
 */
export async function runInventoryIndexer(options?: {
  fetchBatchSize?: number;
  processBatchSize?: number;
}): Promise<InventoryIndexerResult> {
  const indexing = await indexNewListings(options?.fetchBatchSize);
  const enrichment = await processEnrichmentBatch(options?.processBatchSize);
  return { indexing, enrichment };
}

// Safety cap on runFullInventoryEmbeddingBackfill's loop below — a
// runaway-loop backstop, not a real limit on catalog size. Each round
// already bounds its own work (DEFAULT_FETCH_BATCH_SIZE/
// DEFAULT_PROCESS_BATCH_SIZE, or whatever the caller passes), so this
// just stops the loop if something is genuinely wrong rather than
// spinning forever; a real catalog converges (indexing.queued === 0 &&
// enrichment.processed === 0) in far fewer rounds than this.
const MAX_BACKFILL_ROUNDS = 2000;

export interface FullInventoryBackfillResult {
  rounds: number;
  totalIndexing: IndexingStageResult;
  totalEnrichment: EnrichmentProcessResult;
  // true if the loop stopped because it actually converged (nothing left
  // to index or enrich this round) rather than hitting the safety cap —
  // the caller (an admin action) can tell the difference and say "run it
  // again" instead of silently reporting "done" when it isn't.
  converged: boolean;
}

/**
 * "Generate embeddings for all inventory items," not just whatever fits
 * in one bounded batch — runs runInventoryIndexer repeatedly until a
 * round finds nothing left to enqueue AND nothing left in the
 * enrichment queue to process (indexing.queued === 0 && enrichment.processed
 * === 0), rather than requiring an admin to keep clicking the manual
 * trigger by hand. Deliberately still calls the SAME bounded-batch
 * functions every round (never loads more than one page/queue-claim at a
 * time) — this only changes HOW MANY TIMES they're called, not their own
 * per-call bounds, so it's safe to run against a catalog of any size.
 *
 * Uses `queued`/`processed` (not the raw `fetched` count) to detect
 * convergence — a listing whose enrichment already permanently failed
 * (see indexNewListings' own comment on this) is still `fetched` every
 * round forever, but never `queued` again, so `queued === 0` is the
 * correct "nothing NEW to do" signal even though `fetched` never drops to
 * zero on its own.
 */
export async function runFullInventoryEmbeddingBackfill(options?: {
  fetchBatchSize?: number;
  processBatchSize?: number;
}): Promise<FullInventoryBackfillResult> {
  let rounds = 0;
  const totalIndexing: IndexingStageResult = { fetched: 0, approved: 0, rejected: 0, duplicates: 0, queued: 0 };
  const totalEnrichment: EnrichmentProcessResult = { processed: 0, succeeded: 0, failed: 0 };
  let converged = false;

  while (rounds < MAX_BACKFILL_ROUNDS) {
    const { indexing, enrichment } = await runInventoryIndexer(options);
    rounds++;

    totalIndexing.fetched += indexing.fetched;
    totalIndexing.approved += indexing.approved;
    totalIndexing.rejected += indexing.rejected;
    totalIndexing.duplicates += indexing.duplicates;
    totalIndexing.queued += indexing.queued;
    totalEnrichment.processed += enrichment.processed;
    totalEnrichment.succeeded += enrichment.succeeded;
    totalEnrichment.failed += enrichment.failed;

    if (indexing.queued === 0 && enrichment.processed === 0) {
      converged = true;
      break;
    }
  }

  console.log(
    `[inventory-indexer] runFullInventoryEmbeddingBackfill — ${rounds} rounds, converged=${converged}, ` +
      `indexed ${totalIndexing.queued} new, enriched ${totalEnrichment.succeeded}/${totalEnrichment.processed} ` +
      `(${totalEnrichment.failed} failed)`,
  );

  return { rounds, totalIndexing, totalEnrichment, converged };
}
