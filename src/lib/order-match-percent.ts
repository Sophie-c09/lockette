// Best-effort match-percentage lookup for the admin fulfillment dashboard.
// Reuses the exact same scoring pipeline /match uses (match-scoring.ts,
// untouched — see that file's own comments) rather than inventing a
// second, different notion of "match" for admin use. Batches profile/likes
// lookups by distinct user id so a dashboard listing many orders across
// many customers doesn't do N one-off queries per order.
import { createClient } from "@/lib/supabase/server";
import { getTopTags, scoreListingMatch } from "@/lib/match-scoring";
import type { DislikedStyles } from "@/lib/disliked-styles";

interface UserMatchProfile {
  stylePreferences: string[];
  favoriteBrands: string[];
  favoriteCategories: string[];
  favoriteColors: string[];
  sizePreference: string | null;
  topLikedTags: string[];
  dislikedStyles: DislikedStyles;
}

export async function buildMatchPercentLookup(userIds: string[]): Promise<Map<string, UserMatchProfile>> {
  const supabase = await createClient();
  const distinctUserIds = [...new Set(userIds)];
  const profiles = new Map<string, UserMatchProfile>();

  if (distinctUserIds.length === 0) return profiles;

  const [{ data: styleProfiles }, { data: savedRows }] = await Promise.all([
    supabase
      .from("style_profiles")
      .select(
        "user_id, style_tags, favorite_brands, favorite_categories, favorite_colors, size_preference, disliked_styles",
      )
      .in("user_id", distinctUserIds),
    supabase
      .from("saved_items")
      .select("user_id, listing_id")
      .in("user_id", distinctUserIds)
      .not("listing_id", "is", null),
  ]);

  const styleProfileByUser = new Map((styleProfiles ?? []).map((row) => [row.user_id, row]));

  const likedIdsByUser = new Map<string, string[]>();
  for (const row of savedRows ?? []) {
    if (!row.listing_id) continue;
    const list = likedIdsByUser.get(row.user_id) ?? [];
    list.push(row.listing_id);
    likedIdsByUser.set(row.user_id, list);
  }

  const allLikedIds = [...new Set([...likedIdsByUser.values()].flat())];
  let tagsByListingId = new Map<string, string[]>();
  if (allLikedIds.length > 0) {
    const { data: likedListings } = await supabase
      .from("listings")
      .select("id, aesthetic_tags")
      .in("id", allLikedIds);
    tagsByListingId = new Map((likedListings ?? []).map((row) => [row.id, row.aesthetic_tags ?? []]));
  }

  for (const userId of distinctUserIds) {
    const styleProfile = styleProfileByUser.get(userId);
    const likedIds = likedIdsByUser.get(userId) ?? [];
    const likedTagLists = likedIds.map((id) => tagsByListingId.get(id) ?? []);

    profiles.set(userId, {
      stylePreferences: styleProfile?.style_tags ?? [],
      favoriteBrands: styleProfile?.favorite_brands ?? [],
      favoriteCategories: styleProfile?.favorite_categories ?? [],
      favoriteColors: styleProfile?.favorite_colors ?? [],
      sizePreference: styleProfile?.size_preference ?? null,
      topLikedTags: getTopTags(likedTagLists),
      dislikedStyles: styleProfile?.disliked_styles ?? {},
    });
  }

  return profiles;
}

export function computeMatchPercentForListing(
  profile: UserMatchProfile | undefined,
  listing: {
    aesthetic_tags: string[];
    brand: string | null;
    category: string | null;
    color: string | null;
    size: string | null;
  },
): number | null {
  if (!profile) return null;

  const { total } = scoreListingMatch({
    listingTags: listing.aesthetic_tags ?? [],
    listingBrand: listing.brand,
    listingCategory: listing.category,
    listingColor: listing.color,
    listingSize: listing.size,
    stylePreferences: profile.stylePreferences,
    favoriteBrands: profile.favoriteBrands,
    favoriteCategories: profile.favoriteCategories,
    favoriteColors: profile.favoriteColors,
    sizePreference: profile.sizePreference,
    topLikedTags: profile.topLikedTags,
    dislikedStyles: profile.dislikedStyles,
    now: Date.now(),
  });

  return total;
}
