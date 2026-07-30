"use server";

// Positive-learning half of the Full Style Learning System: an admin
// manually curates and adds a listing directly (bypassing the scraper
// entirely), and it's ALSO logged to approved_items so
// src/lib/positive-learning.ts has real signal to learn from. Mirrors
// src/app/actions/listings.ts's createListing two-phase insert/upload/
// patch shape (the closest existing template for "insert a listing row,
// then upload its photos"), with three differences:
// - Admin-gated (requireAdmin(), same local copy-per-file convention as
//   adminListingRemoval.ts), not any signed-in user.
// - Inserted status: 'active' directly, not 'pending' — an admin
//   manually choosing to add something IS the moderation decision
//   (the same reasoning approveListing already establishes: an admin's
//   own action doesn't need to separately go through the queue it would
//   otherwise populate).
// - Also runs this listing's own cover photo through scoreListingStyle/
//   scoreImageOutfitPotential (the same scoring the scraper's filter
//   pipeline uses) so its style_score/image_score/tags/fit/aesthetic
//   columns are populated consistently whether a listing came from the
//   scraper or a manual add — and so approved_items gets a real signal
//   to extract from, not empty fields.
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { isCurrentUserAdmin } from "@/lib/admin";
import { revalidatePath } from "next/cache";
import { parseHashtagsToAestheticTags } from "@/lib/listing-hashtags";
import { scoreListingStyle } from "@/lib/style-score";
import { scoreImageOutfitPotential } from "@/lib/image-score";
import { generateAndSaveListingEmbedding } from "@/lib/listing-embeddings";
import {
  isAllowedListingPhotoType,
  LISTING_PHOTO_MIME_EXTENSIONS,
  MAX_LISTING_PHOTO_BYTES,
  MAX_LISTING_IMAGES,
  MIN_LISTING_PHOTOS,
} from "@/lib/listing-photo";

const LISTING_PHOTOS_BUCKET = "listing-photos";

// Namespaced separately from user-owned folders (${userId}/${listingId},
// see listings.ts) purely for readability in the bucket — RLS isn't what
// enforces this path, createAdminClient() bypasses it entirely, same as
// every other admin-only storage write in this codebase.
function adminListingPhotosFolder(listingId: string): string {
  return `admin/${listingId}`;
}

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

export interface AddApprovedListingInput {
  title: string;
  description?: string;
  price: number;
  category: string;
  size?: string;
  color?: string;
  brand?: string;
  hashtagsRaw?: string;
  photos: File[];
}

export interface AddApprovedListingResult {
  error?: string;
  listingId?: string;
}

export async function addApprovedListing(input: AddApprovedListingInput): Promise<AddApprovedListingResult> {
  const authCheck = await requireAdmin();
  if (authCheck.error) return authCheck;

  if (!input.title.trim()) return { error: "Title is required." };
  if (!input.category.trim()) return { error: "Category is required." };
  if (!(input.price > 0)) return { error: "Price must be greater than $0." };

  if (input.photos.length < MIN_LISTING_PHOTOS) return { error: "Add at least one photo." };
  if (input.photos.length > MAX_LISTING_IMAGES) {
    return { error: `You can upload up to ${MAX_LISTING_IMAGES} photos.` };
  }
  for (const photo of input.photos) {
    if (!isAllowedListingPhotoType(photo.type)) return { error: "Photos must be JPEG, PNG, WebP, or GIF." };
    if (photo.size > MAX_LISTING_PHOTO_BYTES) return { error: "Each photo must be 5MB or smaller." };
  }

  const supabase = createAdminClient();
  const aestheticTags = parseHashtagsToAestheticTags(input.hashtagsRaw ?? "");

  const { data: listing, error: insertError } = await supabase
    .from("listings")
    .insert({
      title: input.title,
      description: input.description || null,
      price: input.price,
      category: input.category,
      size: input.size || null,
      color: input.color || null,
      brand: input.brand || null,
      aesthetic_tags: aestheticTags,
      images: [],
      image_url: null,
      status: "active",
      shipping_cost: 0,
    })
    .select("id")
    .single();

  if (insertError || !listing) {
    return { error: insertError?.message ?? "Couldn't add this listing. Please try again." };
  }

  const images: string[] = [];

  for (let i = 0; i < input.photos.length; i++) {
    const photo = input.photos[i];
    const extension = LISTING_PHOTO_MIME_EXTENSIONS[photo.type];
    const path = `${adminListingPhotosFolder(listing.id)}/${i}.${extension}`;

    const { error: uploadError } = await supabase.storage
      .from(LISTING_PHOTOS_BUCKET)
      .upload(path, photo, { contentType: photo.type });

    if (uploadError) {
      await cleanupFailedAdd(supabase, listing.id);
      return { error: `Could not upload photo ${i + 1}: ${uploadError.message}` };
    }

    const {
      data: { publicUrl },
    } = supabase.storage.from(LISTING_PHOTOS_BUCKET).getPublicUrl(path);
    images.push(publicUrl);
  }

  const { score: styleScore, style: matchedStyle } = scoreListingStyle({
    title: input.title,
    description: input.description ?? null,
  });
  const imageData = images[0] ? await scoreImageOutfitPotential(images[0]) : null;

  const { error: patchError } = await supabase
    .from("listings")
    .update({
      images,
      image_url: images[0] ?? null,
      style_score: styleScore,
      matched_style: matchedStyle,
      image_score: imageData?.score ?? null,
      image_tags: imageData?.tags ?? null,
      fit_type: imageData?.fit ?? null,
      visual_aesthetic: imageData?.aesthetic ?? null,
    })
    .eq("id", listing.id);

  if (patchError) {
    await cleanupFailedAdd(supabase, listing.id);
    return { error: "Could not save this listing's photos. Please try again." };
  }

  // Best-effort, never blocks this add — see generateAndSaveListingEmbedding's
  // own comment (src/lib/listing-embeddings.ts) on why a failure here is
  // caught/logged internally rather than surfaced as an add failure.
  await generateAndSaveListingEmbedding(listing.id, images[0] ?? null);

  const { error: approvedError } = await supabase.from("approved_items").insert({
    listing_id: listing.id,
    image_url: images[0] ?? null,
    title: input.title,
    description: input.description || null,
    tags: imageData?.tags ?? null,
    fit: imageData?.fit ?? null,
    aesthetic: imageData?.aesthetic ?? null,
  });

  if (approvedError) {
    // Best-effort — the listing itself is already live and correct, so a
    // failed audit-row insert shouldn't be reported as if the add failed.
    console.error("[admin-listing-add] Failed to record approved_items row:", approvedError);
  }

  revalidatePath("/discover");

  return { listingId: listing.id };
}

// Compensating cleanup for the two-phase insert/upload/patch above — same
// reasoning as listings.ts's cleanupFailedListing.
async function cleanupFailedAdd(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- matches createAdminClient's own generic default
  supabase: ReturnType<typeof createAdminClient<any>>,
  listingId: string,
): Promise<void> {
  const folder = adminListingPhotosFolder(listingId);
  const { data: files } = await supabase.storage.from(LISTING_PHOTOS_BUCKET).list(folder);
  if (files && files.length > 0) {
    await supabase.storage.from(LISTING_PHOTOS_BUCKET).remove(files.map((file) => `${folder}/${file.name}`));
  }
  await supabase.from("listings").delete().eq("id", listingId);
}
