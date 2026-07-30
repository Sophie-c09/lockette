// Discovery redesign requirement 6 — live-only dashboard numbers that
// don't belong as scraper_jobs columns: extraction queue depth
// (scraper_url_queue's own pending count) and per-platform marketplace
// health (in-memory, process-local — see marketplace-health.ts) are both
// already live/queryable on demand, so this route just reads them
// straight through rather than adding a persistence + tiered-fallback
// path for data that's never stale by more than one poll interval.
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isCurrentUserAdmin } from "@/lib/admin";
import { getUrlQueueStats } from "@/lib/inventory/url-queue";
import { getAllMarketplaceHealth } from "@/lib/inventory/marketplace-health";
import { DISCOVERY_CONCURRENCY } from "@/lib/inventory/scaled-discovery";
import { MAX_EXTRACTION_CONCURRENCY } from "@/lib/admin-scraper";
import { OVERNIGHT_AGGRESSIVE_CONFIG } from "@/lib/scraper-config";

export async function GET(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user || !(await isCurrentUserAdmin(supabase, user.id))) {
    return NextResponse.json({ error: "Not authorized." }, { status: 401 });
  }

  const aggressive = new URL(request.url).searchParams.get("aggressive") === "true";
  const queueStats = await getUrlQueueStats();

  return NextResponse.json({
    extractionQueueDepth: queueStats.pending,
    extractionQueueClaimed: queueStats.claimed,
    // Reflects the real global cap now — scaled-discovery.ts's crawlPlatform
    // gates every individual page-search attempt through ONE process-wide
    // DISCOVERY_CONCURRENCY semaphore regardless of platform count, replacing
    // the old (and, per a live incident, dangerously wrong) 3-platforms x
    // 5-per-platform = 15 formula.
    activeDiscoveryWorkers: aggressive ? DISCOVERY_CONCURRENCY : 0,
    // Same configured ceiling admin-scraper.ts's own computeDashboardMetrics
    // reports mid-run — a live count isn't tracked here since extraction
    // workers are spawned per-batch inside the scraper run itself, not by
    // this polling route.
    activeExtractionWorkers: aggressive
      ? OVERNIGHT_AGGRESSIVE_CONFIG.extractionWorkers
      : MAX_EXTRACTION_CONCURRENCY,
    marketplaceHealth: getAllMarketplaceHealth(),
  });
}
