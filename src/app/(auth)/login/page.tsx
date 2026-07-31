import Link from "next/link";
import type { Metadata } from "next";
import { LoginForm } from "@/components/auth/LoginForm";
import { Card } from "@/components/ui/Card";

export const metadata: Metadata = {
  title: "Sign in — Lockette",
};

export default function LoginPage() {
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
          Welcome back
        </h1>
        <p className="mt-2 text-sm text-ink-soft">
          Sign in to keep discovering your next favorite find.
        </p>
      </div>
      <LoginForm />
    </Card>
  );
}
