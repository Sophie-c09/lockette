// Safe, structured server-side logging for Supabase Auth operations — the
// ONLY place a real Supabase Auth error (code/status/message) is ever
// visible; every user-facing message returned by src/app/actions/auth.ts
// stays deliberately generic/curated (see each action's own comment on
// why). Used by signInWithPassword, resetPasswordForEmail, verifyOtp
// (src/app/auth/confirm/route.ts), and updateUser — the four operations
// this task's own spec calls out.
//
// Logs ONLY: operation name, masked email, the Supabase project's
// hostname (not the full URL/key), the redirectTo value (when relevant —
// itself not a secret, just a URL), and the error's own code/status/
// message. NEVER logs passwords, API keys, tokens, cookies, or any other
// secret — none of those are ever passed into this function in the first
// place, so there's nothing to accidentally leak here.
interface AuthErrorLike {
  code?: string | null;
  status?: number | null;
  message: string;
}

function maskEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const [local, domain] = email.split("@");
  if (!domain) return "***";
  return `${local.slice(0, 2)}***@${domain}`;
}

function projectHostname(): string | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!url) return null;
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

export function logAuthError(
  operation: string,
  error: AuthErrorLike,
  context: { email?: string | null; redirectTo?: string | null } = {},
): void {
  console.error("[auth]", {
    operation,
    code: error.code ?? null,
    status: error.status ?? null,
    message: error.message,
    email: maskEmail(context.email),
    projectHostname: projectHostname(),
    redirectTo: context.redirectTo ?? null,
  });
}
