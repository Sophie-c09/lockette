import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Real Stripe payment system — replaces the fake authorize-with-no-card
// flow. Source-level assertions, same convention as
// tests/admin-scraper-run-architecture.test.ts and
// tests/match-feed-cold-start.test.ts: createOrReusePaymentIntent and the
// webhook route both need a real Supabase session / a real signed Stripe
// event to exercise end-to-end, which this project's unit suite
// deliberately avoids depending on (no live Stripe, no mocking
// framework installed) — these assertions verify the actual safety
// invariants (ownership checks, amount/currency verification, webhook
// idempotency) are present in the source, not just that some test ran.
const paymentSource = readFileSync(join(__dirname, "..", "src", "lib", "payment.ts"), "utf-8");
const webhookSource = readFileSync(join(__dirname, "..", "src", "app", "api", "stripe", "webhook", "route.ts"), "utf-8");
const createOrderSource = readFileSync(join(__dirname, "..", "src", "lib", "createOrder.ts"), "utf-8");
const stripeLibSource = readFileSync(join(__dirname, "..", "src", "lib", "stripe.ts"), "utf-8");
const cartViewSource = readFileSync(join(__dirname, "..", "src", "components", "cart", "CartView.tsx"), "utf-8");
const paymentFormSource = readFileSync(join(__dirname, "..", "src", "components", "checkout", "PaymentForm.tsx"), "utf-8");

