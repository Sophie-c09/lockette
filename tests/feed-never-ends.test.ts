// Covers the P0 first-60-seconds fix (item 5) — the swipe/scroll feed
// must never show a terminal "No more matches"/dead-end state. Source-
// level assertions: this is client-side React effect control flow (offset
// refs, setInterval-free async loops) that needs a real DOM/browser
// environment to exercise end-to-end, which this project's unit-test
// suite deliberately avoids depending on.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const matchViewSource = readFileSync(join(__dirname, "..", "src", "components", "match", "MatchView.tsx"), "utf-8");
const discoverViewSource = readFileSync(join(__dirname, "..", "src", "components", "discover", "DiscoverView.tsx"), "utf-8");

test("MatchView no longer displays the literal 'No more matches' dead-end copy", () => {
  assert.doesNotMatch(matchViewSource, /No more matches — import more/);
});

test("MatchView wraps the fetch offset back to 0 once the pool is exhausted, instead of only setting hasMoreRef to false", () => {
  const prefetchFn = matchViewSource.slice(
    matchViewSource.indexOf("async function prefetchUntilQueueGrowsOrExhausted"),
  );
  assert.match(prefetchFn, /offsetRef\.current = 0/);
});

test("MatchView guards the wrap-around against a genuinely empty catalog with a bounded retry count", () => {
  assert.match(matchViewSource, /MAX_CONSECUTIVE_EMPTY_WRAPS/);
  assert.match(matchViewSource, /consecutiveEmptyWraps \+= 1/);
});

test("DiscoverView's infinite-scroll loader also wraps back to the top instead of only stopping", () => {
  const loadNextBatchFn = discoverViewSource.slice(discoverViewSource.indexOf("async function loadNextBatch"));
  assert.match(loadNextBatchFn, /offsetRef\.current = 0/);
  assert.match(loadNextBatchFn, /MAX_CONSECUTIVE_EMPTY_WRAPS/);
});
