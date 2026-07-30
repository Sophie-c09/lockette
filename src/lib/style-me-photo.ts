// Sibling of src/lib/style-request-photo.ts, identical shape — a private
// bucket + batch signed-URL helper for Style Me's multi-photo inspiration
// upload (src/app/actions/style-me.ts).
export const STYLE_ME_IMAGES_BUCKET = "style-me-images";

export function styleMeImagesFolder(userId: string, requestId: string): string {
  return `${userId}/${requestId}`;
}

const SIGNED_URL_EXPIRY_SECONDS = 60 * 60;

export async function getSignedStyleMeImageUrls(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- matches createClient's own generic default (see src/lib/supabase/server.ts)
  supabase: { storage: { from: (bucket: string) => any } },
  paths: string[],
): Promise<string[]> {
  if (paths.length === 0) return [];

  const { data, error } = await supabase.storage
    .from(STYLE_ME_IMAGES_BUCKET)
    .createSignedUrls(paths, SIGNED_URL_EXPIRY_SECONDS);

  if (error || !data) {
    console.error("[style-me-photo] Failed to sign image URLs:", error);
    return [];
  }

  return data
    .map((entry: { signedUrl?: string | null }) => entry.signedUrl)
    .filter((url: string | null | undefined): url is string => Boolean(url));
}
