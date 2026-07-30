// Sibling of src/lib/style-request-photo.ts, same private-bucket +
// signed-URL pattern — except there's only ever one photo per outfit
// recreation, so the path is keyed off a random token generated before
// the row exists, not the row's own id (see
// src/app/actions/outfit-recreations.ts).
export const OUTFIT_PHOTOS_BUCKET = "outfit-photos";

export function outfitPhotoPath(userId: string, token: string, extension: string): string {
  return `${userId}/${token}/photo.${extension}`;
}

const SIGNED_URL_EXPIRY_SECONDS = 60 * 60;

export async function getSignedOutfitPhotoUrl(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- matches createClient's own generic default (see src/lib/supabase/server.ts)
  supabase: { storage: { from: (bucket: string) => any } },
  path: string,
): Promise<string | null> {
  const { data, error } = await supabase.storage
    .from(OUTFIT_PHOTOS_BUCKET)
    .createSignedUrl(path, SIGNED_URL_EXPIRY_SECONDS);

  if (error || !data?.signedUrl) {
    console.error("[outfit-photo] Failed to sign photo URL:", error);
    return null;
  }

  return data.signedUrl;
}