test("unauthenticated PaymentIntent request is rejected before any Stripe call", () => {
  const fnStart = paymentSource.indexOf("export async function createOrReusePaymentIntent");
  const fnBody = paymentSource.slice(fnStart, paymentSource.indexOf("\nexport ", fnStart + 1));
  assert.match(fnBody, /if \(!user\) \{\s*return \{ error: "Sign in to continue\." \};/);
});

test("a user cannot pay for another user's order — ownership is checked by id equality, no admin bypass", () => {
  const fnStart = paymentSource.indexOf("export async function createOrReusePaymentIntent");
  const fnBody = paymentSource.slice(fnStart, paymentSource.indexOf("\nexport ", fnStart + 1));
  assert.match(fnBody, /if \(order\.user_id !== user\.id\)/);
  assert.doesNotMatch(fnBody, /isCurrentUserAdmin/, "paying for an order must never have an admin bypass");
});

test("the client can never submit its own total — createOrReusePaymentIntent takes only an orderId, and the amount always comes from computeTrustedOrderAmount", () => {
  assert.match(paymentSource, /export async function createOrReusePaymentIntent\(orderId: string\)/);
  assert.match(paymentSource, /const amount = await computeTrustedOrderAmount\(supabase, orderId\)/);
});

test("an empty order (or one with nothing payable) is rejected, never charged $0", () => {
  assert.match(paymentSource, /if \(payableItems\.length === 0\) return null;/);
  assert.match(paymentSource, /if \(!amount \|\| amount\.amountTotalCents <= 0\)/);
});

test("items already failed_unavailable (an unavailable bundle/listing) are excluded from the charged amount", () => {
  assert.match(paymentSource, /payableItems = \(items \?\? \[\]\)\.filter\(\(item\) => item\.status !== "failed_unavailable"\)/);
});

test("a duplicate click reuses the existing PaymentIntent instead of creating a second one, and a genuine race is covered by an idempotency key", () => {
  assert.match(paymentSource, /if \(order\.stripe_payment_intent_id\)/);
  assert.match(paymentSource, /stripe\.paymentIntents\.retrieve\(order\.stripe_payment_intent_id\)/);
  assert.match(paymentSource, /idempotencyKey: `order-\$\{orderId\}-create-payment-intent`/);
});

test("missing Stripe configuration fails safely with a clear error, never a raw crash, and never prints the key", () => {
  assert.match(stripeLibSource, /export function requireStripeConfigured/);
  assert.match(stripeLibSource, /STRIPE_SECRET_KEY is not set/);
  assert.doesNotMatch(stripeLibSource, /console\.log\(.*apiKey/i);
  assert.match(paymentSource, /requireStripeConfigured\(\);/);
});

test("shipping information is validated server-side before an order (and therefore a PaymentIntent) can exist", () => {
  assert.match(createOrderSource, /function validateShippingAddress/);
  const createOrderFn = createOrderSource.slice(createOrderSource.indexOf("export async function createOrder("));
  assert.match(createOrderFn.slice(0, 400), /validateShippingAddress\(shippingAddress\)/);
});

test("a valid PaymentIntent is created with automatic payment methods (cards + Apple/Google Pay) and safe metadata", () => {
  assert.match(paymentSource, /automatic_payment_methods: \{ enabled: true \}/);
  assert.match(paymentSource, /metadata: \{ order_id: orderId, user_id: user\.id \}/);
});

test("payment failure is recorded with Stripe's own safe decline message, never marked paid", () => {
  const fnBody = webhookSource.slice(webhookSource.indexOf("async function handlePaymentIntentFailed"));
  assert.match(fnBody, /payment_status: "payment_failed"/);
  assert.match(fnBody, /payment_failure_code/);
  assert.match(fnBody, /payment_failure_message/);
  assert.doesNotMatch(fnBody, /payment_status: "paid"/);
});

test("a processing/3D-Secure-pending PaymentIntent is reflected as 'processing', not paid", () => {
  assert.match(webhookSource, /case "payment_intent\.processing":/);
  const fnBody = webhookSource.slice(webhookSource.indexOf("async function handlePaymentIntentProcessing"));
  assert.match(fnBody, /payment_status: "processing"/);
});

test("the webhook verifies Stripe's signature via constructEvent and rejects an invalid one with 400", () => {
  assert.match(webhookSource, /stripe\.webhooks\.constructEvent\(rawBody, signature, webhookSecret\)/);
  const catchBlock = webhookSource.slice(webhookSource.indexOf("} catch (error) {\n    console.error(\"[stripe-webhook] Signature"));
  assert.match(catchBlock.slice(0, 300), /status: 400/);
});

test("duplicate webhook delivery is a no-op — processed event ids are recorded and checked before any handler runs", () => {
  assert.match(webhookSource, /async function alreadyProcessed/);
  assert.match(webhookSource, /stripe_webhook_events[\s\S]*insert\(\{ id: event\.id, type: event\.type \}\)/);
  assert.match(webhookSource, /if \(await alreadyProcessed\(supabase, event\)\)/);
});

test("an amount mismatch between the PaymentIntent and the trusted order total is never marked paid", () => {
  const fnBody = webhookSource.slice(webhookSource.indexOf("async function handlePaymentIntentSucceeded"));
  assert.match(fnBody, /intent\.amount !== order\.amount_total_cents/);
  assert.match(fnBody.slice(fnBody.indexOf("intent.amount !=="), fnBody.indexOf("intent.amount !==") + 300), /return;/);
});

test("a currency mismatch is also never marked paid", () => {
  const fnBody = webhookSource.slice(webhookSource.indexOf("async function handlePaymentIntentSucceeded"));
  assert.match(fnBody, /intent\.currency !== order\.currency/);
});

test("external marketplace listings still link out to their own marketplace, never routed through Lockette's Stripe checkout", () => {
  assert.match(cartViewSource, /Buy on \{item\.platform/);
  assert.match(cartViewSource, /href=\{item\.productUrl\}/);
  assert.doesNotMatch(cartViewSource, /createOrReusePaymentIntent|stripe\./i);
});

test("an order that's already paid cannot be paid again", () => {
  assert.match(paymentSource, /PAID_STATUSES\.has\(order\.payment_status\)/);
  assert.match(paymentSource, /This order has already been paid\./);
});

test("a refund event (charge.refunded) updates the order truthfully", () => {
  assert.match(webhookSource, /case "charge\.refunded":/);
  const fnBody = webhookSource.slice(webhookSource.indexOf("async function handleChargeRefunded"));
  assert.match(fnBody, /payment_status: "refunded", refunded_at: new Date\(\)\.toISOString\(\)/);
});

test("no card data (number, expiry, CVC) is ever read, stored, or referenced as an actual field anywhere in the payment code", () => {
  // Prose comments are allowed to mention "CVC"/"card number" to explain
  // WHY this app never touches them (see the webhook route's own safety
  // comment) — what must never appear is an actual field/variable
  // reference like `cvc:`, `.cvc`, or `cardNumber`.
  for (const [name, source] of [
    ["payment.ts", paymentSource],
    ["webhook route.ts", webhookSource],
    ["PaymentForm.tsx", paymentFormSource],
  ] as const) {
    assert.doesNotMatch(source, /\bcard_?number\s*[:=]/i, `${name} must never assign/reference a raw card number field`);
    assert.doesNotMatch(source, /[.\s]cvc\s*[:=]/i, `${name} must never assign/reference a CVC field`);
  }
  // PaymentForm renders Stripe's own hosted iframe element — card entry
  // never touches a plain <input> this app controls.
  assert.match(paymentFormSource, /<PaymentElement \/>/);
  assert.doesNotMatch(paymentFormSource, /<input/);
});

test("PaymentIntent creation never blindly trusts Stripe response — only the webhook writes payment_status: \"paid\"", () => {
  assert.doesNotMatch(paymentSource, /payment_status: "paid"/, "src/lib/payment.ts must never itself mark an order paid");
  assert.match(webhookSource, /payment_status: "paid"/);
});
