// Small, generic bounded-concurrency runner — shared by the
// check-listing-status cron route and the bulk-import batch processor, so
// both "run N of these at once, not all-at-once and not one-at-a-time"
// call sites use the same implementation.
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  // Second `index` argument is optional/additive (existing callers that
  // only declare `(item)` are unaffected) — added for scaled-discovery.ts's
  // strategy rotation, which needs to know each pick's position without a
  // second array pass.
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex++;
      results[currentIndex] = await fn(items[currentIndex], currentIndex);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}
