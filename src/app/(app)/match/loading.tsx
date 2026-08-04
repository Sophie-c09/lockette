// P0 first-60-seconds polish (item 10) — /match had a graceful error
// state already (see page.tsx) but no loading skeleton at all, unlike its
// sibling /discover (discover/loading.tsx) — a real, visible asymmetry
// between the app's two primary feeds. Mirrors that file's own skeleton
// language (Card + animate-pulse), shaped like Match's single swipe card
// instead of Discover's grid.
import { Card } from "@/components/ui/Card";

export default function MatchLoading() {
  return (
    <div className="flex min-h-[calc(100vh-137px)] flex-col items-center px-6 pt-12 pb-16">
      <div className="mb-8 text-center">
        <span className="font-display text-sm uppercase tracking-[0.2em] text-oxblood">
          Match
        </span>
        <h1 className="mt-2 font-display text-3xl font-semibold text-ink sm:text-4xl">
          Swipe your way to your next favorite find
        </h1>
      </div>

      <div className="relative h-[520px] w-full max-w-sm">
        <Card className="flex h-full flex-col overflow-hidden p-0">
          <div className="aspect-[3/4] shrink-0 animate-pulse bg-inner" />
          <div className="flex flex-1 flex-col gap-2 p-4">
            <div className="h-4 w-3/4 animate-pulse rounded bg-inner" />
            <div className="h-3 w-1/3 animate-pulse rounded bg-inner" />
          </div>
        </Card>
      </div>
    </div>
  );
}
