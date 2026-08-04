"use client";

import { useActionState } from "react";
import Link from "next/link";
import { signUp, type AuthFormState } from "@/app/actions/auth";
import { Button } from "@/components/ui/Button";
import { AppleSignInButton } from "@/components/auth/AppleSignInButton";
import { GoogleSignInButton } from "@/components/auth/GoogleSignInButton";

const initialState: AuthFormState = undefined;

// redirectTo mirrors LoginForm's own prop — /signup has no current caller
// that sets one (proxy.ts only ever bounces to /login), but the button
// itself supports it for consistency/forward-compatibility rather than
// diverging from LoginForm's contract.
export function SignUpForm({ redirectTo }: { redirectTo?: string } = {}) {
  const [state, formAction, pending] = useActionState(signUp, initialState);

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
      <div>
        <label
          htmlFor="name"
          className="mb-1.5 block text-sm font-medium text-ink"
        >
          Name
        </label>
        <input
          id="name"
          name="name"
          type="text"
          autoComplete="name"
          placeholder="Jamie Rivera"
          className="w-full rounded-2xl border border-border bg-surface px-4 py-3 text-sm text-ink placeholder:text-ink-soft/60 focus:border-oxblood focus:outline-none"
        />
        {state?.errors?.name?.map((error) => (
          <p key={error} className="mt-1.5 text-xs text-oxblood">
            {error}
          </p>
        ))}
      </div>

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
        <label
          htmlFor="password"
          className="mb-1.5 block text-sm font-medium text-ink"
        >
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          placeholder="At least 8 characters"
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
        {pending ? "Creating your account…" : "Create account"}
      </Button>

      <p className="text-center text-sm text-ink-soft">
        Already have an account?{" "}
        <Link
          href="/login"
          className="font-medium text-oxblood hover:underline"
        >
          Sign in
        </Link>
      </p>
      </form>
    </div>
  );
}
