import Link from "next/link";
import type { Metadata } from "next";
import { ForgotPasswordForm } from "@/components/auth/ForgotPasswordForm";
import { Card } from "@/components/ui/Card";

export const metadata: Metadata = {
  title: "Reset your password — Lockette",
};

export default function ForgotPasswordPage() {
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
      <ForgotPasswordForm />
    </Card>
  );
}
