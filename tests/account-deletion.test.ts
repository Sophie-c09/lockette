import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// In-app account deletion (App Store submission requirement). Source-level
// assertions, same convention as tests/payment-system.test.ts — deleteAccount
// needs a real Supabase session/service-role client to exercise end-to-end,
// which this project's unit suite deliberately avoids depending on.
const actionSource = readFileSync(join(__dirname, "..", "src", "app", "actions", "account-deletion.ts"), "utf-8");
const sectionSource = readFileSync(join(__dirname, "..", "src", "components", "profile", "DeleteAccountSection.tsx"), "utf-8");
const adminClientSource = readFileSync(join(__dirname, "..", "src", "lib", "supabase", "admin.ts"), "utf-8");

test("deleteAccount only ever operates server-side — 'use server' directive, never a client-callable file", () => {
  assert.match(actionSource, /^"use server";/);
});

test("an unauthenticated attempt is rejected before any deletion step runs", () => {
  const fnBody = actionSource.slice(actionSource.indexOf("export async function deleteAccount"));
  assert.match(fnBody.slice(0, 600), /if \(!user\) \{\s*return \{ success: false, error: "You must be signed in/);
});

test("a user can only ever delete their OWN account — the function takes no user id parameter at all, only a confirmation string", () => {
  assert.match(actionSource, /export async function deleteAccount\(confirmation: string\): Promise<DeleteAccountResult>/);
  assert.doesNotMatch(actionSource, /deleteAccount\([^)]*userId/, "deleteAccount must never accept a caller-supplied user id");
  assert.match(actionSource, /const userId = user\.id;/, "the id acted on must come from the authenticated session, not a parameter");
});

test("deletion works identically for email/password and Google-authenticated users — no password re-entry or provider check anywhere", () => {
  // The header comment explains (in prose) why this is safe for a
  // password-less Google user — what must never exist is actual code
  // that re-checks a password or branches on auth provider.
  assert.match(actionSource, /export async function deleteAccount\(confirmation: string\)/, "must take no password parameter");
  assert.doesNotMatch(actionSource, /signInWithPassword|verifyPassword|currentPassword|app_metadata\.provider/i);
});

test("deliberate confirmation is required — the exact phrase DELETE, checked before anything else runs", () => {
  const fnBody = actionSource.slice(actionSource.indexOf("export async function deleteAccount"));
  assert.match(fnBody.slice(0, 300), /if \(confirmation !== "DELETE"\)/);
});

test("the confirmation UI disables the delete button until the user has typed DELETE, and prevents double-submit", () => {
  assert.match(sectionSource, /const canConfirm = confirmationText === CONFIRMATION_PHRASE && !deleting;/);
  assert.match(sectionSource, /if \(!canConfirm\) return;/);
  assert.match(sectionSource, /disabled=\{!canConfirm\}/);
});

test("likes/preferences/requests/notifications are deleted via the Auth user cascade, not left behind", () => {
  assert.match(actionSource, /cascades profiles and everything that references it/);
  assert.match(actionSource, /admin\.auth\.admin\.deleteUser\(userId\)/);
});

test("uploaded files are deleted from every user-owned private storage bucket", () => {
  assert.match(actionSource, /const USER_STORAGE_BUCKETS = \[/);
  for (const bucket of ["avatars", "style-request-images", "outfit-photos", "style-me-images", "discover-search-photos"]) {
    assert.match(actionSource, new RegExp(`"${bucket}"`));
  }
  assert.match(actionSource, /await deleteAllUnderPrefix\(admin, bucket, userId, correlationId\);/);
});

test("storage paths are derived from the trusted session user id, never anything client-supplied, and never touch another user's prefix", () => {
  const fnBody = actionSource.slice(actionSource.indexOf("async function deleteAllUnderPrefix"));
  // The only caller passes `userId` (from the authenticated session) as
  // the starting prefix — recursion only ever appends onto that same
  // trusted root, never re-derives a prefix from anything else.
  assert.match(actionSource, /deleteAllUnderPrefix\(admin, bucket, userId, correlationId\)/);
  assert.match(fnBody.slice(0, 800), /`\$\{prefix\}\/\$\{entry\.name\}`/);
});

test("unpaid/never-charged orders are deleted outright", () => {
  assert.match(actionSource, /deletableOrderIds = \(orders \?\? \[\]\)\s*\.filter\(\(order\) => !RETAINED_PAYMENT_STATUSES\.has/);
  assert.match(actionSource, /admin\.from\("orders"\)\.delete\(\)\.in\("id", deletableOrderIds\)/);
});

test("paid/refunded orders are retained and anonymized (user_id nulled), never deleted", () => {
  assert.match(actionSource, /const RETAINED_PAYMENT_STATUSES = new Set\(\["authorized", "captured", "paid", "refunded"\]\)/);
  assert.match(actionSource, /retainedOrderIds = \(orders \?\? \[\]\)\s*\.filter\(\(order\) => RETAINED_PAYMENT_STATUSES\.has/);
  assert.match(actionSource, /admin\.from\("orders"\)\.update\(\{ user_id: null \}\)\.in\("id", retainedOrderIds\)/);
});

test("no Stripe Customer object is created or referenced — nothing to delete/detach on account deletion", () => {
  // The file's own header comment documents (in prose) WHY there's
  // nothing Stripe-side to clean up — what must never appear is an
  // actual Stripe API call.
  assert.doesNotMatch(actionSource, /stripe\.\w/);
  assert.match(actionSource, /No Stripe Customer objects exist anywhere in this app/);
});

test("a non-critical storage failure (already-missing file/folder) is logged and does not stop the rest of deletion", () => {
  const fnBody = actionSource.slice(actionSource.indexOf("async function deleteAllUnderPrefix"), actionSource.indexOf("async function deleteAllUnderPrefix") + 1200);
  assert.match(fnBody, /console\.error\(`\[account-deletion:\$\{correlationId\}\] Failed to list/);
  // A list() error just returns from this one call — it must NOT throw,
  // which would otherwise abort the whole deleteAccount try block over a
  // single missing/already-empty bucket prefix.
  assert.match(fnBody, /if \(error\) \{\s*console\.error[\s\S]*?return;\s*\}/);
});

test("a critical failure never falsely reports success — every step returns a structured, non-throwing result", () => {
  const fnBody = actionSource.slice(actionSource.indexOf("export async function deleteAccount"));
  assert.match(fnBody, /catch \(error\) \{\s*console\.error\(`\[account-deletion/);
  assert.match(fnBody, /return \{ success: false, error: "Something went wrong\. Please try again\."/);
});

test("a repeated deletion attempt (auth user already gone) is treated as success, not an error", () => {
  assert.match(actionSource, /if \(deleteUserError && !\/not\.\*found\/i\.test\(deleteUserError\.message\)\)/);
});

test("the Auth user is deleted LAST — after orders are classified/anonymized/deleted and after storage cleanup", () => {
  const ordersIndex = actionSource.indexOf('await admin\n      .from("orders")\n      .select("id, payment_status")');
  const storageIndex = actionSource.indexOf("for (const bucket of USER_STORAGE_BUCKETS)");
  const deleteUserIndex = actionSource.indexOf("admin.auth.admin.deleteUser(userId)");

  assert.ok(ordersIndex > -1 && storageIndex > -1 && deleteUserIndex > -1, "expected to find all three steps in deleteAccount");
  assert.ok(ordersIndex < storageIndex, "orders must be classified/handled before storage cleanup");
  assert.ok(storageIndex < deleteUserIndex, "storage cleanup must finish before the Auth user is deleted");
});

test("the session is invalidated after a successful deletion", () => {
  const deleteUserIndex = actionSource.indexOf("admin.auth.admin.deleteUser(userId)");
  const signOutIndex = actionSource.indexOf("await supabase.auth.signOut();");
  assert.ok(signOutIndex > deleteUserIndex, "signOut must happen after the Auth user is deleted");
});

test("no service-role key is exposed to the client — createAdminClient requires SUPABASE_SERVICE_ROLE_KEY (never NEXT_PUBLIC_) and is only ever called from this server-only action", () => {
  assert.match(adminClientSource, /SUPABASE_SERVICE_ROLE_KEY/);
  assert.doesNotMatch(adminClientSource, /NEXT_PUBLIC_SUPABASE_SERVICE/);
  assert.match(actionSource, /import \{ createAdminClient \} from "@\/lib\/supabase\/admin";/);
  // DeleteAccountSection.tsx (the client component) never imports the
  // admin client or the service-role env var directly — only the server
  // action itself does.
  assert.doesNotMatch(sectionSource, /createAdminClient|SUPABASE_SERVICE_ROLE_KEY/);
});
