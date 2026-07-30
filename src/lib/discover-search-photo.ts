// Sibling of src/lib/outfit-photo.ts, same private-bucket + signed-URL
// pattern — except these uploads are purely ephemeral (see
// supabase/schema.sql's own comment on this bucket): the caller
// (src/app/actions/discover-feed.ts's searchDiscoverByPhoto) deletes the
// object right after generating its embedding, rather than keeping it
// around for later display the way outfit-photos does.
export const DISCOVER_SEARCH_PHOTOS_BUCKET = "discover-search-photos";

export function discoverSearchPhotoPath(userId: string, token: string, extension: string): string {
  return `${userId}/${token}/photo.${extension}`;
}

const SIGNED_URL_EXPIRY_SECONDS = 60 * 60;

export async function getSignedDiscoverSearchPhotoUrl(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- matches createClient's own generic default (see src/lib/supabase/server.ts)
  supabase: { storage: { from: (bucket: string) => any } },
  path: string,
): Promise<string | null> {
  const { data, error } = await supabase.storage
    .from(DISCOVER_SEARCH_PHOTOS_BUCKET)
    .createSignedUrl(path, SIGNED_URL_EXPIRY_SECONDS);

  if (error || !data?.signedUrl) {
    console.error("[discover-search-photo] Failed to sign photo URL:", error);
    return null;
  }

  return data.signedUrl;
}
