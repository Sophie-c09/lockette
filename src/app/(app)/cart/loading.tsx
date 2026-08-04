const SKELETON_COUNT = 3;

// Pre-submission fix — /cart had no loading.tsx at all (a blank page during
// its Supabase fetch); shaped like CartView's own heading + item-row list.
export default function CartLoading() {
  return (
    <div className="min-h-[calc(100vh-137px)] px-6 pt-12">
      <div className="mx-auto max-w-3xl">
        <div className="mb-8 text-center">
          <span className="font-display text-sm tracking-[0.2em] text-oxblood uppercase">
            Cart
          </span>
          <h1 className="mt-2 font-display text-3xl font-semibold text-ink sm:text-4xl">
            Your superliked finds
          </h1>
        </div>

        <div className="flex flex-col gap-4">
          {Array.from({ length: SKELETON_COUNT }).map((_, index) => (
            <div key={index} className="flex gap-4 rounded-card border border-border bg-surface p-3">
              <div className="h-28 w-28 shrink-0 animate-pulse rounded-card bg-inner sm:h-32 sm:w-32" />
              <div className="flex flex-1 flex-col gap-2 py-1">
                <div className="h-4 w-3/4 animate-pulse rounded bg-inner" />
                <div className="h-3 w-1/3 animate-pulse rounded bg-inner" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
