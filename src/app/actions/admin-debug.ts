"use server";

// Part 7 of the recommendation-integration architecture — real search
// debugging tools for admins: for any listing, what the AI pipeline
// actually knows about it; for any user, what their taste profile
// actually looks like and why a listing would (or wouldn't) rank well
// for them. Read-only, admin-gated (via /admin/ai-debug/page.tsx, under
// the shared /admin layout's own auth check) — no scraper/indexer/
// ranking logic lives here.
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isCurrentUserAdmin } from "@/lib/admin";
import { calculateVisualMatch, type UserStyleProfile } from "@/lib/ai/style-match-score";
import type { ListingsDatabase } from "@/lib/supabase/listings.types";
import type { VisualListingAnalysis } from "@/lib/ai/visual-listing-analysis";

async function requireAdmin(): Promise<{ error?: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user || !(await isCurrentUserAdmin(supabase, user.id))) {
    return { error: "Not authorized." };
  }
  return {};
}

export interface ListingDebugInfo {
  id: string;
  title: string;
  status: string;
  hasVisualAnalysis: boolean;
  visualAnalysis: VisualListingAnalysis | null;
  hasVisualEmbedding: boolean;
  visualEmbeddingDimensions: number | null;
  hasImageEmbedding: boolean;
  inventoryQualityScore: number | null;
  imageHash: string | null;
  lastVerifiedAt: string | null;
  topSimilarListings: Array<{ id: string; title: string; similarity: number }>;
}

export async function getListingDebugInfo(listingId: string): Promise<{ info?: ListingDebugInfo; error?: string }> {
  const authCheck = await requireAdmin();
  if (authCheck.error) return { error: authCheck.error };

  const supabase = createAdminClient<ListingsDatabase>();
  const { data: listing, error } = await supabase
    .from("listings")
    .select(
      "id, title, status, visual_analysis, visual_embedding, image_embedding, inventory_quality_score, image_hash, last_verified_at",
    )
    .eq("id", listingId)
    .maybeSingle();

  if (error || !listing) {
    return { error: error?.message ?? "Listing not found." };
  }

  let topSimilarListings: Array<{ id: string; title: string; similarity: number }> = [];
  if (listing.visual_embedding) {
    const { data: matches, error: rpcError } = await supabase.rpc("match_listings_by_embedding", {
      query_embedding: listing.visual_embedding,
      match_count: 6,
    });

    if (rpcError) {
      console.error("[admin-debug] Similarity lookup failed:", rpcError);
    } else if (matches) {
      const otherIds = matches.map((m) => m.id).filter((id) => id !== listing.id);
      const { data: otherListings } = await supabase.from("listings").select("id, title").in("id", otherIds);
      const titleById = new Map((otherListings ?? []).map((row) => [row.id, row.title]));

      topSimilarListings = matches
        .filter((m) => m.id !== listing.id)
        .slice(0, 5)
        .map((m) => ({ id: m.id, title: titleById.get(m.id) ?? "(unknown)", similarity: m.similarity }));
    }
  }

  return {
    info: {
      id: listing.id,
      title: listing.title,
      status: listing.status ?? "unknown",
      hasVisualAnalysis: Boolean(listing.visual_analysis),
      visualAnalysis: listing.visual_analysis ?? null,
      hasVisualEmbedding: Boolean(listing.visual_embedding),
      visualEmbeddingDimensions: listing.visual_embedding?.length ?? null,
      hasImageEmbedding: Boolean(listing.image_embedding),
      inventoryQualityScore: listing.inventory_quality_score ?? null,
      imageHash: listing.image_hash ?? null,
      lastVerifiedAt: listing.last_verified_at ?? null,
      topSimilarListings,
    },
  };
}

export interface UserDebugInfo {
  userId: string;
  preferredAesthetics: string[];
  favoriteBrands: string[];
  favoriteCategories: string[];
  favoriteColors: string[];
  hasStyleEmbedding: boolean;
  styleEmbeddingGeneratedAt: string | null;
  recentFeedback: Array<{ action: string; listingId: string | null; createdAt: string }>;
  // A small worked example — how a real, currently-active listing would
  // score against this user's own profile via calculateVisualMatch
  // (Part 9), so "recommendation reasoning" is a concrete, real number
  // and explanation, not just raw profile data.
  sampleRecommendationReasoning: { listingId: string; listingTitle: string; score: number; reasoning: string } | null;
}

export async function getUserDebugInfo(userId: string): Promise<{ info?: UserDebugInfo; error?: string }> {
  const authCheck = await requireAdmin();
  if (authCheck.error) return { error: authCheck.error };

  const supabase = createAdminClient();

  const [{ data: profile, error: profileError }, { data: feedbackRows }] = await Promise.all([
    supabase
      .from("style_profiles")
      .select("style_tags, favorite_brands, favorite_categories, favorite_colors, style_embedding, style_embedding_generated_at")
      .eq("user_id", userId)
      .maybeSingle(),
    supabase
      .from("user_style_feedback")
      .select("action, listing_id, created_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(20),
  ]);

  if (profileError || !profile) {
    return { error: profileError?.message ?? "No style profile found for this user." };
  }

  const userProfile: UserStyleProfile = {
    aesthetics: profile.style_tags ?? [],
    preferredCategories: null,
    preferredColors: profile.favorite_colors ?? null,
    budgetMax: null,
    queryImageEmbedding: profile.style_embedding ?? null,
  };

  let sampleRecommendationReasoning: UserDebugInfo["sampleRecommendationReasoning"] = null;
  const { data: sampleListing } = await supabase
    .from("listings")
    .select("id, title, visual_analysis, visual_embedding, price")
    .not("visual_analysis", "is", null)
    .eq("status", "active")
    .limit(1)
    .maybeSingle();

  if (sampleListing?.visual_analysis) {
    const match = calculateVisualMatch(
      { ...(sampleListing.visual_analysis as VisualListingAnalysis), price: sampleListing.price, imageEmbedding: sampleListing.visual_embedding },
      userProfile,
    );
    sampleRecommendationReasoning = {
      listingId: sampleListing.id,
      listingTitle: sampleListing.title,
      score: match.score,
      reasoning: match.reasoning,
    };
  }

  return {
    info: {
      userId,
      preferredAesthetics: profile.style_tags ?? [],
      favoriteBrands: profile.favorite_brands ?? [],
      favoriteCategories: profile.favorite_categories ?? [],
      favoriteColors: profile.favorite_colors ?? [],
      hasStyleEmbedding: Boolean(profile.style_embedding),
      styleEmbeddingGeneratedAt: profile.style_embedding_generated_at ?? null,
      recentFeedback: (feedbackRows ?? []).map((row) => ({
        action: row.action,
        listingId: row.listing_id,
        createdAt: row.created_at,
      })),
      sampleRecommendationReasoning,
    },
  };
}
