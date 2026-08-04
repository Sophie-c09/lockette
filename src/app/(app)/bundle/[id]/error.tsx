"use client";

// Bundle-result-page-specific error boundary — before this, any render
// error on /bundle/[id] fell through to the generic root error.tsx
// ("head back to Discover"), which is a strange landing spot for someone
// who was just looking at a finished bundle. This mirrors that same
// boundary's contract (Client Component, error+reset props, never render
// the raw error) but points recovery at this page's own actual escape
// hatches instead — reloading this exact bundle, or the list it came from.
import { useEffect } from "react";
import { Sparkles } from "lucide-react";
import { Button, LinkButton } from "@/components/ui/Button";

export default function BundleError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Server-side detail only — never rendered to the visitor below.
    console.error("[bundle-error-boundary]", error);
  }, [error]);

  return (
    <div className="flex min-h-[calc(100vh-137px)] items-center justify-center px-6">
      <div className="mx-auto flex max-w-md flex-col items-center gap-4 rounded-card bg-highlight-cream px-8 py-16 text-center">
        <Sparkles className="h-8 w-8 text-oxblood" strokeWidth={1.5} />
        <p className="font-display text-lg font-semibold text-ink">This bundle couldn&apos;t be displayed</p>
        <p className="text-sm text-ink-soft">
          It&apos;s not you — try again, or come back to it from your style requests.
        </p>
        <div className="mt-2 flex flex-wrap justify-center gap-3">
          <Button variant="primary" onClick={reset}>
            Try again
          </Button>
          <LinkButton href="/my-style-requests" variant="secondary">
            My style requests
          </LinkButton>
        </div>
      </div>
    </div>
  );
}
