"use client";

// P0 launch-readiness fix — the sibling to error.tsx (see that file's own
// comment). global-error.tsx is Next.js's dedicated catch for an error
// thrown in the ROOT layout itself (src/app/layout.tsx) — CartProvider,
// ToastProvider, Nav, or the layout's own JSX throwing. Because it REPLACES
// the root layout entirely when active, it must render its own <html>/
// <body> and deliberately does NOT depend on this app's normal providers,
// fonts, or globals.css — whatever crashed the root layout could be
// exactly one of those, so this stays plain inline styles only, the one
// place in the app where that's the right call rather than a shortcut.
import { useEffect } from "react";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[global-error-boundary]", error);
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          display: "flex",
          minHeight: "100vh",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: "1rem",
          padding: "1.5rem",
          textAlign: "center",
          fontFamily: "system-ui, sans-serif",
        }}
      >
        <p style={{ fontSize: "1.125rem", fontWeight: 600 }}>Something went wrong</p>
        <p style={{ maxWidth: "24rem", fontSize: "0.875rem", color: "#555" }}>
          Lockette ran into a problem loading. Try again, or come back in a moment.
        </p>
        <button
          type="button"
          onClick={reset}
          style={{
            marginTop: "0.5rem",
            cursor: "pointer",
            borderRadius: "999px",
            border: "none",
            background: "#111",
            color: "#fff",
            padding: "0.625rem 1.25rem",
            fontSize: "0.875rem",
            fontWeight: 600,
          }}
        >
          Try again
        </button>
      </body>
    </html>
  );
}
