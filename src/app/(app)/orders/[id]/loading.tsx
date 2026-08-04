const SKELETON_COUNT = 2;

// Pre-submission fix — /orders/[id] had no loading.tsx despite doing 4
// sequential Supabase reads (a blank page while they run); shaped like
// the confirmation page's own heading + item-row list.
export default function OrderLoading() {
  return (
    <div className="flex min-h-[calc(100vh-137px)] flex-col items-center px-6 py-12 text-center">
      <div className="h-10 w-10 animate-pulse rounded-full bg-inner" />
      <div className="mt-4 h-7 w-64 animate-pulse rounded bg-inner" />
      <div className="mt-3 h-4 w-48 animate-pulse rounded bg-inner" />

      <div className="mt-8 flex w-full max-w-md flex-col gap-3">
        {Array.from({ length: SKELETON_COUNT }).map((_, index) => (
          <div
            key={index}
            className="flex items-center justify-between gap-3 rounded-card border border-border bg-surface p-4"
          >
            <div className="flex flex-1 flex-col gap-2">
              <div className="h-4 w-3/4 animate-pulse rounded bg-inner" />
              <div className="h-3 w-1/2 animate-pulse rounded bg-inner" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
