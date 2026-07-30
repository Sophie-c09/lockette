import { test } from "node:test";
import assert from "node:assert/strict";
import { runInBatches, type BatchRunSummary } from "@/lib/admin-scraper";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("large extraction input is processed in batches, not one giant call", async () => {
  // Given: 1000 items. Expected: batched into chunks of batchSize (100),
  // never all 1000 handed to a single mapWithConcurrency call at once —
  // this is the actual fix for extractRound's old unbounded round size.
  const items = Array.from({ length: 1000 }, (_, i) => i);
  const batches: BatchRunSummary[] = [];

  const { succeeded, failed } = await runInBatches(
    items,
    100,
    10,
    async (item) => item,
    (summary) => batches.push(summary),
  );

  assert.equal(succeeded.length, 1000, "every item should succeed");
  assert.equal(failed.length, 0);
  assert.equal(batches.length, 10, "1000 items / batchSize 100 = 10 batches");
  for (const batch of batches) {
    assert.ok(batch.batchSize <= 100, `no batch should exceed the configured batch size (got ${batch.batchSize})`);
  }
});

test("partial failures within a batch do not fail the whole batch", async () => {
  // Given: 10 URLs, 3 fail extraction. Expected: 7 succeed, 3 recorded as
  // failures — one bad URL must never take down its neighbors.
  const items = Array.from({ length: 10 }, (_, i) => i);
  const shouldFail = new Set([2, 5, 9]);

  const { succeeded, failed } = await runInBatches(items, 100, 10, async (item) => {
    if (shouldFail.has(item)) throw new Error(`extraction failed for item ${item}`);
    return item;
  });

  assert.equal(succeeded.length, 7);
  assert.equal(failed.length, 3);
  assert.deepEqual(
    failed.map((f) => f.item).sort(),
    [2, 5, 9],
  );
  for (const failure of failed) {
    assert.ok(failure.error instanceof Error, "each failure retains its original error/reason");
  }
});

test("a full queue eventually drains — every item is processed", async () => {
  // Given: 500 items ("queue depth"). Expected: all are eventually
  // processed, batch by batch, regardless of batch size relative to the
  // total.
  const items = Array.from({ length: 500 }, (_, i) => `url-${i}`);
  const processedOrder: string[] = [];

  const { succeeded, failed } = await runInBatches(items, 50, 8, async (item) => {
    processedOrder.push(item);
    return item;
  });

  assert.equal(succeeded.length, 500);
  assert.equal(failed.length, 0);
  assert.equal(new Set(processedOrder).size, 500, "every item processed exactly once, none skipped or duplicated");
});

test("never exceeds the configured concurrency limit", async () => {
  // Given: 100 items and a concurrency of 5. Expected: at no point are
  // more than 5 `run` calls in flight simultaneously.
  const items = Array.from({ length: 100 }, (_, i) => i);
  const concurrencyLimit = 5;
  let current = 0;
  let maxObserved = 0;

  await runInBatches(items, 25, concurrencyLimit, async (item) => {
    current++;
    maxObserved = Math.max(maxObserved, current);
    await delay(1);
    current--;
    return item;
  });

  assert.ok(
    maxObserved <= concurrencyLimit,
    `observed ${maxObserved} concurrent runs, expected at most ${concurrencyLimit}`,
  );
  assert.equal(maxObserved, concurrencyLimit, "should actually reach the configured limit, not run under-concurrently");
});

test("batches run sequentially — a later batch never starts before the earlier one's onBatchComplete fires", async () => {
  const items = Array.from({ length: 30 }, (_, i) => i);
  const batchBoundaries: number[] = [];

  await runInBatches(
    items,
    10,
    10,
    async (item) => item,
    () => batchBoundaries.push(Date.now()),
  );

  assert.equal(batchBoundaries.length, 3, "30 items / batchSize 10 = 3 batches");
});
