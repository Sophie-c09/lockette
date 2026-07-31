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

export type AuthFormState =
  | {
      errors?: {
        name?: string[];
        email?: string[];
        password?: string[];
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
