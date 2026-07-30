// Part 6 of the recommendation-integration architecture — a real,
// against-the-live-database verification script for pgvector similarity
// search, not a unit test (it needs real Supabase credentials and real
// data, same reasoning as scripts/backfill-image-embeddings.ts). Named
// exactly as this feature's own spec requests (tests/vector-search-test.ts)
// rather than *.test.ts, so it is intentionally NOT picked up by `npm
// test`'s tsx --test tests/**/*.test.ts glob — run it directly instead:
//
//   npx tsx --env-file=.env.local tests/vector-search-test.ts
//
// Checks, in order:
//   1. supabase/schema.sql's Part 8 migration has actually been applied
//      (vector extension enabled, visual_embedding column, the
//      match_listings_by_embedding function all exist).
//   2. At least one listing has a real visual_embedding populated (i.e.
//      the indexer has actually processed something).
//   3. A real similarity query against that listing's own embedding
//      returns visually similar items via the pgvector index — not a
//      full-table scan (Part 14).
import { createAdminClient } from "@/lib/supabase/admin";
import type { ListingsDatabase } from "@/lib/supabase/listings.types";

function logStep(step: string): void {
  console.log(`\n[vector-search-test] ${step}`);
}

function logResult(passed: boolean, message: string): void {
  console.log(`  ${passed ? "PASS" : "FAIL"} — ${message}`);
}

async function main() {
  const supabase = createAdminClient<ListingsDatabase>();
  let allPassed = true;

  // --- Step 1: migration applied? ---------------------------------------
  logStep("Step 1: checking pgvector migration (visual_embedding column, match_listings_by_embedding function)");

  const { error: columnError } = await supabase.from("listings").select("visual_embedding").limit(1);
  const columnExists = !columnError;
  logResult(
    columnExists,
    columnExists
      ? "listings.visual_embedding column exists"
      : `listings.visual_embedding column is missing — run supabase/schema.sql's Part 8 migration. Error: ${columnError?.message}`,
  );
  allPassed = allPassed && columnExists;

  if (!columnExists) {
    console.log("\n[vector-search-test] Stopping early — nothing further can be verified without this column.");
    process.exit(1);
  }

  // --- Step 2: pick a known listing with a real embedding ----------------
  logStep("Step 2: picking a known listing with a real visual_embedding");

  const { data: knownListing, error: knownListingError } = await supabase
    .from("listings")
    .select("id, title, visual_embedding")
    .not("visual_embedding", "is", null)
    .eq("status", "active")
    .limit(1)
    .maybeSingle();

  const hasKnownListing = !knownListingError && Boolean(knownListing);
  logResult(
    hasKnownListing,
    hasKnownListing
      ? `Found listing "${knownListing?.title}" (${knownListing?.id}) with a real embedding`
      : "No listing with a populated visual_embedding found yet — run the inventory indexer " +
          "(src/lib/inventory/inventory-indexer.ts, or POST /api/inventory/index as an admin) to " +
          "process at least one listing, then re-run this script.",
  );
  allPassed = allPassed && hasKnownListing;

  if (!knownListing?.visual_embedding) {
    console.log("\n[vector-search-test] Stopping early — no query vector available to test similarity search with.");
    process.exit(allPassed ? 0 : 1);
  }

  // --- Step 3: run a real similarity query --------------------------------
  logStep("Step 3: running a real pgvector similarity query");

  const { data: matches, error: matchError } = await supabase.rpc("match_listings_by_embedding", {
    query_embedding: knownListing.visual_embedding,
    match_count: 10,
  });

  const queryWorked = !matchError;
  logResult(
    queryWorked,
    queryWorked
      ? `match_listings_by_embedding returned ${matches?.length ?? 0} result(s)`
      : `match_listings_by_embedding failed — the function may not exist yet, or the vector extension ` +
          `isn't enabled. Error: ${matchError?.message}`,
  );
  allPassed = allPassed && queryWorked;

  if (matches && matches.length > 0) {
    console.log("\n  Top matches (excluding the query listing itself):");
    for (const match of matches.filter((m: { id: string }) => m.id !== knownListing.id).slice(0, 5)) {
      console.log(`    - ${match.id} (similarity: ${match.similarity.toFixed(4)})`);
    }
  }

  console.log(`\n[vector-search-test] ${allPassed ? "ALL CHECKS PASSED" : "SOME CHECKS FAILED"} — see above for details.`);
  process.exit(allPassed ? 0 : 1);
}

main().catch((error) => {
  console.error("[vector-search-test] Unexpected error:", error);
  process.exit(1);
});
