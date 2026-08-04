import type { Metadata } from "next";
import Link from "next/link";
import { CheckCircle2 } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { LinkButton } from "@/components/ui/Button";

export const metadata: Metadata = {
  title: "Account deleted — Lockette",
};

// Neutral, public confirmation landing — reachable with no session at
// all (the account no longer exists by the time a user gets here, see
// src/app/actions/account-deletion.ts), same route-group placement as
// /login and /signup for exactly that reason.
export default function AccountDeletedPage() {
  return (
    <Card className="flex flex-col items-center p-8 text-center sm:p-10">
      <CheckCircle2 className="h-10 w-10 text-teal" strokeWidth={1.5} />
      <h1 className="mt-4 font-display text-2xl font-semibold text-ink">Account deleted</h1>
      <p className="mt-3 max-w-sm text-sm text-ink-soft">
        Your Lockette account and personal data have been deleted. If you had a completed order, a limited
        transaction record is retained where required for legal, tax, or fraud-prevention reasons — it&apos;s no
        longer linked to you.
      </p>
      <LinkButton href="/" variant="primary" className="mt-6">
        Back to Lockette
      </LinkButton>
      <Link href="/signup" className="mt-4 text-sm font-medium text-oxblood hover:underline">
        Create a new account
      </Link>
    </Card>
  );
}
