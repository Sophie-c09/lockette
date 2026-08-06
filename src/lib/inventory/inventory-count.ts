// Final Inventory Growth stabilization pass — ONE shared definition of
// "current inventory," used everywhere a count is compared against a
// target: job-start validation (large-scale/route.ts), the worker's own
// target-reached decision (admin-scraper.ts's runLargeScaleAdminScraper),
// and the admin dashboard's progress bar/ETA (inventory-dashboard.ts).
//
// ROOT CAUSE this closes: those three call sites had drifted onto TWO
// different definitions — the dashboard counted status IN ('active',
// 'flagged') (a listing awaiting flag review is still real acquired
// inventory, just not yet publicly visible; 'pending' and 'removed' are
// not), while job-start validation and the worker's own completion check
// counted every row regardless of status. Confirmed live: 774 active + 88
// pending + 138 removed = 1000 total vs. 774 "real" inventory — a target
// near that gap could satisfy the worker's own (uncounted) check while
// the dashboard still showed the run as short of its target, or vice
// versa. Every caller listed above now goes through this one function.
import { createAdminClient } from "@/lib/supabase/admin";
import type { ListingsDatabase } from "@/lib/supabase/listings.types";

export async function getCurrentInventoryCount(): Promise<number> {
  const supabase = createAdminClient<ListingsDatabase>();
  const { count, error } = await supabase.from("listings").select("id", { count: "exact", head: true }).in("status", ["active", "flagged"]);
  if (error) {
    console.error("[inventory-count] Failed to read current inventory count (treating as 0 for this check):", error);
    return 0;
  }
  return count ?? 0;
}
