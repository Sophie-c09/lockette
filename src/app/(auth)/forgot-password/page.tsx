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
  // when verifyOtp fails — a missing/invalid/expired/already-used link.
  // This used to be a query param nobody ever read, so a broken link
  // silently dropped the user back here with zero explanation.
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
      {error === "invalid_link" && (
        <p className="mb-5 rounded-2xl bg-oxblood/10 px-4 py-3 text-center text-sm text-oxblood">
          That reset link has expired or already been used. Request a new one below.
        </p>
      )}
      <ForgotPasswordForm />
    </Card>
  );
}
