import Link from "next/link";
import type { Metadata } from "next";
import { SignUpForm } from "@/components/auth/SignUpForm";
import { Card } from "@/components/ui/Card";

export const metadata: Metadata = {
  title: "Create your account — Lockette",
};

export default function SignUpPage() {
  return (
    <Card className="p-8 sm:p-10">
      <div className="mb-8 text-center">
        <Link
          href="/"
          className="font-display text-lg font-semibold text-ink"
        >
          Mav<span className="text-oxblood">elle</span>
        </Link>
        <h1 className="mt-4 font-display text-2xl font-semibold text-ink">
          Create your style profile
        </h1>
        <p className="mt-2 text-sm text-ink-soft">
          Takes two minutes. Cancel anytime.
        </p>
      </div>
      <SignUpForm />
    </Card>
  );
}
