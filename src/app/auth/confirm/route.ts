// Landing point for Supabase Auth email action links AND OAuth (Google
// sign-in) redirects — originally only used by the forgot-password flow
// (see requestPasswordReset, src/app/actions/auth.ts), now shared by
// signUp's email confirmation and signInWithGoogle too (same file), each
// passing its own `next` (success destination) and `error_next` (failure
// destination — see this file's own comment on why that's no longer
// hardcoded to /forgot-password).
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
  // Defaults to /reset-password since that's this app's original caller,
  // but reads the real query param rather than hardcoding it, so other
  // email-link/OAuth flows (Google sign-in, signup email confirmation)
  // can reuse this same route by passing their own `next`.
  const next = searchParams.get("next") ?? "/reset-password";
  // P0 first-60-seconds fix — the two error redirects below used to be
  // hardcoded to /forgot-password unconditionally, which was correct for
  // THAT flow but wrong for every other caller of this route (a failed
  // Google sign-in landing on the password-reset page, for instance, made
  // no sense at all — a real "graceful failure state" bug). Each caller
  // now passes its own error destination; defaults to /forgot-password
  // only to keep that original flow's exact prior behavior unchanged.
  const errorNext = searchParams.get("error_next") ?? "/forgot-password";

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
    redirect(`${errorNext}?error=${encodeURIComponent(error.code ?? "invalid_link")}`);
  }

  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);

    if (!error) {
      redirect(next);
    }

    logAuthError("exchangeCodeForSession", error);
    redirect(`${errorNext}?error=${encodeURIComponent(error.code ?? "invalid_link")}`);
  }

  // Neither form was present in the query string — see this file's own
  // header comment. NOT a confirmed failure: forward to /reset-password
  // and let its client-side hash-fragment bridge take over, since that's
  // the only place the actual outcome (GoTrue already encoded it in the
  // fragment) can be read at all.
  redirect(next);
}
