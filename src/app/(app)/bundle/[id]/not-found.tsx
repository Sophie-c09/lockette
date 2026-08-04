import { Sparkles } from "lucide-react";
import { LinkButton } from "@/components/ui/Button";

// Pre-launch polish fix (item 4) — /bundle/[id]'s page.tsx calls notFound()
// on any missing/inaccessible bundle, but this route had no custom
// not-found.tsx, so it fell through to Next's generic unbranded 404
// (unlike listing/[id]'s own not-found.tsx, mirrored here).
export default function BundleNotFound() {
  return (
    <div className="flex min-h-[calc(100vh-137px)] items-center justify-center px-6">
      <div className="mx-auto flex max-w-md flex-col items-center gap-4 rounded-card bg-highlight-cream px-8 py-16 text-center">
        <Sparkles className="h-8 w-8 text-oxblood" strokeWidth={1.5} />
        <p className="text-sm text-ink-soft">
          This bundle doesn&apos;t exist or may have been removed.
        </p>
        <LinkButton href="/my-style-requests">My style requests</LinkButton>
      </div>
    </div>
  );
}
