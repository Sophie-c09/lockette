"use client";

import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";

// Shared retry affordance for server-rendered page-level error states
// (Discover/Match/Saved so far — see each page.tsx's own comment).
// router.refresh() re-runs the server component's data fetch in place,
// so a transient failure (a dropped Supabase connection, a timeout) can
// recover without a full page reload or losing scroll position.
export function RetryButton({ label = "Try again" }: { label?: string }) {
  const router = useRouter();
  return (
    <Button type="button" variant="secondary" onClick={() => router.refresh()}>
      {label}
    </Button>
  );
}
