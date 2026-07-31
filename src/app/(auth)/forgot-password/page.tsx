import Link from "next/link";
import type { Metadata } from "next";
import { ForgotPasswordForm } from "@/components/auth/ForgotPasswordForm";
import { Card } from "@/components/ui/Card";

export const metadata: Metadata = {
  title: "Reset your password — Lockette",
};

export default async function ForgotPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  // Set by /auth/confirm's own redirect (src/app/auth/confirm/route.ts)
  // on a genuine verifyOtp/exchangeCodeForSession failure, or by
  // ResetPasswordSessionGate (src/components/auth/ResetPasswordSessionGate.tsx)
  // when the recovery link's URL hash carries an error — e.g. otp_expired,
  // access_denied, session_failed. Matched on "any truthy value" rather
  // than one exact literal, since the real Supabase error code is now
  // passed through directly (see both of those files) rather than a
  // single hardcoded "invalid_link" string — still shown as one generic,
  // friendly message regardless of which specific code came through.
  const { error } = await searchParams;

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
          Forgot your password?
        </h1>
        <p className="mt-2 text-sm text-ink-soft">
          Enter your email and we&apos;ll send you a link to reset it.
        </p>
      </div>
      {error && (
        <p className="mb-5 rounded-2xl bg-oxblood/10 px-4 py-3 text-center text-sm text-oxblood">
          That reset link has expired or already been used. Request a new one below.
        </p>
      )}
      <ForgotPasswordForm />
    </Card>
  );
}
