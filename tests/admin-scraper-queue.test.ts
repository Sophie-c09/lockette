import { test } from "node:test";
import assert from "node:assert/strict";
import { drainQueue } from "@/lib/admin-scraper";

// In-memory fake of scraper_url_queue's own lifecycle (pending -> claimed
// -> extracted/failed) — same 4 states the real table's status CHECK
// constraint enforces (supabase/schema.sql). Exercises drainQueue's real
// claim/run/mark-success/mark-failure loop without Playwright or a live
// database, the same reasoning runInBatches' own tests already used.
interface FakeQueueRow {
  id: string;
  url: string;
  status: "pending" | "claimed" | "extracted" | "failed";
  attemptCount: number;
}

function seedQueue(count: number): FakeQueueRow[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `row-${i}`,
    url: `https://example.com/item-${i}`,
    status: "pending",
    attemptCount: 0,
  }));
}

function makeClaim(queue: FakeQueueRow[], batchSize: number) {
  return async () => {
    const claimable = queue.filter((row) => row.status === "pending").slice(0, batchSize);
    for (const row of claimable) row.status = "claimed";
    return claimable;
  };
}

test("100 discovered URLs -> 100 queue inserts -> 100 completions/failures, 0 stale pending", async () => {
  const queue = seedQueue(100);
  const shouldFail = new Set(["row-3", "row-42", "row-99"]);

  const { results } = await drainQueue<FakeQueueRow, string>({
    // Achievable maximum given the 3 permanent failures below — the
    // "100 completions/failures" the task describes is checked via the
    // queue's own terminal-status counts further down, not this number
    // (drainQueue itself only ever stops once it reaches targetCount
    // successes, drains the queue, or times out).
    targetCount: 97,
    maxWaitMs: 5_000,
    idleCutoffMs: 20,
    pollDelayMs: 5,
    isProducerDone: () => true,
    batchSize: 25,
    concurrency: 5,
    claim: makeClaim(queue, 25),
    run: async (row) => {
      if (shouldFail.has(row.id)) throw new Error(`extraction failed for ${row.url}`);
      return row.url;
    },
    onSuccess: (row) => {
      row.status = "extracted";
    },
    onFailure: (row) => {
      row.attemptCount++;
      row.status = "failed";
    },
  });

  assert.equal(results.length, 97, "97 of 100 succeeded");
  assert.equal(queue.filter((r) => r.status === "pending").length, 0, "no stale pending rows remain");
  assert.equal(queue.filter((r) => r.status === "claimed").length, 0, "no rows stuck mid-claim");
  assert.equal(queue.filter((r) => r.status === "extracted").length, 97);
  assert.equal(queue.filter((r) => r.status === "failed").length, 3);
});

test("500 pending URLs are all eventually processed in batches", async () => {
  const queue = seedQueue(500);
  const claimSizes: number[] = [];

  const { results } = await drainQueue<FakeQueueRow, string>({
    targetCount: 500,
    maxWaitMs: 10_000,
    idleCutoffMs: 0,
    isProducerDone: () => true,
    batchSize: 50,
    concurrency: 10,
    claim: async () => {
      const claim = await makeClaim(queue, 50)();
      claimSizes.push(claim.length);
      return claim;
    },
    run: async (row) => row.url,
    onSuccess: (row) => {
      row.status = "extracted";
    },
    onFailure: (row) => {
      row.status = "failed";
    },
  });

  assert.equal(results.length, 500);
  assert.equal(queue.filter((r) => r.status === "extracted").length, 500);
  assert.ok(claimSizes.length >= 10, `expected at least 10 claim cycles for 500 rows at batchSize 50, got ${claimSizes.length}`);
  for (const size of claimSizes) assert.ok(size <= 50, `claim size ${size} exceeded configured batchSize 50`);
});

test("10 URLs, 3 extraction failures -> 7 completed, 3 failed, pipeline continues", async () => {
  const queue = seedQueue(10);
  const shouldFail = new Set(["row-1", "row-4", "row-7"]);
  const failureReasons: Array<{ id: string; error: unknown }> = [];

  const { results } = await drainQueue<FakeQueueRow, string>({
    // Achievable maximum given the 3 permanent failures below (see the
    // 100-URL test's own comment on why this isn't 10).
    targetCount: 7,
    maxWaitMs: 5_000,
    idleCutoffMs: 20,
    pollDelayMs: 5,
    isProducerDone: () => true,
    batchSize: 10,
    concurrency: 10,
    claim: makeClaim(queue, 10),
    run: async (row) => {
      if (shouldFail.has(row.id)) throw new Error(`bad URL: ${row.url}`);
      return row.url;
    },
    onSuccess: (row) => {
      row.status = "extracted";
    },
    onFailure: (row, error) => {
      row.status = "failed";
      failureReasons.push({ id: row.id, error });
    },
  });

  assert.equal(results.length, 7, "7 URLs completed despite 3 failures");
  assert.equal(queue.filter((r) => r.status === "failed").length, 3);
  assert.equal(failureReasons.length, 3);
  for (const failure of failureReasons) {
    assert.ok(failure.error instanceof Error, "failure reason is recorded, not swallowed");
  }
  // Pipeline continues: every row was attempted exactly once, none were
  // skipped because an earlier one in the same claimed batch failed.
  assert.equal(queue.filter((r) => r.status === "pending" || r.status === "claimed").length, 0);
});

test("the same queue lifecycle produces identical outcomes regardless of discovery-mode timing", async () => {
  // Simulates the one real difference between aggressive mode (discovery
  // runs concurrently, isProducerDone starts false and flips true later)
  // and non-aggressive mode (discovery already finished, isProducerDone
  // is true from the start) — the CLAIM/RUN/MARK lifecycle itself must
  // behave identically either way, since both now go through the same
  // drainQueue call (runQueueDrivenExtraction binds both admin-scraper.ts
  // callers to this exact function).
  async function runScenario(discoveryFinishesLate: boolean) {
    const queue = seedQueue(20);
    let producerDone = !discoveryFinishesLate;
    if (discoveryFinishesLate) {
      setTimeout(() => {
        producerDone = true;
      }, 20);
    }

    return drainQueue<FakeQueueRow, string>({
      targetCount: 20,
      maxWaitMs: 5_000,
      idleCutoffMs: 0,
      isProducerDone: () => producerDone,
      batchSize: 8,
      concurrency: 4,
      pollDelayMs: 5,
      claim: makeClaim(queue, 8),
      run: async (row) => row.url,
      onSuccess: (row) => {
        row.status = "extracted";
      },
      onFailure: (row) => {
        row.status = "failed";
      },
    }).then(({ results }) => ({ results, queue }));
  }

  const aggressiveLike = await runScenario(true);
  const nonAggressiveLike = await runScenario(false);

  assert.equal(aggressiveLike.results.length, 20);
  assert.equal(nonAggressiveLike.results.length, 20);
  assert.equal(
    aggressiveLike.queue.filter((r) => r.status === "extracted").length,
    nonAggressiveLike.queue.filter((r) => r.status === "extracted").length,
    "same lifecycle outcome regardless of when the producer reports done",
  );
});
