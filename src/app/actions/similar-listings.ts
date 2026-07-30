"use server";

// Thin Server Action wrapper around fetchSimilarListings
// (src/lib/similar-listings.ts) so SimilarListingsPanel.tsx (client) can
// re-run "More Like This" whenever the admin picks/changes their item-
// level budget (src/lib/budget-options.ts) — the listing detail page no
// longer eagerly fetches this on every load (see that page's own
// comment), it only runs once a budget is actually selected.
import { fetchSimilarListings } from "@/lib/similar-listings";
import { budgetMaxPrice, type BudgetOption } from "@/lib/budget-options";
import type { Listing } from "@/lib/supabase/listings.types";

export async function findSimilarListings(
  listingId: string,
  aestheticTags: string[],
  budget: BudgetOption,
): Promise<{ listings: Listing[] }> {
  const listings = await fetchSimilarListings(listingId, aestheticTags, budgetMaxPrice(budget));
  return { listings };
}
