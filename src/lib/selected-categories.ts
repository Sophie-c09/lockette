// The admin-facing category filter shown on /admin/import ("I can run:
// Import 100 under $10 ONLY low-rise jeans + tops"). Kept in its own tiny,
// dependency-free module (not marketplace-discovery.ts, which imports
// Playwright) so ImportListingView.tsx — a client component — can import
// SELECTED_CATEGORY_OPTIONS as a real runtime value without pulling a
// Node-only browser-automation library into the client bundle. Both
// marketplace-discovery.ts (search-term mapping) and bulk-import.ts
// (matching/filtering) import the type from here.
export type SelectedCategory =
  | "low-rise-jeans"
  | "low-rise-shorts"
  | "low-rise-skirts"
  | "tops"
  | "dresses"
  | "skirts"
  | "sweaters-jackets";

export const SELECTED_CATEGORY_OPTIONS: { value: SelectedCategory; label: string }[] = [
  { value: "low-rise-jeans", label: "Low-rise jeans" },
  { value: "low-rise-shorts", label: "Low-rise shorts" },
  { value: "low-rise-skirts", label: "Low-rise skirts" },
  { value: "tops", label: "Tops" },
  { value: "dresses", label: "Dresses" },
  { value: "skirts", label: "Skirts" },
  { value: "sweaters-jackets", label: "Sweaters / Jackets" },
];
