// Single source of truth for the "who is admin" app-level check. The real
// enforcement boundary is the matching is_admin() SQL function in
// supabase/schema.sql (reads the same profiles.is_admin column) — this is
// for a clear, early "Access denied" at the page/action level, not the
// only guard.
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * True if `userId` currently has the admin flag set. A real, DB-backed
 * role check — replacing the previous hardcoded-email comparison, so
 * granting a second admin is a one-line SQL update (see the bootstrap
 * comment on profiles.is_admin in supabase/schema.sql) rather than a code
 * change. Fails closed (false) on any read error, same reasoning as every
 * other "never let a broken check silently grant access" pattern in this
 * codebase.
 */
export async function isCurrentUserAdmin(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- matching createClient()'s own untyped default (see supabase/server.ts)
  supabase: SupabaseClient<any>,
  userId: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from("profiles")
    .select("is_admin")
    .eq("id", userId)
    .maybeSingle();

  if (error) {
    console.error("[admin] Failed to fetch is_admin:", error);
    return false;
  }

  return data?.is_admin === true;
}
