"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { logAuthError } from "@/lib/auth-diagnostics";

const SignUpSchema = z.object({
  name: z
    .string()
    .trim()
    .min(2, { error: "Name must be at least 2 characters." }),
  email: z.email({ error: "Enter a valid email address." }).trim(),
  password: z
    .string()
    .min(8, { error: "Password must be at least 8 characters." }),
});

const SignInSchema = z.object({
  email: z.email({ error: "Enter a valid email address." }).trim(),
  password: z.string().min(1, { error: "Enter your password." }),
});

const ForgotPasswordSchema = z.object({
  email: z.email({ error: "Enter a valid email address." }).trim(),
});

const ResetPasswordSchema = z
  .object({
    password: z
      .string()
      .min(8, { error: "Password must be at least 8 characters." }),
    confirmPassword: z.string(),
  })
  .refine((fields) => fields.password === fields.confirmPassword, {
    error: "Passwords don't match.",
    path: ["confirmPassword"],
  });

// Where a Supabase Auth email's action link redirects back to — must be
// added to this project's Authentication -> URL Configuration -> Redirect
// URLs allow-list in the Supabase dashboard, or GoTrue rejects the link
// entirely. Hardcoded to the real production domain rather than anything
// derived from the incoming request (e.g. the Host header) so a
// password-reset email can never be crafted to point somewhere else —
// only overridable via an explicit env var, for local development against
// a real Supabase project.
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://lockette.org";

export type AuthFormState =
  | {
      errors?: {
        name?: string[];
        email?: string[];
        password?: string[];
        confirmPassword?: string[];
      };
      message?: string;
    }
  | undefined;

export async function signUp(
  _prevState: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const validatedFields = SignUpSchema.safeParse({
    name: formData.get("name"),
    email: formData.get("email"),
    password: formData.get("password"),
  });

  if (!validatedFields.success) {
    return { errors: validatedFields.error.flatten().fieldErrors };
  }

  const { name, email, password } = validatedFields.data;
  const supabase = await createClient();

  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      data: { full_name: name },
      // P0 first-60-seconds fix (item 3) — without this, the confirmation
      // email uses whatever this Supabase project's dashboard "Site URL"
      // is set to, landing wherever that happens to be (often the
      // homepage) instead of a page that actually tells the user to sign
      // in. Routes through /auth/confirm (the same Route Handler
      // requestPasswordReset already uses) so a real, server-verifiable
      // token_hash/code lands on /login?verified=true; error_next keeps a
      // failed/expired confirmation link off the unrelated
      // /forgot-password page.
      emailRedirectTo: `${SITE_URL}/auth/confirm?next=${encodeURIComponent("/login?verified=true")}&error_next=${encodeURIComponent("/login")}`,
    },
  });

  if (error) {
    // Full server-side log (code/status/message) — see signIn's own
    // comment on why this is never shown to the user verbatim, but must
    // never be silently dropped either.
    logAuthError("signUp", error, { email });
    return { message: error.message };
  }

  // No session means this Supabase project requires email confirmation
  // before a user can sign in (Authentication -> Email -> "Confirm email"
  // in the dashboard) — the account was genuinely created (data.user is
  // set), it just isn't usable yet. Redirecting straight to /profile/setup
  // here used to silently bounce back to /login (proxy.ts's protected-
  // route check has no session to find), which is exactly what made a
  // brand-new account look like it "couldn't log in" with zero
  // explanation — the same root cause as signIn's own email_not_confirmed
  // handling below.
  if (!data.session) {
    return { message: "Account created — check your email to confirm it, then sign in." };
  }

  redirect("/profile/setup");
}

// Only ever a same-origin relative path (proxy.ts only ever sets it from
// request.nextUrl.pathname) — but it arrives as a plain query/form param,
// so it must be validated before ever being used as a redirect target.
// Rejects anything absolute ("https://...") or protocol-relative ("//...")
// to prevent an open-redirect via a crafted /login?redirectTo= link.
function safeRedirectTarget(candidate: FormDataEntryValue | null): string {
  if (typeof candidate !== "string" || !candidate.startsWith("/") || candidate.startsWith("//")) {
    return "/profile";
  }
  return candidate;
}

