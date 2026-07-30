// One-off operator script: generates image embeddings for every existing
// `listings` row that doesn't have one yet (src/lib/image-similarity.ts /
// src/lib/listing-embeddings.ts) — the catch-up counterpart to Part 4's
// "embed new listings as they're imported" hook, for everything that was
// already in this app's inventory before that hook existed.
//
// Run with: npx tsx --env-file=.env.local scripts/backfill-image-embeddings.ts
// (or `npm run backfill:embeddings`, see package.json).
//
// Never aborts the whole run on one listing's failure — the requirement
// this script exists to satisfy is "continue after failures," matching
// generateListingEmbedding's own "never throws, returns null" contract
// (src/lib/listing-embeddings.ts).
import { createAdminClient } from "@/lib/supabase/admin";
import type { ListingsDatabase } from "@/lib/supabase/listings.types";
import { generateListingEmbedding } from "@/lib/listing-embeddings";

const BATCH_SIZE = 50;
// Between batches, not between individual listings within a batch — a
// batch's own OpenAI calls already run sequentially (one listing at a
// time, not fanned out), which is itself a natural per-request throttle;
// this additional pause is specifically to avoid hammering the API the
// moment one batch finishes and the next begins.
const DELAY_BETWEEN_BATCHES_MS = 3_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function adminClient() {
  return createAdminClient<ListingsDatabase>();
}

async function fetchNextBatch(): Promise<{ id: string; image_url: string | null }[]> {
  const supabase = adminClient();
  const { data, error } = await supabase
    .from("listings")
    .select("id, image_url")
    .is("image_embedding", null)
    .not("image_url", "is", null)
    .limit(BATCH_SIZE);

  if (error) {
    console.error("[Embeddings] Failed to fetch next batch:", error.message);
    return [];
  }

  return data ?? [];
}

async function countRemaining(): Promise<number> {
  const supabase = adminClient();
  const { count, error } = await supabase
    .from("listings")
    .select("id", { count: "exact", head: true })
    .is("image_embedding", null)
    .not("image_url", "is", null);

  if (error) {
    console.error("[Embeddings] Failed to count remaining listings:", error.message);
    return 0;
  }

  return count ?? 0;
}

async function processBatch(batch: { id: string; image_url: string | null }[]): Promise<{ succeeded: number; failed: number }> {
  const supabase = adminClient();
  let succeeded = 0;
  let failed = 0;

  for (const listing of batch) {
    const result = await generateListingEmbedding(listing);

    if (!result) {
      console.log(`[Embeddings] Failed:\n${listing.id}`);
      failed++;
      continue;
    }

    const { error } = await supabase
      .from("listings")
      .update({
        image_embedding: result.image_embedding,
        embedding_generated_at: result.embedding_generated_at,
      })
      .eq("id", result.id);

    if (error) {
      console.log(`[Embeddings] Failed:\n${listing.id} (save failed: ${error.message})`);
      failed++;
      continue;
    }

    succeeded++;
  }

  return { succeeded, failed };
}

async function main() {
  console.log("[Embeddings] Starting backfill");

  const total = await countRemaining();
  if (total === 0) {
    console.log("[Embeddings] Processed 0/0 — nothing to backfill");
    return;
  }

  let processed = 0;
  let totalFailed = 0;

  while (true) {
    const batch = await fetchNextBatch();
    if (batch.length === 0) break;

    const { succeeded, failed } = await processBatch(batch);
    processed += succeeded + failed;
    totalFailed += failed;

    console.log(`[Embeddings] Processed ${processed}/${total}`);

    if (batch.length < BATCH_SIZE) break;
    await sleep(DELAY_BETWEEN_BATCHES_MS);
  }

  console.log(`[Embeddings] Done — ${processed - totalFailed} succeeded, ${totalFailed} failed`);
}

main();
