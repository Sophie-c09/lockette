// Part 4 of the recommendation-integration architecture — a real
// embedding for a USER's stated taste (not a listing's), stored on
// style_profiles.style_embedding (supabase/schema.sql) and consumed by
// src/lib/ai/embedding-search.ts's searchListingsByEmbedding as the
// query vector for "find listings visually/stylistically like this
// person's taste," instead of only tag-intersection scoring.
//
// Same "vision-description-then-embed" spirit as
// src/lib/image-similarity.ts's generateImageEmbedding, but for TEXT
// input directly — quiz answers + liked items describe taste in words
// already, so there's no image to look at first; this goes straight to
// text-embedding-3-small (SAME model/dimension as image-similarity.ts,
// so both a user's style_embedding and a listing's visual_embedding live
// in the same comparable vector space).
import OpenAI from "openai";
import { createAdminClient } from "@/lib/supabase/admin";

const EMBEDDING_MODEL = "text-embedding-3-small";
const REQUEST_TIMEOUT_MS = 15_000;

export interface StyleEmbeddingInput {
  aesthetics: string[];
  favoriteBrands: string[];
  favoriteCategories: string[];
  favoriteColors: string[];
  // Titles/aesthetic_tags of listings this user has actually liked/saved
  // — the real behavioral signal, weighted alongside their stated quiz
  // answers rather than instead of them.
  likedItemDescriptions: string[];
}

function buildStyleDescription(input: StyleEmbeddingInput): string {
  const parts = [
    input.aesthetics.length > 0 ? `Aesthetics: ${input.aesthetics.join(", ")}.` : null,
    input.favoriteBrands.length > 0 ? `Favorite brands: ${input.favoriteBrands.join(", ")}.` : null,
    input.favoriteCategories.length > 0 ? `Favorite categories: ${input.favoriteCategories.join(", ")}.` : null,
    input.favoriteColors.length > 0 ? `Favorite colors: ${input.favoriteColors.join(", ")}.` : null,
    input.likedItemDescriptions.length > 0
      ? `Items this person has liked: ${input.likedItemDescriptions.slice(0, 20).join("; ")}.`
      : null,
  ].filter((part): part is string => Boolean(part));

  return parts.join(" ");
}

/**
 * Never throws — returns null (never a fabricated vector, same
 * discipline as generateImageEmbedding) on a missing API key, empty
 * input, or any OpenAI call failure.
 */
export async function generateStyleEmbedding(input: StyleEmbeddingInput): Promise<number[] | null> {
  const description = buildStyleDescription(input);
  if (!description) {
    console.log("[style-embedding] No taste signal to embed (empty quiz answers and no liked items) — skipping.");
    return null;
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.warn("[style-embedding] OPENAI_API_KEY is not set — skipping.");
    return null;
  }

  try {
    const client = new OpenAI({ apiKey, timeout: REQUEST_TIMEOUT_MS });
    const model = process.env.OPENAI_IMAGE_EMBEDDING_MODEL || EMBEDDING_MODEL;
    const response = await client.embeddings.create({ model, input: description });

    const embedding = response.data[0]?.embedding;
    if (!embedding || embedding.length === 0) {
      console.warn("[style-embedding] Embedding call returned no vector.");
      return null;
    }

    console.log(`[style-embedding] Generated style embedding (dims=${embedding.length})`);
    return embedding;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error("[style-embedding] Failed to generate style embedding:", reason);
    return null;
  }
}

/**
 * Full "quiz answers + saved preferences + liked items -> AI-generated
 * style description -> embedding -> stored user profile" flow (Part 4's
 * own spec) for one user. Best-effort: any failure here is logged and
 * swallowed — this must never fail the onboarding save it's called
 * after (see src/app/actions/onboarding.ts's own call site).
 */
export async function generateAndSaveStyleEmbedding(userId: string): Promise<void> {
  try {
    const supabase = createAdminClient();

    const [{ data: profile }, { data: savedRows }] = await Promise.all([
      supabase
        .from("style_profiles")
        .select("style_tags, favorite_brands, favorite_categories, favorite_colors")
        .eq("user_id", userId)
        .maybeSingle(),
      supabase.from("saved_items").select("listing_id").eq("user_id", userId).not("listing_id", "is", null),
    ]);

    if (!profile) {
      console.warn(`[style-embedding] No style_profiles row for user ${userId} — skipping.`);
      return;
    }

    const likedListingIds = (savedRows ?? [])
      .map((row) => row.listing_id)
      .filter((id): id is string => Boolean(id));

    let likedItemDescriptions: string[] = [];
    if (likedListingIds.length > 0) {
      const { data: likedListings } = await supabase
        .from("listings")
        .select("title, aesthetic_tags")
        .in("id", likedListingIds);

      likedItemDescriptions = (likedListings ?? []).map((listing) =>
        [listing.title, ...(listing.aesthetic_tags ?? [])].filter(Boolean).join(" "),
      );
    }

    const embedding = await generateStyleEmbedding({
      aesthetics: profile.style_tags ?? [],
      favoriteBrands: profile.favorite_brands ?? [],
      favoriteCategories: profile.favorite_categories ?? [],
      favoriteColors: profile.favorite_colors ?? [],
      likedItemDescriptions,
    });

    if (!embedding) return;

    const { error } = await supabase
      .from("style_profiles")
      .update({ style_embedding: embedding, style_embedding_generated_at: new Date().toISOString() })
      .eq("user_id", userId);

    if (error) {
      console.error(`[style-embedding] Failed to save style embedding for user ${userId}:`, error);
      return;
    }

    console.log(`[style-embedding] Saved style embedding for user ${userId}`);
  } catch (error) {
    console.error(`[style-embedding] Unexpected error generating style embedding for user ${userId}:`, error);
  }
}
