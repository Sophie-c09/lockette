import { Card } from "@/components/ui/Card";

// Pre-launch polish fix (item 5) — /bundle/[id] had no loading.tsx at all
// (a blank page during its server-side getBundleById fetch); shaped like
// BundleOutfitView's own heading + moodboard so there's no layout jump
// once the real content mounts.
export default function BundleLoading() {
  return (
    <div className="min-h-screen bg-teal-soft">
      <div className="mx-auto max-w-2xl px-6 py-12">
        <div className="h-6 w-48 animate-pulse rounded bg-inner" />
        <div className="mt-2 h-4 w-64 animate-pulse rounded bg-inner" />

        <Card className="mt-4 aspect-square w-full overflow-hidden p-0">
          <div className="h-full w-full animate-pulse bg-inner" />
        </Card>
      </div>
    </div>
  );
}
