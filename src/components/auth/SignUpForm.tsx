"use client";

import { useActionState } from "react";
import Link from "next/link";
import { signUp, type AuthFormState } from "@/app/actions/auth";
import { Button } from "@/components/ui/Button";

const initialState: AuthFormState = undefined;

export function SignUpForm() {
  const [state, formAction, pending] = useActionState(signUp, initialState);

  return (
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
  );
}
