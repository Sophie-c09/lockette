// Shared between the client-side file picker (SellItemForm.tsx,
// ListingEditModal.tsx) and the server-side upload validation
// (src/app/actions/listings.ts) — same reasoning as src/lib/avatar.ts:
// client and server checks can't drift out of sync with each other, or
// with the "listing-photos" bucket's own file_size_limit/
// allowed_mime_types in supabase/schema.sql.
export const MAX_LISTING_PHOTO_BYTES = 5 * 1024 * 1024; // 5MB

// Style Request inspo photos specifically — kept separate from
// MAX_LISTING_PHOTO_BYTES above (which stays 5MB for seller listings,
// admin add, Style Me, and Recreate This Outfit) so raising this limit
// for AI bundle generation doesn't silently change upload limits for
// those other flows too.
export const MAX_STYLE_REQUEST_PHOTO_BYTES = 10 * 1024 * 1024; // 10MB

export const LISTING_PHOTO_MIME_EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};

export function isAllowedListingPhotoType(mimeType: string): boolean {
  return mimeType in LISTING_PHOTO_MIME_EXTENSIONS;
}

// A seller needs at least one photo (this is a peer-to-peer sell flow, not
// a scrape that might legitimately lack one) and a sane upper bound to
// keep the storage path's `${index}.${ext}` scheme small and the upload
// request bounded.
export const MIN_LISTING_PHOTOS = 1;
export const MAX_LISTING_PHOTOS = 8;

// How many photos a `listings` row itself (the `images` column, see
// supabase/schema.sql) can ever hold — deliberately its own constant,
// separate from MAX_LISTING_PHOTOS above even though the two happen to be
// reused from the same file: MAX_LISTING_PHOTOS is Style Request/Style
// Me's own inspo-photo upload limit (a different table entirely —
// style_requests.inspo_images/style_me_requests, not `listings`), while
// this one is the actual "how many photos can one listing have" rule,
// enforced everywhere a `listings` row's images are written: the scraper/
// import extraction pipeline (src/lib/extraction/normalize-images.ts),
// the admin manual-add flow (src/lib/adminListingAdd.ts), and the admin
// photo-management save action (src/lib/listingModeration.ts).
export const MAX_LISTING_IMAGES = 4;
