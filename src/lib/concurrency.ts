// Inventory Growth cancellation fix — thrown/passed as an AbortController's
// abort reason so any catch block can tell "this stopped because WE
// cancelled it" apart from a genuine marketplace/network failure (a
// blocked request, a timeout, a malformed page) via `error instanceof
// BatchAbortedError` or `signal.aborted` at the point of catching —
// needed so cancelling a batch never counts as a poison-URL attempt
// (markUrlFailed's attempt_count) or a marketplace circuit-breaker hit
// (recordDiscoveryAttempt).
export class BatchAbortedError extends Error {
  constructor(message = "Batch aborted") {
    super(message);
    this.name = "BatchAbortedError";
  }
}

// Inventory Growth cancellation fix — a delay that exits EARLY (rejecting
// with the signal's own abort reason) the moment `signal` aborts, instead
// of always waiting out the full `ms`. Every rate-limit/backoff/retry
// delay in the large-scale discovery path used a bare `setTimeout` that
// couldn't be interrupted — the one concrete way an aborted batch could
// still sit doing nothing useful for up to tens of seconds after its
// outer watchdog already gave up on it. Plain, non-abortable delays
// elsewhere (e.g. the watchdog's OWN timeout/grace-period timers, which
// must elapse regardless of the very signal they manage) intentionally
// keep using a bare `new Promise((resolve) => setTimeout(resolve, ms))`
// instead of this helper.
export function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("Aborted"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new Error("Aborted"));
      },
      { once: true },
    );
  });
}

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
