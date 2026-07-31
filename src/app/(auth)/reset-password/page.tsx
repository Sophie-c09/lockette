import Link from "next/link";
import type { Metadata } from "next";
import { ResetPasswordForm } from "@/components/auth/ResetPasswordForm";
import { Card } from "@/components/ui/Card";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = {
  title: "Set a new password — Lockette",
};

export default async function ResetPasswordPage() {
  // Only reachable with a usable form when a recovery session is already
  // active (established by /auth/confirm's verifyOtp call just before
  // this page loads) — someone landing here directly, or with a stale/
  // reused link, has no session at all rather than the wrong one.
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  return (
    <Card className="p-8 sm:p-10">
      <div className="mb-8 text-center">
        <Link
          href="/"
          className="font-display text-lg font-semibold text-ink"
        >
          Lock<span className="text-oxblood">ette</span>
        </Link>
        <h1 className="mt-4 font-display text-2xl font-semibold text-ink">
          Set a new password
        </h1>
        {user ? (
          <p className="mt-2 text-sm text-ink-soft">
            Choose a new password for your account.
          </p>
        ) : (
          <p className="mt-2 text-sm text-ink-soft">
            This link has expired or already been used.
          </p>
        )}
      </div>
      {user ? (
        <ResetPasswordForm />
      ) : (
        <p className="text-center text-sm text-ink-soft">
          <Link
            href="/forgot-password"
            className="font-medium text-oxblood hover:underline"
          >
            Request a new reset link
          </Link>
        </p>
      )}
    </Card>
  );
}
