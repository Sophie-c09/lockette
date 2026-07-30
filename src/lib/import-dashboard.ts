"use server";

// Read-only stats for /admin/import — visibility only, no scraper/import
// logic lives here. "Last import time" is derived from listings.created_at
// rather than a dedicated column: every row in this table is created by
// an import (single-URL or bulk), so the most recent created_at already
// is the last import time, with no new column needed.
import { createClient } from "@/lib/supabase/server";
import { isCurrentUserAdmin } from "@/lib/admin";

export interface ImportDashboardStats {
  // Since the "scraped listings go live automatically" ingestion change,
  // this counts 'flagged' listings (the new review state) rather than
  // 'pending' — see src/lib/inventory/listing-flagging.ts.
  flaggedCount: number;
  activeCount: number;
  lastImportAt: string | null;
}

const EMPTY_STATS: ImportDashboardStats = {
  flaggedCount: 0,
  activeCount: 0,
  lastImportAt: null,
};

export async function getImportDashboardStats(): Promise<{
  stats: ImportDashboardStats;
  error?: string;
}> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user || !(await isCurrentUserAdmin(supabase, user.id))) {
    return { stats: EMPTY_STATS, error: "Not authorized." };
  }

  const [flaggedResult, activeResult, lastImportResult] = await Promise.all([
    supabase.from("listings").select("id", { count: "exact", head: true }).eq("status", "flagged"),
    supabase.from("listings").select("id", { count: "exact", head: true }).eq("status", "active"),
    supabase.from("listings").select("created_at").order("created_at", { ascending: false }).limit(1).maybeSingle(),
  ]);

  if (flaggedResult.error || activeResult.error || lastImportResult.error) {
    console.error("[import-dashboard] Failed to fetch stats:", {
      flaggedError: flaggedResult.error,
      activeError: activeResult.error,
      lastImportError: lastImportResult.error,
    });
    return { stats: EMPTY_STATS, error: "Failed to load import stats." };
  }

  return {
    stats: {
      flaggedCount: flaggedResult.count ?? 0,
      activeCount: activeResult.count ?? 0,
      lastImportAt: lastImportResult.data?.created_at ?? null,
    },
  };
}