export async function signIn(
  _prevState: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const validatedFields = SignInSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });

  if (!validatedFields.success) {
    return { errors: validatedFields.error.flatten().fieldErrors };
  }

  const { email, password } = validatedFields.data;
  const supabase = await createClient();

  const { error } = await supabase.auth.signInWithPassword({
    email,
    password,
  });

  if (error) {
    // Full server-side log of the REAL Supabase Auth error — the only
    // place it's ever visible.
    logAuthError("signInWithPassword", error, { email });

    // email_not_confirmed is safe to surface distinctly — it doesn't
    // reveal whether the password was right, and staying silent about it
    // is exactly what left a legitimately-signed-up user stuck with no
    // way to know why login kept "failing" (see signUp's own comment on
    // the same underlying requirement: email confirmation is required by
    // this Supabase project, and this app never told anyone).
    if (error.code === "email_not_confirmed") {
      return { message: "Please confirm your email before signing in — check your inbox for a confirmation link." };
    }

    // invalid_credentials is the genuine "wrong email or password" case —
    // handled explicitly (not as a catch-all) so it's never confused with
    // the case below.
    if (error.code === "invalid_credentials") {
      return { message: "Incorrect email or password." };
    }

    // Anything else (rate limiting, a genuine backend/network failure,
    // etc.) is a different problem — telling the user their password was
    // wrong when it might not even have been checked yet would be
    // actively misleading, not just imprecise. This used to be the
    // catch-all fallback for every error code, which is exactly what made
    // an unrelated failure look identical to a wrong password.
    return { message: "Something went wrong signing you in. Please try again." };
  }

  redirect(safeRedirectTarget(formData.get("redirectTo")));
}

// P0 first-60-seconds fix (item 2) — "Continue with Google," first option
// on both /login and /signup. Supabase Auth's signInWithOAuth (server-
// side call) returns a real provider consent URL rather than performing
// the redirect itself — this Server Action's only job is to get that URL
// and hand off to it. Works identically for a brand-new email (creates
// the account) and a returning one (signs in) — Supabase Auth doesn't
// need this app to know which case it is ahead of time.
//
// Existing-email-account merging: if "Enable automatic linking" is on for
// this Supabase project (Authentication -> Sign In / Providers), a Google
// sign-in that matches an existing email/password account's email links
// to that SAME user automatically — no separate, duplicate account. That
// setting lives in the Supabase dashboard, not in this codebase; nothing
// here can enable it remotely. If it's off, Supabase's default behavior
// is to still create/sign in a distinct identity, which is why this is
// called out explicitly rather than silently assumed.
//
// redirectTo routes through /auth/confirm (the same Route Handler
// requestPasswordReset/signUp's email confirmation already use) — it
// already handles a PKCE `code` via exchangeCodeForSession; `next=/profile`
// matches signIn's own post-login landing above, so a first-time Google
// user is naturally forwarded to /profile/setup by that page's own
// existing incomplete-profile check, same as a first-time email signup
// reaching /profile/setup via signUp above.
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- required by useActionState's calling convention (GoogleSignInButton.tsx), unused since this action needs no form fields
export async function signInWithGoogle(_prevState: AuthFormState): Promise<AuthFormState> {
  const supabase = await createClient();

  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: {
      redirectTo: `${SITE_URL}/auth/confirm?next=${encodeURIComponent("/profile")}&error_next=${encodeURIComponent("/login")}`,
    },
  });

  if (error || !data.url) {
    // Graceful failure state (requirement) — never a raw Supabase error,
    // and never a silent no-op either (the button would otherwise appear
    // to do nothing at all).
    logAuthError("signInWithOAuth", error ?? new Error("No redirect URL returned"));
    return { message: "Couldn't connect to Google right now. Please try again, or sign in with email." };
  }

  redirect(data.url);
}

// Sign in with Apple — App Store compliance requirement, same safe
// architecture as signInWithGoogle above (a Server Action that only ever
// hands off to Supabase's own hosted OAuth consent flow; Lockette's code
// never sees an Apple client secret or token — that exchange happens
// entirely inside Supabase Auth, configured once in its dashboard, see
// this feature's own setup docs). Works identically for a brand-new
// Apple ID (creates the account) and a returning one (signs in) — same
// as Google, Supabase doesn't need this app to know which case it is
// ahead of time.
//
// redirectTo — unlike signInWithGoogle (which has never needed one),
// this accepts and validates an optional redirectTo via the SAME
// safeRedirectTarget guard signIn (email/password) already uses, so a
// user bounced to /login?redirectTo=/likes by proxy.ts and choosing
// "Continue with Apple" still lands back on /likes, not always /profile.
// Reuses /auth/confirm (the same Route Handler Google/email-confirmation/
// password-reset already share) — that route's exchangeCodeForSession
// call is provider-agnostic, so no second callback path is needed.
//
// Apple-specific notes (see this feature's own report for the full
// account-behavior/linking documentation):
// - Apple only ever includes the user's name in the FIRST authorization
//   response, and only if requested — Supabase Auth captures whatever
//   Apple sends into user_metadata at that moment; this app's own
//   on_auth_user_created trigger (supabase/schema.sql) never copies any
//   provider's name into profiles.display_name at all (Google included),
//   so there's no name-overwrite risk here to begin with — a first-time
//   Apple user reaches /profile/setup and enters their name manually,
//   identically to Google/email signup.
// - Apple private-relay email addresses (@privaterelay.appleid.com) are
//   handled with no special casing needed — Supabase Auth treats them as
//   an ordinary email address on the account; nothing in this app reads
//   or validates email domains at sign-in time.
// - Existing-email-account merging: identical caveat as signInWithGoogle
//   above — governed entirely by this Supabase project's own
//   "Authentication -> Sign In / Providers -> Enable automatic linking"
//   setting, not by anything in this codebase.
export async function signInWithApple(_prevState: AuthFormState, formData: FormData): Promise<AuthFormState> {
  const supabase = await createClient();
  const redirectTo = safeRedirectTarget(formData.get("redirectTo"));

  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "apple",
    options: {
      redirectTo: `${SITE_URL}/auth/confirm?next=${encodeURIComponent(redirectTo)}&error_next=${encodeURIComponent("/login")}`,
    },
  });

  if (error || !data.url) {
    // Graceful failure state (requirement) — never a raw Supabase error,
    // and never a silent no-op either (the button would otherwise appear
    // to do nothing at all).
    logAuthError("signInWithOAuth:apple", error ?? new Error("No redirect URL returned"));
    return { message: "Couldn't connect to Apple right now. Please try again, or sign in with email." };
  }

  redirect(data.url);
}

