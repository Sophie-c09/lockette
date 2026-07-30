// Listing-level wrapper around src/lib/image-similarity.ts's
// generateImageEmbedding() — turns "one listing's image" into "the row
// patch a caller can write straight into `listings`
// (image_embedding/embedding_generated_at, supabase/schema.sql)."
import { createAdminClient } from "@/lib/supabase/admin";
import type { ListingsDatabase } from "@/lib/supabase/listings.types";
import { generateImageEmbedding } from "@/lib/image-similarity";

export interface ListingEmbeddingInput {
  id: string;
  image_url: string | null;
}

export interface ListingEmbeddingResult {
  id: string;
  image_embedding: number[];
  embedding_generated_at: string;
}

/**
 * Generates an embedding for one listing's image. Returns null (never
 * throws) if the listing has no image, or if generateImageEmbedding
 * itself fails for any reason (invalid/unreachable URL, missing API key,
 * OpenAI call failure — see that function's own logging).
 */
export async function generateListingEmbedding(listing: ListingEmbeddingInput): Promise<ListingEmbeddingResult | null> {
  if (!listing.image_url) {
    console.log(`[Image Similarity] Failed generating embedding:\nlisting ${listing.id} has no image_url`);
    return null;
  }

  const embedding = await generateImageEmbedding(listing.image_url);
  if (!embedding) return null;

  return {
    id: listing.id,
    image_embedding: embedding,
    embedding_generated_at: new Date().toISOString(),
  };
}

function adminClient() {
  return createAdminClient<ListingsDatabase>();
}

/**
 * generateListingEmbedding() + the actual `listings` row update, in one
 * call — the shared hook every listing-creation path (admin scraper,
 * bulk import, manual add, single-URL import) calls after its own insert
 * succeeds, so "generate + save" has exactly one implementation instead
 * of four copies. Never throws and never blocks a caller's success path:
 * any failure (no image, generation failure, DB update failure) is
 * caught and logged, and the listing itself is left exactly as it was
 * already successfully inserted — this function only ever ADDS the two
 * embedding columns on top, on a best-effort basis.
 */
export async function generateAndSaveListingEmbedding(listingId: string, imageUrl: string | null): Promise<void> {
  try {
    const result = await generateListingEmbedding({ id: listingId, image_url: imageUrl });
    if (!result) return;

    const supabase = adminClient();
    const { error } = await supabase
      .from("listings")
      .update({
        image_embedding: result.image_embedding,
        embedding_generated_at: result.embedding_generated_at,
      })
      .eq("id", result.id);

    if (error) {
      console.log(`[Image Similarity] Failed generating embedding:\nfailed saving to listing ${listingId}: ${error.message}`);
      return;
    }

    console.log(`[Image Similarity] Saved embedding for listing ${listingId}`);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.log(`[Image Similarity] Failed generating embedding:\nunexpected error for listing ${listingId}: ${reason}`);
  }
}
