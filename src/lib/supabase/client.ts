import { createBrowserClient } from "@supabase/ssr";

// Generic defaults to the library's own untyped behavior, so every existing
// createClient() call site is unaffected — callers that want typed table
// access (e.g. createClient<ListingsDatabase>()) opt in explicitly.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createClient<Database = any>() {
  return createBrowserClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}