export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/");
}

// /forgot-password's form action — sends a Supabase Auth recovery email.
// redirectTo points at /auth/confirm (a Route Handler, added alongside
// this), which verifies the email's token_hash and forwards the user to
// /reset-password with a real session already established (see that
// route's own comment for why token_hash/verifyOtp rather than the
// implicit-flow hash-fragment style link).
export async function requestPasswordReset(
  _prevState: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const validatedFields = ForgotPasswordSchema.safeParse({
    email: formData.get("email"),
  });

  if (!validatedFields.success) {
    return { errors: validatedFields.error.flatten().fieldErrors };
  }

  const { email } = validatedFields.data;
  const supabase = await createClient();
  const redirectTo = `${SITE_URL}/auth/confirm?next=/reset-password`;

  const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo });

  if (error) {
    logAuthError("resetPasswordForEmail", error, { email, redirectTo });

    // Confirmed live against this project: over_email_send_rate_limit
    // (429) is a real, distinct case from a mail-provider/SMTP failure
    // (observed live as a raw 500 with no specific code — see this
    // file's own investigation notes) — each needs its own message
    // rather than one blanket "something went wrong," since only the
    // rate-limit case is something the user can fix by waiting.
    if (error.code === "over_email_send_rate_limit") {
      return { message: "Too many reset attempts. Please wait a few minutes and try again." };
    }

    // Every other failure here (the observed 500/SMTP case, or anything
    // else) is a real send failure, not a "try rewording your email"
    // problem — this still can't reveal WHOSE email failed to avoid
    // account enumeration, but it must not pretend the email is on its
    // way when it genuinely is not.
    return { message: "We couldn't send that email right now. Please try again in a few minutes." };
  }

  // GoTrue itself already returns success here regardless of whether the
  // email address actually has an account — a deliberate, built-in
  // anti-enumeration behavior, not something this app adds — so this
  // message is always safe and always the same, never revealing whether
  // the account exists.
  return { message: "If an account exists for that email, a password reset link is on its way." };
}

// /reset-password's form action — the user only reaches this page with an
// active (recovery) session already established by /auth/confirm, so
// updateUser can set the new password directly; no old password or extra
// re-auth step is needed (this IS the re-auth step, via the emailed link).
export async function updatePassword(
  _prevState: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const validatedFields = ResetPasswordSchema.safeParse({
    password: formData.get("password"),
    confirmPassword: formData.get("confirmPassword"),
  });

  if (!validatedFields.success) {
    return { errors: validatedFields.error.flatten().fieldErrors };
  }

  const { password } = validatedFields.data;
  const supabase = await createClient();

  // Confirms a recovery session genuinely exists before attempting the
  // update — updateUser would otherwise fail with a generic "Auth session
  // missing" error for a stale/reused/invalid link, which this turns into
  // an actionable message instead.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { message: "This password reset link has expired or already been used. Request a new one." };
  }

  const { error } = await supabase.auth.updateUser({ password });

  if (error) {
    logAuthError("updateUser", error, { email: user.email });

    // weak_password/same_password are Supabase's own password-policy
    // checks (on top of this form's own 8-char minimum) — genuinely safe
    // and helpful to show verbatim-ish, unlike a raw internal error
    // string, which is what every other code fell back to before this.
    if (error.code === "weak_password") {
      return { message: "That password is too weak. Try a longer or more complex one." };
    }
    if (error.code === "same_password") {
      return { message: "That's your current password. Choose a different one." };
    }

    return { message: "Something went wrong updating your password. Please try again." };
  }

  // Signs out the recovery session rather than leaving it active — the
  // task's own spec requires logging in fresh with the new password
  // afterward, and not leaving a password-reset link's session
  // indefinitely active on whatever device opened the email is the safer
  // default regardless.
  await supabase.auth.signOut();
  redirect("/login?reset=success");
}
