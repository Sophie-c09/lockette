import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Sign in with Apple — App Store compliance requirement. Source-level
// assertions, same convention as tests/payment-system.test.ts/
// tests/account-deletion.test.ts: signInWithApple needs a real Supabase
// OAuth round trip to exercise end-to-end, which this project's unit
// suite deliberately avoids depending on.
const authSource = readFileSync(join(__dirname, "..", "src", "app", "actions", "auth.ts"), "utf-8");
const appleButtonSource = readFileSync(join(__dirname, "..", "src", "components", "auth", "AppleSignInButton.tsx"), "utf-8");
const googleButtonSource = readFileSync(join(__dirname, "..", "src", "components", "auth", "GoogleSignInButton.tsx"), "utf-8");
const loginFormSource = readFileSync(join(__dirname, "..", "src", "components", "auth", "LoginForm.tsx"), "utf-8");
const signUpFormSource = readFileSync(join(__dirname, "..", "src", "components", "auth", "SignUpForm.tsx"), "utf-8");
const schemaSource = readFileSync(join(__dirname, "..", "supabase", "schema.sql"), "utf-8");
const profileViewSource = readFileSync(join(__dirname, "..", "src", "components", "profile", "ProfileView.tsx"), "utf-8");

test("the Apple button is rendered on the login form", () => {
  assert.match(loginFormSource, /import \{ AppleSignInButton \} from "@\/components\/auth\/AppleSignInButton";/);
  assert.match(loginFormSource, /<AppleSignInButton redirectTo=\{redirectTo\} \/>/);
});

test("the Apple button is rendered on the signup form", () => {
  assert.match(signUpFormSource, /import \{ AppleSignInButton \} from "@\/components\/auth\/AppleSignInButton";/);
  assert.match(signUpFormSource, /<AppleSignInButton redirectTo=\{redirectTo\} \/>/);
});

test("Apple appears before Google on both the login and signup forms", () => {
  for (const [name, source] of [
    ["LoginForm", loginFormSource],
    ["SignUpForm", signUpFormSource],
  ] as const) {
    const appleIndex = source.indexOf("<AppleSignInButton");
    const googleIndex = source.indexOf("<GoogleSignInButton");
    assert.ok(appleIndex > -1 && googleIndex > -1, `expected both buttons present in ${name}`);
    assert.ok(appleIndex < googleIndex, `expected Apple before Google in ${name}`);
  }
});

test("signInWithApple uses Supabase OAuth with provider \"apple\"", () => {
  const fnBody = authSource.slice(
    authSource.indexOf("export async function signInWithApple"),
    authSource.indexOf("export async function signOut"),
  );
  assert.match(fnBody.slice(0, 500), /signInWithOAuth\(\{\s*provider: "apple",/);
});

test("a valid redirectTo is validated and preserved via the shared safeRedirectTarget guard", () => {
  const fnBody = authSource.slice(
    authSource.indexOf("export async function signInWithApple"),
    authSource.indexOf("export async function signOut"),
  );
  assert.match(fnBody.slice(0, 400), /const redirectTo = safeRedirectTarget\(formData\.get\("redirectTo"\)\);/);
});

test("an external/absolute redirectTo is rejected — safeRedirectTarget only accepts a same-origin relative path", () => {
  assert.match(authSource, /function safeRedirectTarget\(candidate: FormDataEntryValue \| null\): string \{/);
  const fnBody = authSource.slice(authSource.indexOf("function safeRedirectTarget"));
  assert.match(fnBody.slice(0, 300), /!candidate\.startsWith\("\/"\) \|\| candidate\.startsWith\("\/\/"\)/);
  // Both signIn (email/password) and signInWithApple route their
  // redirectTo through this exact same function — one guard, not two
  // diverging implementations.
  assert.match(authSource, /redirect\(safeRedirectTarget\(formData\.get\("redirectTo"\)\)\)/);
});

test("a failed Apple login redirects back to /login, never to the password-reset page", () => {
  const fnBody = authSource.slice(
    authSource.indexOf("export async function signInWithApple"),
    authSource.indexOf("export async function signOut"),
  );
  assert.match(fnBody, /error_next=\$\{encodeURIComponent\("\/login"\)\}/);
  assert.doesNotMatch(fnBody, /forgot-password|reset-password/);
});

test("Apple sign-in never requires a password — the action takes no password field and never calls signInWithPassword", () => {
  const fnBody = authSource.slice(
    authSource.indexOf("export async function signInWithApple"),
    authSource.indexOf("export async function signOut"),
  );
  assert.doesNotMatch(fnBody, /password/i);
  assert.doesNotMatch(fnBody, /signInWithPassword/);
});

test("a missing Apple profile name is handled safely — the new-user trigger never writes a provider-supplied name, so there's nothing to null out or overwrite", () => {
  const triggerBody = schemaSource.slice(
    schemaSource.indexOf("create or replace function public.handle_new_user"),
    schemaSource.indexOf("$$;", schemaSource.indexOf("create or replace function public.handle_new_user")),
  );
  assert.match(triggerBody, /values \(new\.id, null, null, null, null\)/);
  assert.doesNotMatch(triggerBody, /raw_user_meta_data|full_name/);
});

test("account deletion remains reachable from Profile after adding Apple sign-in", () => {
  assert.match(profileViewSource, /import \{ DeleteAccountSection \} from "@\/components\/profile\/DeleteAccountSection";/);
  assert.match(profileViewSource, /<DeleteAccountSection \/>/);
});

test("Google sign-in is unchanged — still provider \"google\", still no redirectTo handling, still its own button component", () => {
  const fnBody = authSource.slice(
    authSource.indexOf("export async function signInWithGoogle"),
    authSource.indexOf("export async function signOut"),
  );
  assert.match(fnBody, /signInWithOAuth\(\{\s*provider: "google",/);
  assert.match(googleButtonSource, /export function GoogleSignInButton\(\)/);
});

test("email/password authentication (signIn/signUp) is unchanged", () => {
  assert.match(authSource, /export async function signIn\(/);
  assert.match(authSource, /export async function signUp\(/);
  assert.match(authSource, /supabase\.auth\.signInWithPassword\(/);
  assert.match(authSource, /supabase\.auth\.signUp\(/);
});

test("the Apple button has an accessible label, a submitting state, and disables itself while pending (preventing double clicks)", () => {
  assert.match(appleButtonSource, /aria-label="Continue with Apple"/);
  assert.match(appleButtonSource, /disabled=\{pending\}/);
  assert.match(appleButtonSource, /\{pending \? "Connecting…" : "Continue with Apple"\}/);
});
