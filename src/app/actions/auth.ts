"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";

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
    options: { data: { full_name: name } },
  });

  if (error) {
    // Full server-side log (code/status/message) — see signIn's own
    // comment on why this is never shown to the user verbatim, but must
    // never be silently dropped either.
    console.error("[auth] signUp failed:", { code: error.code ?? null, status: error.status ?? null, message: error.message });
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
    // place it's ever visible. The generic client-facing message below
    // (for every code except email_not_confirmed) is a deliberate security
    // choice: never let a login failure reveal "no such user" vs "wrong
    // password" vs anything else, which would be a user-enumeration leak.
    console.error("[auth] signInWithPassword failed:", { code: error.code ?? null, status: error.status ?? null, message: error.message });

    // email_not_confirmed is the one code safe to surface distinctly — it
    // doesn't reveal whether the password was right, and staying silent
    // about it is exactly what left a legitimately-signed-up user stuck
    // with no way to know why login kept "failing" (see signUp's own
    // comment on the same underlying requirement: email confirmation is
    // required by this Supabase project, and this app never told anyone).
    if (error.code === "email_not_confirmed") {
      return { message: "Please confirm your email before signing in — check your inbox for a confirmation link." };
    }

    return { message: "Incorrect email or password." };
  }

  redirect("/profile");
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

  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: `${SITE_URL}/auth/confirm?next=/reset-password`,
  });

  if (error) {
    console.error("[auth] resetPasswordForEmail failed:", { code: error.code ?? null, status: error.status ?? null, message: error.message });
    return { message: "Something went wrong sending that email. Please try again." };
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
    console.error("[auth] updateUser (password) failed:", { code: error.code ?? null, status: error.status ?? null, message: error.message });
    return { message: error.message };
  }

  // Signs out the recovery session rather than leaving it active — the
  // task's own spec requires logging in fresh with the new password
  // afterward, and not leaving a password-reset link's session
  // indefinitely active on whatever device opened the email is the safer
  // default regardless.
  await supabase.auth.signOut();
  redirect("/login?reset=success");
}
