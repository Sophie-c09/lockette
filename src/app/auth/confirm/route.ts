// Landing point for Supabase Auth email action links (currently only used
// by the forgot-password flow — see requestPasswordReset,
// src/app/actions/auth.ts). Uses the token_hash/verifyOtp verification
// method (Supabase's own recommended pattern for email action links in an
// App Router + @supabase/ssr setup) rather than the OAuth-style `code`
// param: token_hash verification is independent of the client's
// flowType ("pkce" here, see createServerClient/createBrowserClient),
// and is what GoTrue's default email templates actually link to
// ({{ .SiteURL }}/auth/confirm?token_hash=...&type=...&next=...).
//
// Verifying here (a Route Handler) rather than in a page/Server Component
// matters because only a Route Handler/Server Action can WRITE the
// resulting session cookie — verifyOtp establishes a real session, and
// createClient()'s cookie adapter (src/lib/supabase/server.ts) needs a
// mutable response to attach it to.
import { type EmailOtpType } from "@supabase/supabase-js";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type") as EmailOtpType | null;
  // Defaults to /reset-password since that's this app's only current
  // caller, but reads the real query param rather than hardcoding it, so
  // a future second email-link flow (e.g. email change) can reuse this
  // same route by passing its own `next`.
  const next = searchParams.get("next") ?? "/reset-password";

  if (tokenHash && type) {
    const supabase = await createClient();
    const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });

    if (!error) {
      redirect(next);
    }

    console.error("[auth] verifyOtp failed:", { code: error.code ?? null, status: error.status ?? null, message: error.message });
  }

  // Missing/invalid/expired/already-used link — sent back to request a
  // fresh one rather than at a bare error page with no next step.
  redirect("/forgot-password?error=invalid_link");
}
