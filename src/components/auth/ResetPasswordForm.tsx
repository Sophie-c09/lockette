"use client";

import { useActionState } from "react";
import { updatePassword, type AuthFormState } from "@/app/actions/auth";
import { Button } from "@/components/ui/Button";

const initialState: AuthFormState = undefined;

export function ResetPasswordForm() {
  const [state, formAction, pending] = useActionState(updatePassword, initialState);

  return (
    <form action={formAction} className="flex flex-col gap-5">
      <div>
        <label
          htmlFor="password"
          className="mb-1.5 block text-sm font-medium text-ink"
        >
          New password
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

      <div>
        <label
          htmlFor="confirmPassword"
          className="mb-1.5 block text-sm font-medium text-ink"
        >
          Confirm new password
        </label>
        <input
          id="confirmPassword"
          name="confirmPassword"
          type="password"
          autoComplete="new-password"
          placeholder="Re-enter your new password"
          className="w-full rounded-2xl border border-border bg-surface px-4 py-3 text-sm text-ink placeholder:text-ink-soft/60 focus:border-oxblood focus:outline-none"
        />
        {state?.errors?.confirmPassword?.map((error) => (
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
        {pending ? "Updating…" : "Update password"}
      </Button>
    </form>
  );
}
