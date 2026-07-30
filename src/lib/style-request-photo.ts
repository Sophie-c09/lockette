// Shared between the client-side file picker (StyleRequestForm.tsx) and
// the server-side upload/display logic (src/app/actions/style-requests.ts,
// src/lib/styleRequestAdmin.ts). Mirrors src/lib/listing-photo.ts's shape,
// except this bucket is private (see supabase/schema.sql's own comment) —
// so display goes through signed URLs, not getPublicUrl().
export const STYLE_REQUEST_IMAGES_BUCKET = "style-request-images";

export function styleRequestImagesFolder(userId: string, requestId: string): string {
  return `${userId}/${requestId}`;
}

// Batch-signs a list of storage paths (not public URLs — inspo_images
// stores raw paths, since a public URL wouldn't be fetchable against a
// private bucket anyway) for temporary display. 1 hour is generous enough
// for a single page view/admin review session without leaving links
// valid indefinitely.
const SIGNED_URL_EXPIRY_SECONDS = 60 * 60;

export async function getSignedStyleRequestImageUrls(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- matches createClient's own generic default (see src/lib/supabase/server.ts)
  supabase: { storage: { from: (bucket: string) => any } },
  paths: string[],
): Promise<string[]> {
  if (paths.length === 0) return [];

  const { data, error } = await supabase.storage
    .from(STYLE_REQUEST_IMAGES_BUCKET)
    .createSignedUrls(paths, SIGNED_URL_EXPIRY_SECONDS);

  if (error || !data) {
    console.error("[style-request-photo] Failed to sign image URLs:", error);
    return [];
  }

  const signedUrls = data
    .map((entry: { signedUrl?: string | null }) => entry.signedUrl)
    .filter((url: string | null | undefined): url is string => Boolean(url));

  return signedUrls;
}
