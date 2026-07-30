// Shared batch sizes for /discover (infinite scroll, now the single
// unified browsing page — see discover-feed.ts) and /match (swipe queue
// prefetch). No imports of its own on purpose — safe to import from both
// server-only lib files and client components without pulling any server
// code across the client/server boundary.
export const DISCOVER_BATCH_SIZE = 60;
export const MATCH_BATCH_SIZE = 25;
export const MATCH_PREFETCH_THRESHOLD = 5;
// Same "prefetch before the user actually runs out" reasoning as
// MATCH_PREFETCH_THRESHOLD, for Discover's own swipe queue.
export const DISCOVER_PREFETCH_THRESHOLD = 5;
