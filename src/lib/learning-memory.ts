// Loads both learning signal sets for the style-aware scraper's filter
// pipeline (src/lib/admin-scraper-filter.ts). Fetched ONCE per scraper
// run (see admin-scraper.ts), not per-candidate — admin_rejections/
// approved_items don't change mid-run, so re-querying them for every
// single discovered listing would just be redundant round-trips against
// the exact same two tables (the same "avoid slowing the scraper"
// reasoning the whole pipeline already follows for image scoring).
import { createAdminClient } from "@/lib/supabase/admin";
import { extractRejectionSignals, type RejectionSignals } from "@/lib/rejection-learning";
import { extractPositiveSignals, type PositiveSignals } from "@/lib/positive-learning";

export interface LearningMemory {
  negative: RejectionSignals;
  positive: PositiveSignals;
}

const EMPTY_MEMORY: LearningMemory = {
  negative: { badTags: [], badFits: [] },
  positive: { goodTags: [], goodFits: [], goodAesthetics: [] },
};

export async function getLearningMemory(): Promise<LearningMemory> {
  const supabase = createAdminClient();

  const [{ data: rejected, error: rejectedError }, { data: approved, error: approvedError }] = await Promise.all([
    supabase.from("admin_rejections").select("tags, fit"),
    supabase.from("approved_items").select("tags, fit, aesthetic"),
  ]);

  if (rejectedError) {
    console.error("[learning-memory] Failed to fetch admin_rejections:", rejectedError);
  }
  if (approvedError) {
    console.error("[learning-memory] Failed to fetch approved_items:", approvedError);
  }

  if (rejectedError && approvedError) {
    return EMPTY_MEMORY;
  }

  return {
    negative: extractRejectionSignals(rejected ?? []),
    positive: extractPositiveSignals(approved ?? []),
  };
}
