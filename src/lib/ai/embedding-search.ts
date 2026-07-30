// Part 10 of the AI inventory architecture — scalable retrieval:
//   User profile -> embedding search -> top 100 candidates -> AI
//   reranking -> final results
//
// "Do NOT scan all listings": the candidate stage is a real pgvector KNN
// query (match_listings_by_embedding, supabase/schema.sql — cosine
// distance via the `<=>` operator against the ivfflat index on
// listings.visual_embedding), bounded by `limit`, never a full-table
// scan scored in application code. "AI reranking" reuses
// calculateVisualMatch (Part 9, style-match-score.ts) against the same
// candidate set — no new scoring logic duplicated here.
//
// HONEST DEPENDENCY: this requires supabase/schema.sql's pgvector
// migration to have actually been run (the `vector` extension enabled,
// visual_embedding column + ivfflat index + match_listings_by_embedding
// function all created) and for listings to actually have a
// visual_embedding populated (written by inventory-indexer.ts's
// processEnrichmentBatch, Part 3/7). Until both of those are true, the
// RPC call below fails and this returns an empty result with a clear
// log line — it does NOT fall back to scanning the whole table, since
// that would violate this Part's own "do not scan all listings"
// requirement just to produce a result anyway.
import { createAdminClient } from "@/lib/supabase/admin";
import type { ListingsDatabase } from "@/lib/supabase/listings.types";
import { calculateVisualMatch, type UserStyleProfile, type VisualMatchResult } from "@/lib/ai/style-match-score";
import type { VisualListingAnalysis } from "@/lib/ai/visual-listing-analysis";
import type { GarmentCategory } from "@/lib/garment-detection";

const DEFAULT_CANDIDATE_COUNT = 100;

const LISTING_SELECT_COLUMNS =
  "id, title, description, price, image_url, images, product_url, platform, brand, category, aesthetic_tags, visual_analysis, visual_embedding, status";

// Narrower than the full `Listing` type — exactly what
// LISTING_SELECT_COLUMNS above actually selects, not everything the
// `listings` table has. Kept local rather than forcing this into
// `Listing` (which the Supabase client's untyped `.select(string)` call
// doesn't structurally narrow to anyway).
export interface EmbeddingSearchListing {
  id: string;
  title: string;
  description: string | null;
  price: number | null;
  image_url: string | null;
  images?: string[];
  product_url: string | null;
  platform: string | null;
  brand: string | null;
  category?: string | null;
  aesthetic_tags: string[];
  visual_analysis: VisualListingAnalysis | null;
  visual_embedding: number[] | null;
  status?: string;
}

export interface EmbeddingSearchResult {
  listing: EmbeddingSearchListing;
  match: VisualMatchResult;
}

/**
 * queryEmbedding is expected to come from the SAME embedding pipeline
 * that populated visual_embedding (src/lib/image-similarity.ts's
 * generateImageEmbedding) — e.g. embedding a liked item's photo or an
 * inspiration image, so the vector space actually lines up.
 */
export async function searchListingsByEmbedding(
  queryEmbedding: number[],
  userStyleProfile: UserStyleProfile,
  options?: { candidateCount?: number; category?: GarmentCategory | null; maxPrice?: number | null },
): Promise<EmbeddingSearchResult[]> {
  const supabase = createAdminClient<ListingsDatabase>();
  const candidateCount = options?.candidateCount ?? DEFAULT_CANDIDATE_COUNT;

  // Stage 1 — bounded pgvector KNN, not a full-table scan.
  const { data: matches, error: rpcError } = await supabase.rpc("match_listings_by_embedding", {
    query_embedding: queryEmbedding,
    match_count: candidateCount,
    filter_category: options?.category ?? null,
    max_price: options?.maxPrice ?? null,
  });

  if (rpcError) {
    console.error(
      "[embedding-search] pgvector search failed — this requires supabase/schema.sql's " +
        "match_listings_by_embedding function (and the vector extension) to have been applied. " +
        "Not falling back to a full-table scan (Part 14: never scan all listings). Error:",
      rpcError,
    );
    return [];
  }
  if (!matches || matches.length === 0) return [];

  const candidateIds = matches.map((row: { id: string }) => row.id);

  // Stage 2 — fetch the full rows for just this bounded candidate set.
  const { data: listingsData, error: listingsError } = await supabase
    .from("listings")
    .select(LISTING_SELECT_COLUMNS)
    .in("id", candidateIds);

  if (listingsError || !listingsData) {
    console.error("[embedding-search] Failed to fetch candidate listing rows:", listingsError);
    return [];
  }

  const listings = listingsData as unknown as EmbeddingSearchListing[];

  // Stage 3 — AI reranking (Part 9's calculateVisualMatch), not just the
  // raw embedding-distance order — a candidate with a slightly weaker
  // visual-similarity score but a much better aesthetic/category/price
  // fit can rank above a purely visually-closer one.
  const reranked = listings
    .filter((listing): listing is EmbeddingSearchListing & { visual_analysis: VisualListingAnalysis } => Boolean(listing.visual_analysis))
    .map((listing) => ({
      listing,
      match: calculateVisualMatch(
        { ...listing.visual_analysis, price: listing.price, imageEmbedding: listing.visual_embedding ?? null },
        { ...userStyleProfile, queryImageEmbedding: queryEmbedding },
      ),
    }))
    .sort((a, b) => b.match.score - a.match.score);

  console.log(`[embedding-search] ${matches.length} pgvector candidates -> ${reranked.length} reranked results`);

  return reranked;
}
