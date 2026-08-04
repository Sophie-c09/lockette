// Style Bundle ("Get Styled" / style-request) budget tiers — P0
// first-60-seconds fix, item 8: replaces a free-text `<input type="number">`
// (no guardrails, easy to fat-finger, inconsistent with every other
// budget picker in the app) with a fixed set of ranges. Distinct from
// onboarding's own BUDGET_OPTIONS (src/lib/onboarding-data.ts, 4 coarser
// tiers for "budget per item") and the reverse-image-search BudgetOption
// (src/lib/budget-options.ts, "under10"/"under25"/"under45"/"any") — each
// serves a different feature with its own real requirements, not one
// budget concept forced to fit three different UIs.
//
// The pipeline this feeds (src/lib/bundle-generation.ts's
// allocateBudgetPerItem) only ever speaks one raw total-dollar ceiling —
// unchanged here — so each tier's `value` is that range's own upper
// bound, same "represent a range as its ceiling" approach this codebase
// already uses (onboarding's own BUDGET_OPTIONS, nearestBudgetOption).
export interface StyleRequestBudgetOption {
  label: string;
  value: number;
}

export const STYLE_REQUEST_BUDGET_OPTIONS: StyleRequestBudgetOption[] = [
  { label: "Under $25", value: 25 },
  { label: "$25–50", value: 50 },
  { label: "$50–75", value: 75 },
  { label: "$75–100", value: 100 },
  { label: "$100–150", value: 150 },
  { label: "$150+", value: 500 },
];
