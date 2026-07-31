import Link from "next/link";
import type { Metadata } from "next";
import { ResetPasswordForm } from "@/components/auth/ResetPasswordForm";
import { ResetPasswordSessionGate } from "@/components/auth/ResetPasswordSessionGate";
import { Card } from "@/components/ui/Card";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = {
  title: "Set a new password — Lockette",
};

export default async function ResetPasswordPage() {
  // Only reachable with a usable form when a recovery session is already
  // active. That session can be established two ways: /auth/confirm's
  // Route Handler verifying a token_hash/PKCE code server-side before
  // redirecting here (session already set by the time this runs), OR —
  // Supabase's actual default email template — a hash-fragment-delivered
  // session that only ResetPasswordSessionGate (client-side) can read and
  // establish; see that component's own comment for why. Either way, by
  // the time THIS check runs there's no way to tell those two "no session
  // yet" cases apart server-side, which is exactly why the !user branch
  // below defers to the gate instead of assuming failure outright.
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
        {user && (
          <p className="mt-2 text-sm text-ink-soft">
            Choose a new password for your account.
          </p>
        )}
      </div>
      {user ? (
        <ResetPasswordForm />
      ) : (
        <ResetPasswordSessionGate>
          <p className="mb-5 text-center text-sm text-ink-soft">
            This link has expired or already been used.
          </p>
          <p className="text-center text-sm text-ink-soft">
            <Link
              href="/forgot-password"
              className="font-medium text-oxblood hover:underline"
            >
              Request a new reset link
            </Link>
          </p>
        </ResetPasswordSessionGate>
      )}
    </Card>
  );
}
