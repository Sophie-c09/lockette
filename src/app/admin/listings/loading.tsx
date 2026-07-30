// Next.js's built-in loading-UI convention — automatically shown (via an
// implicit Suspense boundary) while AdminListingsPage's server-side
// getPendingListings() call is in flight. Distinct from the page's own
// "no pending listings"/"error" states, which only ever render once that
// fetch has actually resolved one way or the other.
export default function AdminListingsLoading() {
  return (
    <div className="flex min-h-screen flex-col items-center px-6 py-10 pb-16">
      <div className="w-full max-w-md">
        <div className="mb-6 flex items-center justify-between">
          <h1 className="font-display text-xl font-semibold text-ink">Review listings</h1>
        </div>
        <div className="animate-pulse rounded-card border border-border bg-inner/50 p-12 text-center text-sm text-ink-soft">
          Loading…
        </div>
      </div>
    </div>
  );
}
