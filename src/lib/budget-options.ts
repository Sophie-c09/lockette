// Shared item-level budget selector for the reverse-image-search
// features — "More Like This" (src/lib/similar-listings.ts), "Recreate
// This Outfit," and "Style Me" (both via src/lib/garment-matching.ts) —
// so a search can be scoped to a price range before results are shown,
// same options everywhere rather than each feature inventing its own
// tiers.
export type BudgetOption = "under10" | "under25" | "under45" | "any";

export interface BudgetOptionDef {
  value: BudgetOption;
  label: string;
  // null = no ceiling ("Any price").
  maxPrice: number | null;
}

export const BUDGET_OPTIONS: BudgetOptionDef[] = [
  { value: "under10", label: "Under $10", maxPrice: 10 },
  { value: "under25", label: "Under $25", maxPrice: 25 },
  { value: "under45", label: "Under $45", maxPrice: 45 },
  { value: "any", label: "Any price", maxPrice: null },
];

export function budgetMaxPrice(option: BudgetOption): number | null {
  return BUDGET_OPTIONS.find((entry) => entry.value === option)?.maxPrice ?? null;
}

// Bridge for Style Me, which still collects one raw total-dollar `budget`
// number from its form (unchanged — no UI/form changes this round) and
// splits it evenly per detected category (src/app/actions/style-me.ts).
// Converts that raw per-item ceiling to the nearest standard tier so
// src/lib/garment-matching.ts's fetchGarmentCandidates (which only speaks
// BudgetOption, not arbitrary dollar amounts) can rank/filter the same
// way every other feature does.
export function nearestBudgetOption(maxPricePerItem: number | null): BudgetOption {
  if (maxPricePerItem == null) return "any";
  if (maxPricePerItem <= 10) return "under10";
  if (maxPricePerItem <= 25) return "under25";
  if (maxPricePerItem <= 45) return "under45";
  return "any";
}
