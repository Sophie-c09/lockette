import Stripe from "stripe";

// Server-only Stripe client. Never imported by a Client Component — every
// caller is either a Server Action gated by requireAdmin() (see
// src/lib/payment.ts) or the webhook Route Handler (which verifies Stripe's
// own signature instead of a user session).
//
// STRIPE_SECRET_KEY is allowed to be unset in local dev. The SDK itself
// throws immediately if its constructor gets a falsy/empty key ("Neither
// apiKey nor config.authenticator provided") — that would crash on module
// load (and therefore crash the build, since Next collects page data for
// every route at build time), well before any of payment.ts's own
// try/catch blocks could run. A non-empty placeholder keeps construction
// safe either way: with no real key configured, an actual API call still
// fails (a normal, caught Stripe authentication error), it just fails at
// request time instead of at import time.
const apiKey = process.env.STRIPE_SECRET_KEY || "sk_test_not_configured";

// apiVersion is pinned to whatever this installed SDK's own bundled
// "latest stable" version is (Stripe.API_VERSION), rather than a hardcoded
// string, so it stays correct automatically when the `stripe` package is
// upgraded.
export const stripe = new Stripe(apiKey, {
  apiVersion: Stripe.API_VERSION,
});
