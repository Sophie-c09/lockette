"use server";

import { randomUUID } from "crypto";
import {
  fetchDiscoverBatch,
  DISCOVER_BATCH_SIZE,
  type DiscoverBatchResult,
  type DiscoverSortOption,
} from "@/lib/discover-feed";
import { createClient } from "@/lib/supabase/server";
import { isAllowedListingPhotoType, LISTING_PHOTO_MIME_EXTENSIONS, MAX_LISTING_PHOTO_BYTES } from "@/lib/listing-photo";
import {
  DISCOVER_SEARCH_PHOTOS_BUCKET,
  discoverSearchPhotoPath,
  getSignedDiscoverSearchPhotoUrl,
} from "@/lib/discover-search-photo";
import { generateImageEmbedding } from "@/lib/image-similarity";
import { searchDiscoverByImageEmbedding } from "@/lib/discover-visual-search";

// Called from DiscoverView (client) via an IntersectionObserver sentinel
// near the bottom of the grid — a single call per scroll-triggered
// prefetch, not a loop. categorySlug/typeSlug/searchQuery/styleSlug are
// threaded through so infinite scroll keeps applying the same filters the
// initial page load used, instead of the feed quietly reverting to
// "everything" once the user scrolls past the first batch.
export async function loadMoreDiscoverListings(
  offset: number,
  categorySlug?: string | null,
  typeSlug?: string | null,
  searchQuery?: string | null,
  styleSlug?: string | null,
  sortOption?: DiscoverSortOption,
): Promise<DiscoverBatchResult> {
  return fetchDiscoverBatch(offset, DISCOVER_BATCH_SIZE, categorySlug, typeSlug, searchQuery, styleSlug, sortOption);
}

export type DiscoverPhotoSearchResult = DiscoverBatchResult & {
  // True when the vector search itself came back too sparse and
  // category-based listings were appended to fill out the page — lets
  // the UI say "a few of these are closest-category picks" rather than
  // silently presenting fallback items as if they were all photo matches.
  usedFallback: boolean;
};

/**
 * Hybrid image + semantic search entry point — "search by photo" on
 * /discover (see DiscoverView.tsx). Uploads the given image, embeds it
 * (src/lib/image-similarity.ts, the SAME pipeline that populates
 * listings.visual_embedding, so the vector space lines up), then runs
 * src/lib/discover-visual-search.ts's vector-first hybrid ranking against
 * real inventory. Entirely additive next to loadMoreDiscoverListings
 * above — ordinary text/category/style browsing is completely unchanged;
 * this is only ever invoked when a user actually uploads a photo.
 *
 * The uploaded photo is deleted right after its embedding is generated
 * (see supabase/schema.sql's own comment on the discover-search-photos
 * bucket) — it's a one-shot query image, not something any later page
 * load needs to keep displaying.
 */
export async function searchDiscoverByPhoto(
  formData: FormData,
  categorySlug?: string | null,
  typeSlug?: string | null,
  searchQuery?: string | null,
  styleSlug?: string | null,
): Promise<DiscoverPhotoSearchResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { listings: [], savedListingIds: [], rawCount: 0, usedFallback: false, error: "You must be signed in to search by photo." };
  }

  const image = formData.get("image");
  if (!(image instanceof File) || image.size === 0) {
    return { listings: [], savedListingIds: [], rawCount: 0, usedFallback: false, error: "Add a photo to search with." };
  }
  if (!isAllowedListingPhotoType(image.type)) {
    return { listings: [], savedListingIds: [], rawCount: 0, usedFallback: false, error: "Photo must be JPEG, PNG, WebP, or GIF." };
  }
  if (image.size > MAX_LISTING_PHOTO_BYTES) {
    return { listings: [], savedListingIds: [], rawCount: 0, usedFallback: false, error: "Photo must be 5MB or smaller." };
  }

  const token = randomUUID();
  const extension = LISTING_PHOTO_MIME_EXTENSIONS[image.type];
  const path = discoverSearchPhotoPath(user.id, token, extension);

  const { error: uploadError } = await supabase.storage
    .from(DISCOVER_SEARCH_PHOTOS_BUCKET)
    .upload(path, image, { contentType: image.type });

  if (uploadError) {
    console.error("[discover-feed] Photo-search upload failed:", uploadError);
    return { listings: [], savedListingIds: [], rawCount: 0, usedFallback: false, error: `Could not upload your photo: ${uploadError.message}` };
  }

  try {
    const signedUrl = await getSignedDiscoverSearchPhotoUrl(supabase, path);
    if (!signedUrl) {
      return { listings: [], savedListingIds: [], rawCount: 0, usedFallback: false, error: "Could not process your photo. Please try again." };
    }

    const queryEmbedding = await generateImageEmbedding(signedUrl);
    if (!queryEmbedding) {
      // A real processing failure (unreachable image, vision/embedding
      // call failed) — distinct from "found nothing," which is handled
      // by discover-visual-search.ts's own category fallback, not an
      // error at all. Never claims the photo itself was the problem.
      return {
        listings: [],
        savedListingIds: [],
        rawCount: 0,
        usedFallback: false,
        error: "We couldn't process that photo right now. Please try again.",
      };
    }

    // Same exclusion fetchDiscoverBatch applies — never resurface
    // something the user already saved or already disliked.
    const [{ data: savedRows }, { data: dislikedRows }] = await Promise.all([
      supabase.from("saved_items").select("listing_id").eq("user_id", user.id).not("listing_id", "is", null),
      supabase.from("disliked_items").select("listing_id").eq("user_id", user.id),
    ]);
    const savedListingIds = (savedRows ?? []).map((row) => row.listing_id).filter((id): id is string => Boolean(id));
    const dislikedListingIds = (dislikedRows ?? []).map((row) => row.listing_id).filter((id): id is string => Boolean(id));
    const excludeListingIds = new Set([...savedListingIds, ...dislikedListingIds]);

    const result = await searchDiscoverByImageEmbedding(queryEmbedding, excludeListingIds, {
      categorySlug,
      typeSlug,
      searchQuery,
      styleSlug,
      limit: DISCOVER_BATCH_SIZE,
    });

    if (result.error) {
      return { listings: [], savedListingIds, rawCount: 0, usedFallback: false, error: result.error };
    }

    return {
      // Photo search ranks by vector similarity, not scoreListingMatch —
      // explicit null (not just omitted) so ListingCard knows to render
      // without a match/style-points badge rather than a fabricated value.
      listings: result.listings.map((listing) => ({ ...listing, matchPercent: null, stylePoints: null })),
      savedListingIds,
      rawCount: result.listings.length,
      usedFallback: result.usedFallback,
      error: null,
    };
  } finally {
    // Fire-and-forget cleanup — this photo was only ever needed to
    // generate the embedding above, nothing later reads it back.
    supabase.storage
      .from(DISCOVER_SEARCH_PHOTOS_BUCKET)
      .remove([path])
      .then(({ error }) => {
        if (error) console.error("[discover-feed] Failed to clean up search photo:", path, error);
      });
  }
}
