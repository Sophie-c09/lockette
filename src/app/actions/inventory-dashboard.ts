"use server";

// Part 13 of the AI inventory architecture — read-only stats for the new
// "Inventory Intelligence" admin dashboard section. Same "Server Action
// for a fast, admin-gated read" convention as getImportDashboardStats
// (src/lib/import-dashboard.ts) and getScraperJobStatus
// (src/app/actions/admin-scraper.ts) — no scraper/indexer logic lives
// here, purely visibility.
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isCurrentUserAdmin } from "@/lib/admin";
import { getEnrichmentQueueStats } from "@/lib/inventory/enrichment-queue";
import { getLifecycleCounts } from "@/lib/inventory/listing-lifecycle";
import { TARGET_INVENTORY_SIZE } from "@/lib/scraper-config";
import type { ListingsDatabase } from "@/lib/supabase/listings.types";
import type { ScraperJobsDatabase } from "@/lib/supabase/scraper-jobs.types";

export interface InventoryIntelligenceStats {
  // null means "unknown" (not yet loaded, or this specific count's own
  // query failed) — never a stand-in for a real 0. See this file's own
  // ROOT CAUSE REGRESSION comment below for why this matters.
  totalInventory: number | null;
  targetInventory: number;
  aiAnalyzedCount: number;
  pendingAiJobs: number;
  processingAiJobs: number;
  failedAiJobs: number;
  averageQualityScore: number | null;
  newListingsToday: number;
  expiredListings: number;
  // Cumulative duplicate_count across every scraper_jobs run (see
  // src/lib/admin-scraper.ts's filterOutDuplicateCandidates) — the
  // clearest already-tracked proxy for "duplicate inventory prevented
  // from consuming the inventory target" this codebase has. Not the
  // SAME thing as duplicate-detection.ts's own post-import checks
  // (which don't currently persist a running counter anywhere) — see
  // this field's own name for why it's scoped to scraping specifically.
  duplicatesPreventedAtScrapeTime: number;
}

const EMPTY_STATS: InventoryIntelligenceStats = {
  totalInventory: null,
  targetInventory: TARGET_INVENTORY_SIZE,
  aiAnalyzedCount: 0,
  pendingAiJobs: 0,
  processingAiJobs: 0,
  failedAiJobs: 0,
  averageQualityScore: null,
  newListingsToday: 0,
  expiredListings: 0,
  duplicatesPreventedAtScrapeTime: 0,
};

export async function getInventoryIntelligenceStats(): Promise<{
  stats: InventoryIntelligenceStats;
  error?: string;
}> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user || !(await isCurrentUserAdmin(supabase, user.id))) {
    return { stats: EMPTY_STATS, error: "Not authorized." };
  }

  const adminSupabase = createAdminClient<ListingsDatabase>();
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  const [totalResult, analyzedResult, todayResult, avgQualityResult, queueStats, lifecycle, scraperJobsResult] = await Promise.all([
    // 'flagged' counted alongside 'active' as real inventory (a listing
    // awaiting flag review is still real acquired inventory, just not yet
    // visible) — 'pending' dropped from this union since no insert path
    // writes it anymore (see src/lib/inventory/listing-flagging.ts).
    // MUST stay in sync with src/lib/inventory/inventory-count.ts's
    // getCurrentInventoryCount() (job-start validation, the worker's own
    // target-reached check) — kept as its own inline query here (rather
    // than calling that helper directly) only to preserve this file's
    // null-vs-zero "did the query itself fail" distinction below, which
    // getCurrentInventoryCount() deliberately collapses to 0 for its own
    // simpler callers.
    adminSupabase.from("listings").select("id", { count: "exact", head: true }).in("status", ["active", "flagged"]),
    adminSupabase.from("listings").select("id", { count: "exact", head: true }).not("visual_analysis", "is", null),
    adminSupabase.from("listings").select("id", { count: "exact", head: true }).gte("created_at", startOfToday.toISOString()),
    adminSupabase.from("listings").select("inventory_quality_score").not("inventory_quality_score", "is", null).limit(1000),
    getEnrichmentQueueStats(),
    getLifecycleCounts(),
    createAdminClient<ScraperJobsDatabase>().from("scraper_jobs").select("duplicate_count"),
  ]);

  // ROOT CAUSE REGRESSION FIX — these three queries used to share ONE gate
  // ("if any of them errored, return EMPTY_STATS for everything"), which
  // meant a genuinely broken, UNRELATED column (analyzedResult's
  // visual_analysis — confirmed live: 42703 "column does not exist", the
  // Inventory Intelligence Layer migration was never actually applied)
  // blanked totalInventory — a completely healthy query with its own
  // real count — down to a fake 0. A real production incident: the
  // Inventory Growth "done" card read "Inventory is now at 0 / 5 total"
  // while production held ~8,700 real listings. Each count now degrades
  // independently — one broken column can never take an unrelated,
  // working count down with it.
  if (totalResult.error) {
    console.error("[inventory-dashboard] totalInventory query failed:", totalResult.error);
  }
  if (analyzedResult.error) {
    console.error("[inventory-dashboard] aiAnalyzedCount query failed:", analyzedResult.error);
  }
  if (todayResult.error) {
    console.error("[inventory-dashboard] newListingsToday query failed:", todayResult.error);
  }

  const qualityScores = (avgQualityResult.data ?? [])
    .map((row) => row.inventory_quality_score)
    .filter((score): score is number => score != null);
  const averageQualityScore =
    qualityScores.length > 0 ? qualityScores.reduce((sum, score) => sum + score, 0) / qualityScores.length : null;

  const duplicatesPreventedAtScrapeTime = (scraperJobsResult.data ?? []).reduce(
    (sum, row) => sum + (row.duplicate_count ?? 0),
    0,
  );

  return {
    stats: {
      totalInventory: totalResult.error ? null : totalResult.count ?? 0,
      targetInventory: TARGET_INVENTORY_SIZE,
      aiAnalyzedCount: analyzedResult.error ? 0 : analyzedResult.count ?? 0,
      pendingAiJobs: queueStats.pending,
      processingAiJobs: queueStats.processing,
      failedAiJobs: queueStats.failed,
      averageQualityScore: averageQualityScore != null ? Math.round(averageQualityScore * 100) / 100 : null,
      newListingsToday: todayResult.error ? 0 : todayResult.count ?? 0,
      expiredListings: lifecycle.expired,
      duplicatesPreventedAtScrapeTime,
    },
    // Only totalInventory's OWN query failing is surfaced here — that's
    // the one count the dashboard treats as load-bearing (see
    // ImportListingView.tsx's done-state card). analyzedResult/
    // todayResult failing degrades those two fields gracefully (0) above
    // without flagging the whole fetch as failed.
    error: totalResult.error ? "Failed to load current inventory total." : undefined,
  };
}
