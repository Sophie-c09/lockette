"use server";

import { fetchMatchBatch, MATCH_BATCH_SIZE, type MatchBatchResult } from "@/lib/match-feed";

// Called directly from MatchView (client) once the swipe queue runs low —
// a single call per prefetch trigger, not a loop, so this doesn't hit the
// "Server Action in a tight client-side loop" issue documented elsewhere
// in this codebase (see ImportListingView.tsx).
export async function loadMoreMatchListings(offset: number): Promise<MatchBatchResult> {
  return fetchMatchBatch(offset, MATCH_BATCH_SIZE);
}
