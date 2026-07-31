// Landing point for Supabase Auth email action links — currently only
// used by the forgot-password flow (see requestPasswordReset,
// src/app/actions/auth.ts).
//
// ROOT CAUSE (found by reproducing the actual production failure —
// https://www.lockette.org/forgot-password?error=invalid_link#error=access_denied&error_code=otp_expired):
// Supabase's recovery email uses its DEFAULT template ({{ .ConfirmationURL }}),
// which links straight to GoTrue's own hosted /auth/v1/verify endpoint —
// NOT to this route with a token_hash. GoTrue verifies the token ITSELF
// and then redirects here with the actual result encoded in the URL's
// HASH FRAGMENT: on success, #access_token=...&refresh_token=...&type=recovery;
// on failure, #error=...&error_code=otp_expired&error_description=...
// Fragments are never sent to the server (browsers strip them before
// making the HTTP request), so this Route Handler was structurally
// unable to see either outcome — it always fell through to its "no
// params" branch and redirected to /forgot-password?error=invalid_link,
// regardless of whether GoTrue's own verification actually succeeded or
// failed. The original #error=... fragment then survived that redirect
// (confirmed browser behavior — a Location header that omits a fragment
// does not clear the one already in the address bar), producing exactly
// the reported compound URL.
//
// This route still handles the two SERVER-VERIFIABLE forms Supabase can
// also use (token_hash/type, and PKCE code) exactly as before — but when
// neither is present, it now forwards to /reset-password instead of
// assuming failure, so that page's own client-side hash-fragment bridge
// (ResetPasswordSessionGate) can resolve the actual outcome, which is the
// only place a hash fragment can ever be read at all.
import { type EmailOtpType } from "@supabase/supabase-js";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { logAuthError } from "@/lib/auth-diagnostics";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type") as EmailOtpType | null;
  const code = searchParams.get("code");
  // Defaults to /reset-password since that's this app's only current
  // caller, but reads the real query param rather than hardcoding it, so
  // a future second email-link flow (e.g. email change) can reuse this
  // same route by passing its own `next`.
  const next = searchParams.get("next") ?? "/reset-password";

  // Temporary diagnostics (never logs the actual token_hash/code value —
  // only whether each was present) — lets a real failure in production
  // logs show exactly which of the three shapes (token_hash/type, PKCE
  // code, or neither/hash-fragment) an incoming link actually took.
  console.log("[auth] /auth/confirm received:", {
    hasTokenHash: Boolean(tokenHash),
    type,
    hasCode: Boolean(code),
    next,
  });

  const supabase = await createClient();

  if (tokenHash && type) {
    const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });

    if (!error) {
      // type === "recovery" is this app's only current case (see the
      // grep in this task's own investigation notes — one flow, no
      // competing implementation) — `next` already defaults to
      // /reset-password for it; a second email-link flow with a
      // different `type` would simply pass its own `next` value.
      redirect(next);
    }

    // A genuine, confirmed failure — verifyOtp actually ran and rejected
    // this token (expired, already used, or malformed). This is the one
    // case that really is "verification failed," unlike the fall-through
    // case below.
    logAuthError("verifyOtp", error);
    redirect(`/forgot-password?error=${encodeURIComponent(error.code ?? "invalid_link")}`);
  }

  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);

    if (!error) {
      redirect(next);
    }

    logAuthError("exchangeCodeForSession", error);
    redirect(`/forgot-password?error=${encodeURIComponent(error.code ?? "invalid_link")}`);
  }

  // Neither form was present in the query string — see this file's own
  // header comment. NOT a confirmed failure: forward to /reset-password
  // and let its client-side hash-fragment bridge take over, since that's
  // the only place the actual outcome (GoTrue already encoded it in the
  // fragment) can be read at all.
  console.log("[auth] /auth/confirm: no token_hash/code in query string — forwarding to", next, "for client-side hash-fragment handling");
  redirect(next);
}
