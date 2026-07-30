import { test } from "node:test";
import assert from "node:assert/strict";
import { drainQueue } from "@/lib/admin-scraper";

// Exercises the exact discovery/extraction overlap pattern
// runNonAggressiveStreamingRound (src/lib/admin-scraper.ts) wires up for
// non-aggressive Inventory Growth:
//
//   let discoveryDone = false;
//   const discoveryPromise = someDiscoveryCall(...).finally(() => { discoveryDone = true; });
//   const extractionPromise = drainQueue({ isProducerDone: () => discoveryDone, ... });
//   await Promise.all([discoveryPromise, extractionPromise]);
//
// against a fake, in-memory "discovery producer" instead of the real
// Playwright-driven discoverListingUrlsAtScale — same reasoning
// admin-scraper-queue.test.ts already uses a fake scraper_url_queue so this
// lifecycle logic is directly unit-testable without a browser or a live
// database.

interface FakeRow {
  id: string;
  status: "pending" | "claimed" | "extracted";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A slow, bursty fake discovery producer: emits `perBurst` new rows into
 * `queue` every `burstDelayMs`, `burstCount` times total, via the same
 * `onUrlsFound`-shaped callback discoverListingUrlsAtScale uses, then
 * resolves. Mirrors "slow discovery" from this fix's own Step 9 spec.
 */
async function slowFakeDiscovery(
  queue: FakeRow[],
  burstCount: number,
  perBurst: number,
  burstDelayMs: number,
  onUrlsFound: (rows: FakeRow[]) => void,
): Promise<{ totalDiscovered: number }> {
  let totalDiscovered = 0;
  for (let burst = 0; burst < burstCount; burst++) {
    await delay(burstDelayMs);
    const newRows = Array.from({ length: perBurst }, (_, i) => ({
      id: `burst${burst}-row${i}`,
      status: "pending" as const,
    }));
    queue.push(...newRows);
    totalDiscovered += newRows.length;
    onUrlsFound(newRows);
  }
  return { totalDiscovered };
}

function makeClaim(queue: FakeRow[], batchSize: number) {
  return async () => {
    const claimable = queue.filter((row) => row.status === "pending").slice(0, batchSize);
    for (const row of claimable) row.status = "claimed";
    return claimable;
  };
}

test("streaming: extraction starts consuming the queue before slow discovery finishes", async () => {
  const queue: FakeRow[] = [];
  let discoveryDone = false;
  let firstExtractionAt: number | null = null;
  let discoveryFinishedAt: number | null = null;

  const discoveryPromise = slowFakeDiscovery(queue, 4, 5, 25, () => {})
    .then((result) => {
      discoveryFinishedAt = Date.now();
      return result;
    })
    .finally(() => {
      discoveryDone = true;
    });

  const extractionPromise = drainQueue<FakeRow, string>({
    targetCount: Infinity,
    maxWaitMs: 5_000,
    idleCutoffMs: 60,
    pollDelayMs: 5,
    isProducerDone: () => discoveryDone,
    batchSize: 5,
    concurrency: 5,
    claim: makeClaim(queue, 5),
    run: async (row) => {
      if (firstExtractionAt === null) firstExtractionAt = Date.now();
      return row.id;
    },
    onSuccess: (row) => {
      row.status = "extracted";
    },
    onFailure: (row) => {
      row.status = "extracted";
    },
  });

  const [, { results }] = await Promise.all([discoveryPromise, extractionPromise]);

  assert.ok(firstExtractionAt !== null, "extraction must have processed at least one item");
  assert.ok(discoveryFinishedAt !== null, "discovery must have completed");
  assert.ok(
    (firstExtractionAt as number) < (discoveryFinishedAt as number),
    `first extraction (t=${firstExtractionAt}) must happen before discovery finishes (t=${discoveryFinishedAt}) — ` +
      "extraction queue depth must not sit at 0 for the entire discovery phase",
  );
  assert.equal(results.length, 20, "all 4 bursts of 5 rows each must eventually be extracted");
});

test("drain completion: the round only finishes once discovery is done AND the queue is fully drained", async () => {
  const queue: FakeRow[] = [];
  let discoveryDone = false;
  let resolvedAt: number | null = null;

  const discoveryPromise = slowFakeDiscovery(queue, 3, 10, 20, () => {}).finally(() => {
    discoveryDone = true;
  });

  const extractionPromise = drainQueue<FakeRow, string>({
    targetCount: Infinity,
    maxWaitMs: 5_000,
    idleCutoffMs: 50,
    pollDelayMs: 5,
    isProducerDone: () => discoveryDone,
    batchSize: 8,
    concurrency: 4,
    claim: makeClaim(queue, 8),
    run: async (row) => row.id,
    onSuccess: (row) => {
      row.status = "extracted";
    },
    onFailure: (row) => {
      row.status = "extracted";
    },
  }).then((result) => {
    resolvedAt = Date.now();
    return result;
  });

  await Promise.all([discoveryPromise, extractionPromise]);

  assert.equal(discoveryDone, true, "discovery must be done by the time the round completes");
  assert.equal(
    queue.filter((r) => r.status === "pending" || r.status === "claimed").length,
    0,
    "queue must be fully drained — no row left pending or stuck claimed",
  );
  assert.ok(resolvedAt !== null);
});

test("no deadlock: extraction with an unbounded targetCount still exits once discovery finishes and the queue empties", async () => {
  const queue: FakeRow[] = [];
  let discoveryDone = false;

  // Fast discovery: finishes almost immediately, well before maxWaitMs.
  const discoveryPromise = slowFakeDiscovery(queue, 2, 3, 10, () => {}).finally(() => {
    discoveryDone = true;
  });

  const startedAt = Date.now();
  const extractionPromise = drainQueue<FakeRow, string>({
    // Same shape as the real non-aggressive streaming round: no count-based
    // stopping condition at all — this loop must exit via
    // isProducerDone() + idleCutoffMs, never by "reached targetCount".
    targetCount: Infinity,
    maxWaitMs: 5_000,
    idleCutoffMs: 60,
    pollDelayMs: 5,
    isProducerDone: () => discoveryDone,
    batchSize: 10,
    concurrency: 5,
    claim: makeClaim(queue, 10),
    run: async (row) => row.id,
    onSuccess: (row) => {
      row.status = "extracted";
    },
    onFailure: (row) => {
      row.status = "extracted";
    },
  });

  const [, { results }] = await Promise.all([discoveryPromise, extractionPromise]);
  const elapsedMs = Date.now() - startedAt;

  assert.equal(results.length, 6, "all discovered rows (2 bursts of 3) extracted");
  assert.ok(
    elapsedMs < 5_000,
    `expected the loop to exit via the idle-cutoff path (well under the 5000ms maxWaitMs safety cap), took ${elapsedMs}ms`,
  );
});
