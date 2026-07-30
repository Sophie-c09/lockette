import { createClient as createSupabaseClient } from "@supabase/supabase-js";

// Service-role client for trusted, server-only writes that must bypass RLS.
// `listings` only grants public SELECT (see supabase/schema.sql) — there is
// no per-user write policy because /admin/import has no auth yet, so admin
// writes go through this client instead of the normal anon-key
// createClient() in ./server.ts, which RLS would otherwise reject.
//
// Only ever call this from server-side code (Server Actions, Route
// Handlers) — never from a "use client" component. Requires
// SUPABASE_SERVICE_ROLE_KEY (server-only env var, no NEXT_PUBLIC_ prefix)
// to be set in .env.local; see .env.local.example.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createAdminClient<Database = any>() {
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!serviceRoleKey) {
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY is not set. Add it to .env.local at the " +
        "project root (see .env.local.example for the expected line) — " +
        "it's required for admin writes such as saving imported listings, " +
        "which bypass RLS. Already added it? Next.js only reads " +
        ".env.local when the dev server starts, not on every request — " +
        "stop and re-run `npm run dev` after editing it.",
    );
  }

  return createSupabaseClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    serviceRoleKey,
  );
}
