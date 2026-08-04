import Link from "next/link";
import type { Metadata } from "next";
import { LoginForm } from "@/components/auth/LoginForm";
import { Card } from "@/components/ui/Card";

export const metadata: Metadata = {
  title: "Sign in — Lockette",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ reset?: string; verified?: string; error?: string; redirectTo?: string }>;
}) {
  // Set by updatePassword's own redirect (src/app/actions/auth.ts) after a
  // successful password reset — a plain query param rather than
  // LoginForm's own action-state message, since that state only ever
  // comes from a submission of THIS form, not from arriving via redirect.
  //
  // `verified` — P0 first-60-seconds fix (item 3): set by signUp's
  // emailRedirectTo (via /auth/confirm) once a signup confirmation link
  // is actually verified, so a brand-new user lands here instead of the
  // homepage with zero context. `error` — set by /auth/confirm's own
  // error_next when a confirmation/Google-sign-in link fails/expires (a
  // graceful failure state instead of a silent nothing-happened redirect).
  //
  // `redirectTo` — set by proxy.ts when a signed-out visit to a protected
  // route gets bounced here, so a successful sign-in can return the user
  // to where they were actually headed instead of always landing on
  // /profile.
  const { reset, verified, error, redirectTo } = await searchParams;

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
      {reset === "success" && (
        <p className="mb-5 rounded-2xl bg-darkgreen/10 px-4 py-3 text-center text-sm text-darkgreen">
          Password updated — sign in with your new password.
        </p>
      )}
      {verified === "true" && (
        <p className="mb-5 rounded-2xl bg-darkgreen/10 px-4 py-3 text-center text-sm text-darkgreen">
          ✓ Email verified successfully.
          <br />
          Please sign in to continue.
        </p>
      )}
      {error && (
        <p className="mb-5 rounded-2xl bg-oxblood/10 px-4 py-3 text-center text-sm text-oxblood">
          That link has expired or already been used. Please try again.
        </p>
      )}
      <LoginForm redirectTo={redirectTo} />
    </Card>
  );
}
