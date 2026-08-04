import Stripe from "stripe";

// Server-only Stripe client. Never imported by a Client Component — every
// caller is either a protected Server Action (src/lib/payment.ts) or the
// webhook Route Handler (which verifies Stripe's own signature instead of
// a user session).
//
// STRIPE_SECRET_KEY is allowed to be unset in local dev/CI (e.g. running
// the build or unit tests with no Stripe account configured at all). The
// SDK itself throws immediately if its constructor gets a falsy/empty key
// ("Neither apiKey nor config.authenticator provided") — that would crash
// on module load (and therefore crash the build, since Next collects page
// data for every route at build time), well before any caller's own
// try/catch could run. A non-empty placeholder keeps construction safe
// either way; requireStripeConfigured() below is what actually enforces a
// real key is present before any payment code path proceeds, with a clear
// error rather than a confusing Stripe authentication failure three calls
// deep.
const apiKey = process.env.STRIPE_SECRET_KEY || "sk_test_not_configured";

// apiVersion is pinned to whatever this installed SDK's own bundled
// "latest stable" version is (Stripe.API_VERSION), rather than a hardcoded
// string, so it stays correct automatically when the `stripe` package is
// upgraded.
export const stripe = new Stripe(apiKey, {
  apiVersion: Stripe.API_VERSION,
});

// Fail safely and clearly — never printed value, just presence/absence —
// before any real Stripe call is attempted. Every payment-creating code
// path (src/lib/payment.ts) and the webhook route call this (or check
// STRIPE_WEBHOOK_SECRET directly) first, so a missing key surfaces as one
// unambiguous server error instead of a generic Stripe SDK exception
// several layers down.
export function requireStripeConfigured(): void {
  if (!process.env.STRIPE_SECRET_KEY) {
    throw new Error(
      "Payments are not configured on this server (STRIPE_SECRET_KEY is not set). " +
        "Add it to your environment and redeploy — see .env.local.example.",
    );
  }
}
