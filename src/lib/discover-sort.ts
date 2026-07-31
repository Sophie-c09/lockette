// Discover's sort-control logic — deliberately its own zero-import,
// client-safe module. discover-feed.ts (the data-fetching loader) imports
// @/lib/supabase/server, a server-only module; DiscoverView.tsx ("use
// client") needs to re-run this exact same sort client-side (switching
// the dropdown must reorder the already-loaded listings instantly,
// without a server round-trip — see "Do not trigger a full reload when
// switching back to Default" in this feature's own spec), so it can't
// import a value (not just a type) from discover-feed.ts. Same "extract
// the shared pure logic into its own dependency-free file" fix as
// category-bucket.ts, for the same class of reason (there, a heavy
// server-only transitive import; here, a server-only module boundary).
//
// "" (empty string, Default) is its own real, non-default-omitted VALUE
// here — distinct from how DEFAULT_DISCOVER_SORT is *handled* in the URL
// (still omitted from the querystring when active, same as before) but
// distinct in behavior from the other three: Default means "don't
// override the personalized order," not "sort by nothing."
export type DiscoverSortOption = "" | "recent" | "price_asc" | "price_desc";
export const DEFAULT_DISCOVER_SORT: DiscoverSortOption = "";

// Narrows an arbitrary ?sort= query string to a real option, falling back
// to the default rather than erroring on a typo'd/old bookmarked URL (or
// an old link/bookmark still carrying a since-removed "match"/"points"
// value). A missing or empty ?sort= is explicitly Default, not an error
// case — same "unrecognized/absent falls open" convention
// categorySlug/typeSlug/styleSlug already use in discover-feed.ts.
export function parseDiscoverSortOption(raw: string | null | undefined): DiscoverSortOption {
  return raw === "recent" || raw === "price_asc" || raw === "price_desc" ? raw : DEFAULT_DISCOVER_SORT;
}

// Ascending or descending numeric compare where null/undefined always
// sorts LAST regardless of direction — "missing/invalid prices should
// appear after listings with valid prices" (this feature's own spec).
function compareNullsLast(a: number | null, b: number | null, direction: "asc" | "desc"): number {
  const aMissing = a == null;
  const bMissing = b == null;
  if (aMissing && bMissing) return 0;
  if (aMissing) return 1;
  if (bMissing) return -1;
  return direction === "asc" ? a - b : b - a;
}

// "Invalid" isn't just missing — a negative or non-finite (NaN/Infinity)
// price is treated the same as null (sorts last either way).
function normalizedPrice(price: number | null | undefined): number | null {
  return price != null && Number.isFinite(price) && price >= 0 ? price : null;
}

// Whatever shape the caller's real listing objects are (discover-feed.ts's
// DiscoverSortEntry wraps a Listing; DiscoverView.tsx's own state is a
// flat ScoredDiscoverListing) — getKeys adapts either into the four
// fields this module actually needs, so this stays shape-agnostic rather
// than forcing one canonical listing type on both the server loader and
// the client component.
export interface DiscoverSortKeys {
  id: string;
  price: number | null | undefined;
  createdAt: string;
  // The garment-level personalization score (discover-personalization.ts's
  // scoreGarmentStyleMatch, 0-100) — null only ever occurs for photo-search
  // results, which never render the sort dropdown at all (see
  // DiscoverView.tsx) and never call this function; treated as 0
  // (lowest priority) defensively regardless.
  matchPercent: number | null | undefined;
}

// The algorithm's own ranking — matchPercent descending, since that's
// literally what scoreGarmentStyleMatch already decided is the best match
// for this user. This is computed FIRST, always, regardless of
// sortOption (this feature's own "the personalized ranking should always
// be computed first" requirement) — every sortOption re-sorts this base,
// Default (sortOption === "") just returns it untouched.
function personalizedOrder<T>(entries: T[], getKeys: (entry: T) => DiscoverSortKeys): T[] {
  return [...entries].sort((a, b) => {
    const keysA = getKeys(a);
    const keysB = getKeys(b);
    const matchCmp = (keysB.matchPercent ?? 0) - (keysA.matchPercent ?? 0);
    if (matchCmp !== 0) return matchCmp;
    const priceCmp = compareNullsLast(normalizedPrice(keysA.price), normalizedPrice(keysB.price), "asc");
    if (priceCmp !== 0) return priceCmp;
    return keysA.id < keysB.id ? -1 : keysA.id > keysB.id ? 1 : 0;
  });
}

/**
 * Applies the user-selected display order on top of the always-computed
 * personalized ranking:
 *   ""          -> the personalized ranking itself, untouched (Default).
 *   "recent"    -> created_at descending.
 *   "price_asc" -> price ascending, invalid/missing prices last.
 *   "price_desc"-> price descending, invalid/missing prices last (same
 *                  as price_asc — invalid prices never move to the front
 *                  just because the direction flipped).
 * Every option ends with a stable id tiebreak so ties never fall back to
 * arbitrary/incoming order.
 */
export function applyDiscoverSort<T>(
  entries: T[],
  sortOption: DiscoverSortOption,
  getKeys: (entry: T) => DiscoverSortKeys,
): T[] {
  const base = personalizedOrder(entries, getKeys);
  if (sortOption === "") return base;

  return [...base].sort((a, b) => {
    const keysA = getKeys(a);
    const keysB = getKeys(b);
    const primary =
      sortOption === "price_asc"
        ? compareNullsLast(normalizedPrice(keysA.price), normalizedPrice(keysB.price), "asc")
        : sortOption === "price_desc"
          ? compareNullsLast(normalizedPrice(keysA.price), normalizedPrice(keysB.price), "desc")
          : Date.parse(keysB.createdAt) - Date.parse(keysA.createdAt); // "recent" — newest first

    if (primary !== 0) return primary;
    return keysA.id < keysB.id ? -1 : keysA.id > keysB.id ? 1 : 0;
  });
}
