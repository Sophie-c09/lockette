"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

// Bridges Supabase's default recovery-email flow, which delivers its
// result in the URL's HASH FRAGMENT (#access_token=...&refresh_token=...
// &type=recovery on success, or #error=...&error_code=otp_expired on
// failure) rather than as query params — see src/app/auth/confirm/
// route.ts's own header comment for the full root-cause explanation.
// Fragments are never sent to the server, so this is the ONE piece of
// the recovery flow that structurally cannot be handled server-side.
//
// Only ever rendered by /reset-password when the server-side session
// check there already came back empty (see that page's own logic) — if
// a session already exists (e.g. the token_hash/PKCE query-string forms,
// which /auth/confirm's Route Handler verifies and cookie-sets server-
// side before ever reaching this page), this component is never mounted
// at all.
type HashOutcome =
  | { kind: "none" }
  | { kind: "error"; code: string }
  | { kind: "session"; accessToken: string; refreshToken: string };

// Pure, synchronous read — safe to run as a useState lazy initializer
// (during render, not as a side effect) rather than inside useEffect,
// which is what a linter would otherwise flag as an avoidable
// setState-in-effect. window is guarded for the server-rendered pass of
// this "use client" component; the client-side hydration render is what
// actually reads the real fragment.
function readHashOutcome(): HashOutcome {
  if (typeof window === "undefined") return { kind: "none" };

  const rawHash = window.location.hash;
  const hash = rawHash.startsWith("#") ? rawHash.slice(1) : rawHash;
  const params = new URLSearchParams(hash);

  const errorCode = params.get("error_code") ?? params.get("error");
  if (errorCode) return { kind: "error", code: errorCode };

  const accessToken = params.get("access_token");
  const refreshToken = params.get("refresh_token");
  if (accessToken && refreshToken) return { kind: "session", accessToken, refreshToken };

  return { kind: "none" };
}

export function ResetPasswordSessionGate({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [outcome] = useState(readHashOutcome);

  useEffect(() => {
    if (outcome.kind === "error") {
      // Never logs the token/code itself — only the error code, same
      // "safe diagnostics" rule as the server-side logAuthError calls.
      console.error("[auth] recovery link error in URL fragment:", outcome.code);
      router.replace(`/forgot-password?error=${encodeURIComponent(outcome.code)}`);
      return;
    }

    if (outcome.kind === "session") {
      const supabase = createClient();
      supabase.auth
        .setSession({ access_token: outcome.accessToken, refresh_token: outcome.refreshToken })
        .then(({ error }) => {
          if (error) {
            console.error("[auth] setSession from recovery link failed:", error.message);
            router.replace("/forgot-password?error=session_failed");
            return;
          }
          // Clears the sensitive fragment from the address bar before
          // reloading the server-rendered tree with the now-established
          // session — router.refresh() re-runs reset-password/page.tsx's
          // own server-side getUser() check, which will now find a real
          // session and render the actual form instead of this gate.
          window.history.replaceState(null, "", window.location.pathname + window.location.search);
          router.refresh();
        });
    }

    // outcome.kind === "none" — no hash tokens and no hash error either, a
    // genuinely invalid or direct visit, not a recovery link at all.
    // Nothing to bridge; the render below already falls through to
    // whatever fallback UI the parent passed as children.
  }, [outcome, router]);

  if (outcome.kind === "none") {
    return <>{children}</>;
  }

  return <p className="text-center text-sm text-ink-soft">Verifying your link…</p>;
}
