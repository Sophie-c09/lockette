"use client";

import { useActionState } from "react";
import Link from "next/link";
import { signIn, type AuthFormState } from "@/app/actions/auth";
import { Button } from "@/components/ui/Button";
import { AppleSignInButton } from "@/components/auth/AppleSignInButton";
import { GoogleSignInButton } from "@/components/auth/GoogleSignInButton";

const initialState: AuthFormState = undefined;

// Pre-submission fix — proxy.ts bounces a signed-out visit to a protected
// route (/likes, /profile, etc.) to /login?redirectTo=<path>, but nothing
// ever read that param: a successful sign-in always landed on /profile
// regardless of what the user was actually trying to reach. Threaded
// through as a hidden field so signIn (src/app/actions/auth.ts) can honor
// it — validated there against being an absolute/external URL before ever
// being used as a redirect target.
export function LoginForm({ redirectTo }: { redirectTo?: string } = {}) {
  const [state, formAction, pending] = useActionState(signIn, initialState);

  return (
    <div className="flex flex-col gap-5">
      <AppleSignInButton redirectTo={redirectTo} />
      <GoogleSignInButton />

      <div className="flex items-center gap-3 text-xs font-medium text-ink-soft">
        <span className="h-px flex-1 bg-border" />
        or continue with email
        <span className="h-px flex-1 bg-border" />
      </div>

      <form action={formAction} className="flex flex-col gap-5">
      {redirectTo && <input type="hidden" name="redirectTo" value={redirectTo} />}
      <div>
        <label
          htmlFor="email"
          className="mb-1.5 block text-sm font-medium text-ink"
        >
          Email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          placeholder="you@example.com"
          className="w-full rounded-2xl border border-border bg-surface px-4 py-3 text-sm text-ink placeholder:text-ink-soft/60 focus:border-oxblood focus:outline-none"
        />
        {state?.errors?.email?.map((error) => (
          <p key={error} className="mt-1.5 text-xs text-oxblood">
            {error}
          </p>
        ))}
      </div>

      <div>
        <div className="mb-1.5 flex items-center justify-between">
          <label htmlFor="password" className="block text-sm font-medium text-ink">
            Password
          </label>
          <Link
            href="/forgot-password"
            className="text-xs font-medium text-oxblood hover:underline"
          >
            Forgot password?
          </Link>
        </div>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          placeholder="••••••••"
          className="w-full rounded-2xl border border-border bg-surface px-4 py-3 text-sm text-ink placeholder:text-ink-soft/60 focus:border-oxblood focus:outline-none"
        />
        {state?.errors?.password?.map((error) => (
          <p key={error} className="mt-1.5 text-xs text-oxblood">
            {error}
          </p>
        ))}
      </div>

      {state?.message && (
        <p className="rounded-2xl bg-oxblood/10 px-4 py-3 text-sm text-oxblood">
          {state.message}
        </p>
      )}

      <Button type="submit" disabled={pending} className="mt-2 w-full">
        {pending ? "Signing in…" : "Sign in"}
      </Button>

      <p className="text-center text-sm text-ink-soft">
        New to Lockette?{" "}
        <Link
          href="/signup"
          className="font-medium text-oxblood hover:underline"
        >
          Create an account
        </Link>
      </p>
      </form>
    </div>
  );
}
