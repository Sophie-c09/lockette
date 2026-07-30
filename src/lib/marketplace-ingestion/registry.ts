// Every ingestion source this table is meant to eventually cover
// (source_platform's check constraint, supabase/schema.sql) — one slot
// per src/lib/marketplaces/types.ts's MarketplaceSource, so "support
// future sources" means filling in a slot here, not restructuring
// anything. Only 'reworn' and 'ebay' do real work today; see each
// sibling file under providers/ for why the rest are documented
// placeholders.
import { createAdminClient } from "@/lib/supabase/admin";
import type { IngestionJobsDatabase } from "@/lib/supabase/ingestion-jobs.types";
import type { MarketplaceSource } from "@/lib/marketplaces/types";
import type { IngestionProvider, IngestionResult } from "./types";
import { rewornProvider } from "./providers/reworn";
import { ebayProvider } from "./providers/ebay";
import { depopProvider } from "./providers/depop";
import { vintedProvider } from "./providers/vinted";
import { poshmarkProvider } from "./providers/poshmark";
import { mercariProvider } from "./providers/mercari";
import { upsertIndexedListings } from "./store";

export const INGESTION_PROVIDERS: Record<MarketplaceSource, IngestionProvider> = {
  reworn: rewornProvider,
  ebay: ebayProvider,
  depop: depopProvider,
  vinted: vintedProvider,
  poshmark: poshmarkProvider,
  mercari: mercariProvider,
};

function jobsClient() {
  // ingestion_jobs has no authenticated-role write policy (see
  // supabase/schema.sql) — same service-role reasoning as store.ts's own
  // write to marketplace_listings.
  return createAdminClient<IngestionJobsDatabase>();
}

/**
 * Runs one source's provider end-to-end: discoverListings() → each raw
 * listing's own normalizeListing() → upsert (store.ts) — recording an
 * ingestion_jobs row throughout, so "Run inventory sync" (this
 * function's eventual admin-facing caller) has something to show for a
 * run: started_at immediately, then listings_found/listings_imported/
 * errors/completed_at once it finishes. No AI enrichment is wired in yet
 * — every row lands with detectedCategory/garmentAttributes/
 * imageEmbedding left unset (see src/lib/listing-enrichment.ts and
 * src/lib/image-similarity.ts for those, not yet called from here) —
 * this is the ingestion pipeline's shape, not its final enrichment step.
 */
export async function runIngestionSource(source: MarketplaceSource, options?: { limit?: number }): Promise<IngestionResult> {
  const provider = INGESTION_PROVIDERS[source];
  const jobs = jobsClient();

  const { data: job, error: startError } = await jobs
    .from("ingestion_jobs")
    .insert({ source })
    .select("id")
    .single();

  if (startError) {
    console.error("[marketplace-ingestion] failed to record job start:", startError.message);
  }

  const errors: string[] = [];
  let raw: Awaited<ReturnType<IngestionProvider["discoverListings"]>> = [];

  try {
    raw = await provider.discoverListings(options);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`[Marketplace Search] ${source} ingestion failed:`, reason);
    errors.push(reason);
  }

  console.log(`[Marketplace Search] ${source} discovery found ${raw.length} listings`);

  const normalized = raw.map((listing) => provider.normalizeListing(listing));
  const upsertResult = await upsertIndexedListings(normalized);
  if (upsertResult.error) errors.push(upsertResult.error);

  console.log(`[Marketplace Search] ${source} ingestion indexed ${upsertResult.count} listings`);

  const result: IngestionResult = {
    source,
    listingsFound: raw.length,
    listingsImported: upsertResult.count,
    errors,
  };

  if (job?.id) {
    const { error: completeError } = await jobs
      .from("ingestion_jobs")
      .update({
        completed_at: new Date().toISOString(),
        listings_found: result.listingsFound,
        listings_imported: result.listingsImported,
        errors: result.errors,
      })
      .eq("id", job.id);

    if (completeError) {
      console.error("[marketplace-ingestion] failed to record job completion:", completeError.message);
    }
  }

  return result;
}

/**
 * "Run inventory sync" — every source in one call, instead of importing
 * listings one platform at a time. Each source's own runIngestionSource()
 * already never throws (provider failures are caught and recorded as
 * job errors), so one bad source can't abort the rest.
 */
export async function runFullInventorySync(options?: { limit?: number }): Promise<IngestionResult[]> {
  const sources = Object.keys(INGESTION_PROVIDERS) as MarketplaceSource[];
  return Promise.all(sources.map((source) => runIngestionSource(source, options)));
}
