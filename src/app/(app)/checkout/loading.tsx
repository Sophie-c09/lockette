// Pre-submission fix — /checkout had no loading.tsx at all (a blank page
// during its Supabase fetch); shaped like CheckoutView's own heading +
// shipping-form + order-summary blocks.
export default function CheckoutLoading() {
  return (
    <div className="min-h-[calc(100vh-137px)] px-6 pt-12 pb-16">
      <div className="mx-auto max-w-2xl">
        <div className="mb-8 text-center">
          <span className="font-display text-sm tracking-[0.2em] text-oxblood uppercase">Checkout</span>
          <h1 className="mt-2 font-display text-3xl font-semibold text-ink sm:text-4xl">
            Almost there
          </h1>
        </div>

        <div className="flex flex-col gap-6">
          <div className="flex flex-col gap-3 rounded-card border border-border bg-inner/50 p-4">
            <div className="h-4 w-40 animate-pulse rounded bg-inner" />
            <div className="h-9 w-full animate-pulse rounded-md bg-inner" />
            <div className="h-9 w-full animate-pulse rounded-md bg-inner" />
            <div className="h-9 w-full animate-pulse rounded-md bg-inner" />
          </div>

          <div className="h-16 w-full animate-pulse rounded-card bg-inner/50" />

          <div className="h-40 w-full animate-pulse rounded-card bg-inner/50" />
        </div>
      </div>
    </div>
  );
}
