import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

// Generic defaults to the library's own untyped behavior, so every existing
// createClient() call site is unaffected — callers that want typed table
// access (e.g. createClient<ListingsDatabase>()) opt in explicitly.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function createClient<Database = any>() {
  const cookieStore = await cookies();

  return createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            );
          } catch {
            // Called from a Server Component render — safe to ignore since
            // proxy.ts refreshes the session cookie on every request.
          }
        },
      },
    },
  );
}
