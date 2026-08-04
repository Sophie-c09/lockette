"use client";

// App Store compliance — "Continue with Apple," rendered as the FIRST
// option on both /login and /signup (above GoogleSignInButton — see
// LoginForm.tsx/SignUpForm.tsx), same reasoning/shape as that button: a
// separate <form>/useActionState from the email form on the same page,
// sharing the exact same AuthFormState shape (src/app/actions/auth.ts) so
// a graceful failure (Apple unreachable, OAuth not configured) renders
// with the same styling as every other auth error on this page instead
// of silently doing nothing.
import { useActionState } from "react";
import { signInWithApple, type AuthFormState } from "@/app/actions/auth";
import { Button } from "@/components/ui/Button";

const initialState: AuthFormState = undefined;

// Apple's own glyph, inline (no external font/icon-pack request — same
// "no brand-icon library for a single glyph" reasoning as GoogleIcon in
// GoogleSignInButton.tsx). currentColor so it renders correctly against
// this button's own text color without a separate light/dark variant.
function AppleIcon() {
  return (
    <svg viewBox="0 0 384 512" className="h-4 w-4 shrink-0" fill="currentColor" aria-hidden="true">
      <path d="M318.7 268.7c-.2-36.7 16.4-64.4 50-84.8-18.8-26.9-47.2-41.7-84.7-44.6-35.5-2.8-74.3 20.7-88.5 20.7-15 0-49.4-19.7-76.4-19.7C63.3 141.2 4 184.8 4 273.5q0 39.3 14.4 81.2c12.8 36.7 59 126.7 107.2 125.2 25.2-.6 43-17.9 75.8-17.9 31.8 0 48.3 17.9 76.4 17.9 48.6-.7 90.4-82.5 102.6-119.3-65.2-30.7-61.7-90-61.7-91.9zm-56.6-164.2c27.3-32.4 24.8-61.9 24-72.5-24.1 1.4-52 16.4-67.9 34.9-17.5 19.8-27.8 44.3-25.6 71.9 26.1 2 49.9-11.4 69.5-34.3z" />
    </svg>
  );
}

export function AppleSignInButton({ redirectTo }: { redirectTo?: string } = {}) {
  const [state, formAction, pending] = useActionState(signInWithApple, initialState);

  return (
    <>
      <form action={formAction}>
        {redirectTo && <input type="hidden" name="redirectTo" value={redirectTo} />}
        <Button
          type="submit"
          variant="secondary"
          disabled={pending}
          aria-label="Continue with Apple"
          className="w-full justify-center gap-2.5"
        >
          <AppleIcon />
          {pending ? "Connecting…" : "Continue with Apple"}
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
