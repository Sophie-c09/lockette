// Shared between the client-side file picker (ProfileForm.tsx) and the
// server-side upload validation (src/app/actions/profile.ts) — kept in one
// place so the client's pre-check and the server's authoritative check
// (never trust client-side validation alone) can't drift out of sync with
// each other, or with the "avatars" bucket's own file_size_limit/
// allowed_mime_types in supabase/schema.sql.
export const MAX_AVATAR_BYTES = 5 * 1024 * 1024; // 5MB

export const AVATAR_MIME_EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};

export function isAllowedAvatarType(mimeType: string): boolean {
  return mimeType in AVATAR_MIME_EXTENSIONS;
}
