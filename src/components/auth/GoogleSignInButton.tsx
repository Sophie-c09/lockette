"use client";

// P0 first-60-seconds fix (item 2) — "Continue with Google," rendered as
// the FIRST option on both /login and /signup (see LoginForm.tsx/
// SignUpForm.tsx). A separate <form>/useActionState from the email
// form on the same page — they're two independent submissions, not
// fields of one form — but shares the exact same AuthFormState shape
// (src/app/actions/auth.ts) so a graceful failure (Google unreachable,
// OAuth not configured) renders with the same styling as every other
// auth error on this page instead of silently doing nothing.
import { useActionState } from "react";
import { signInWithGoogle, type AuthFormState } from "@/app/actions/auth";
import { Button } from "@/components/ui/Button";

const initialState: AuthFormState = undefined;

// Official Google "G" mark, inline (no external font/icon-pack request —
// this app has no brand-icon library, and pulling one in just for this
// single glyph isn't worth a new dependency).
function GoogleIcon() {
  return (
    <svg viewBox="0 0 48 48" className="h-4 w-4 shrink-0" aria-hidden="true">
      <path
        fill="#FFC107"
        d="M43.6 20.5H42V20.5H24V27.5H35.3C33.7 32 29.5 35.5 24 35.5C16.5 35.5 10.5 29.5 10.5 22C10.5 14.5 16.5 8.5 24 8.5C27.5 8.5 30.6 9.8 33 12L38 7C34.5 3.8 29.5 1.5 24 1.5C11.6 1.5 1.5 11.6 1.5 24C1.5 36.4 11.6 46.5 24 46.5C36.4 46.5 46.5 36.4 46.5 24C46.5 22.8 46.4 21.6 46.6 20.5H43.6Z"
      />
      <path
        fill="#FF3D00"
        d="M4.7 12.8L11.3 17.7C13.1 13.3 18.2 8.5 24 8.5C27.5 8.5 30.6 9.8 33 12L38 7C34.5 3.8 29.5 1.5 24 1.5C15.6 1.5 8.4 6.2 4.7 12.8Z"
      />
      <path
        fill="#4CAF50"
        d="M24 46.5C29.4 46.5 34.3 44.3 37.8 40.8L32.2 36.1C30.2 37.6 27.4 38.5 24 38.5C18.5 38.5 14.3 35 12.7 30.6L6.2 35.7C9.8 42.2 16.4 46.5 24 46.5Z"
      />
      <path
        fill="#1976D2"
        d="M43.6 20.5H42V20.5H24V27.5H35.3C34.5 29.6 33.1 31.4 31.2 32.7C31.2 32.7 31.2 32.7 32.2 32.6L37.8 37.3C37.4 37.6 46.5 32.5 46.5 24C46.5 22.8 46.4 21.6 46.6 20.5H43.6Z"
      />
    </svg>
  );
}

export function GoogleSignInButton() {
  const [state, formAction, pending] = useActionState(signInWithGoogle, initialState);

  return (
    <>
      <form action={formAction}>
        <Button
          type="submit"
          variant="secondary"
          disabled={pending}
          className="w-full justify-center gap-2.5"
        >
          <GoogleIcon />
          {pending ? "Connecting…" : "Continue with Google"}
        </Button>
      </form>
      {state?.message && (
        <p className="mt-3 rounded-2xl bg-oxblood/10 px-4 py-3 text-sm text-oxblood">
          {state.message}
        </p>
      )}
    </>
  );
}
