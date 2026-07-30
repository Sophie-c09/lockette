import { Card } from "@/components/ui/Card";

const SKELETON_COUNT = 8;

export default function DiscoverLoading() {
  return (
    <div className="min-h-[calc(100vh-137px)] px-6 pt-12">
      <div className="mx-auto max-w-5xl">
        <div className="mb-8 text-center">
          <span className="font-display text-sm uppercase tracking-[0.2em] text-oxblood">
            Discover
          </span>
          <h1 className="mt-2 font-display text-3xl font-semibold text-ink sm:text-4xl">
            Browse the full collection
          </h1>
        </div>

        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {Array.from({ length: SKELETON_COUNT }).map((_, index) => (
            <Card key={index} className="flex flex-col overflow-hidden p-0">
              <div className="aspect-[3/4] animate-pulse bg-inner" />
              <div className="flex flex-col gap-2 p-4">
                <div className="h-4 w-3/4 animate-pulse rounded bg-inner" />
                <div className="h-3 w-1/2 animate-pulse rounded bg-inner" />
              </div>
            </Card>
          ))}
        </div>
      </div>
    </div>
  );
}
