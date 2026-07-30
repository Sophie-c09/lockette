"use client";

import { useMemo, useState } from "react";

const DEFAULT_PAGE_SIZE = 3;

/**
 * Shared "top N, Shuffle reveals the next N highest-ranked unused results"
 * pagination for both reverse-search features (Find Similar / Find This
 * Look). Deliberately NOT random — this redesign's own spec: "Do not
 * randomly select listings... Show the next 3 highest ranked unused
 * results... Preserve ranking based on similarity score." `pool` must
 * already arrive sorted best-first (fetchSimilarListings /
 * fetchGarmentCandidates, src/lib/garment-matching.ts — the real
 * ranking); this hook only pages through it in fixed-size windows, never
 * repeating a candidate until the whole pool has been shown.
 */
export function useRankedPage<T>(pool: T[], pageSize: number = DEFAULT_PAGE_SIZE) {
  const [cursor, setCursor] = useState(0);

  // Memoized so `displayed` keeps the same array reference across
  // re-renders whenever `pool`/`cursor`/`pageSize` haven't actually
  // changed — callers that watch `displayed` in a useEffect dependency
  // array (e.g. OutfitRecreationView.tsx's CategorySection) would
  // otherwise see a "new" array every render (`.slice()` always
  // allocates) and re-fire on every render regardless of whether
  // anything real changed.
  const displayed = useMemo(() => pool.slice(cursor, cursor + pageSize), [pool, cursor, pageSize]);
  const canShowMore = cursor + pageSize < pool.length;

  function showNext() {
    if (!canShowMore) return;
    setCursor((current) => current + pageSize);
  }

  function reset() {
    setCursor(0);
  }

  return { displayed, canShowMore, showNext, reset, cursor };
}
