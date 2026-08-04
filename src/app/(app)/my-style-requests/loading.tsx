import { Card } from "@/components/ui/Card";

const SKELETON_COUNT = 3;

// Pre-launch polish fix (item 5) — /my-style-requests had no loading.tsx
// at all (a blank page during its server-side fetch); shaped like
// MyStyleRequestsView's own request-card list.
export default function MyStyleRequestsLoading() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-12">
      <h1 className="font-display text-2xl font-semibold text-ink">My style requests</h1>

      <div className="mt-8 flex flex-col gap-6">
        {Array.from({ length: SKELETON_COUNT }).map((_, index) => (
          <Card key={index} className="p-6">
            <div className="flex items-center justify-between gap-2">
              <div className="h-3 w-20 animate-pulse rounded bg-inner" />
              <div className="h-5 w-24 animate-pulse rounded-pill bg-inner" />
            </div>
            <div className="mt-3 h-4 w-3/4 animate-pulse rounded bg-inner" />
            <div className="mt-3 flex gap-2">
              <div className="h-20 w-20 shrink-0 animate-pulse rounded-2xl bg-inner" />
              <div className="h-20 w-20 shrink-0 animate-pulse rounded-2xl bg-inner" />
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
