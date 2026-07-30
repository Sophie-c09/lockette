// The admin-facing brand filter shown on /admin/import's "Brand Filters"
// section ("User can click brand buttons → scraper fetches ONLY those
// brands"). Kept in its own tiny, dependency-free module (not
// marketplace-discovery.ts, which imports Playwright) so ImportListingView.tsx
// — a client component — can import SELECTED_BRAND_OPTIONS as a real
// runtime value without pulling a Node-only browser-automation library
// into the client bundle. Both marketplace-discovery.ts (brand-prioritized
// query generation) and bulk-import.ts (brand filtering/boost) import the
// type from here — same split as selected-categories.ts.
export type SelectedBrand = "Abercrombie" | "Hollister" | "American Eagle";

export const SELECTED_BRAND_OPTIONS: { value: SelectedBrand; label: string }[] = [
  { value: "Abercrombie", label: "Abercrombie" },
  { value: "Hollister", label: "Hollister" },
  { value: "American Eagle", label: "American Eagle" },
];
