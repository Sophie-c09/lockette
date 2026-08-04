"use client";

// P0 launch-readiness fix — no route-level error.tsx existed anywhere in
// the app before this. Next.js's App Router requires error.tsx to be a
// Client Component, and it only catches errors thrown while RENDERING a
// page/layout below the root layout (a server component's own uncaught
// query failure, a client component render throwing, etc.) — it does NOT
// catch errors in the root layout itself (see global-error.tsx for that)
// or inside event handlers/effects that already catch their own errors.
// Without this, an uncaught render error anywhere (e.g. Home or Profile,
// both confirmed during this audit to have no try/catch around their own
// Supabase queries) fell through to Next's bare-minimum default — no
// "try again," no on-brand messaging.
import { useEffect } from "react";
import { Button, LinkButton } from "@/components/ui/Button";

export default function ErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Server-side detail only — never rendered to the visitor below.
    console.error("[app-error-boundary]", error);
  }, [error]);

  return (
    <div className="flex min-h-[calc(100vh-137px)] flex-col items-center justify-center gap-4 px-6 text-center">
      <p className="font-display text-lg font-semibold text-ink">Something went wrong</p>
      <p className="max-w-sm text-sm text-ink-soft">
        This page ran into a problem loading. It&apos;s not you — try again, or head back to Discover.
      </p>
      <div className="mt-2 flex gap-3">
        <Button variant="primary" onClick={reset}>
          Try again
        </Button>
        <LinkButton href="/discover" variant="secondary">
          Go to Discover
        </LinkButton>
      </div>
    </div>
  );
}
