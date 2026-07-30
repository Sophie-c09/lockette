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
  totalInventory: number;
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
  totalInventory: 0,
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
    adminSupabase.from("listings").select("id", { count: "exact", head: true }).in("status", ["active", "flagged"]),
    adminSupabase.from("listings").select("id", { count: "exact", head: true }).not("visual_analysis", "is", null),
    adminSupabase.from("listings").select("id", { count: "exact", head: true }).gte("created_at", startOfToday.toISOString()),
    adminSupabase.from("listings").select("inventory_quality_score").not("inventory_quality_score", "is", null).limit(1000),
    getEnrichmentQueueStats(),
    getLifecycleCounts(),
    createAdminClient<ScraperJobsDatabase>().from("scraper_jobs").select("duplicate_count"),
  ]);

  if (totalResult.error || analyzedResult.error || todayResult.error) {
    console.error("[inventory-dashboard] Failed to fetch stats:", {
      totalError: totalResult.error,
      analyzedError: analyzedResult.error,
      todayError: todayResult.error,
    });
    return { stats: EMPTY_STATS, error: "Failed to load inventory stats." };
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
      totalInventory: totalResult.count ?? 0,
      targetInventory: TARGET_INVENTORY_SIZE,
      aiAnalyzedCount: analyzedResult.count ?? 0,
      pendingAiJobs: queueStats.pending,
      processingAiJobs: queueStats.processing,
      failedAiJobs: queueStats.failed,
      averageQualityScore: averageQualityScore != null ? Math.round(averageQualityScore * 100) / 100 : null,
      newListingsToday: todayResult.count ?? 0,
      expiredListings: lifecycle.expired,
      duplicatesPreventedAtScrapeTime,
    },
  };
}
