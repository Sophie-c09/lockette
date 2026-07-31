// Discovery redesign requirement 6 — live-only dashboard numbers that
// don't belong as scraper_jobs columns: extraction queue depth
// (scraper_url_queue's own pending count) and per-platform marketplace
// health (in-memory, process-local — see marketplace-health.ts) are both
// already live/queryable on demand, so this route just reads them
// straight through rather than adding a persistence + tiered-fallback
// path for data that's never stale by more than one poll interval.
//
// Inventory Growth "Next.js HTML 500 error page" root cause: this route
// used to import DISCOVERY_CONCURRENCY from "@/lib/inventory/scaled-discovery"
// and MAX_EXTRACTION_CONCURRENCY from "@/lib/admin-scraper" — both of
// which transitively import Playwright (browser-concurrency.ts,
// extraction/browser-extractor.ts, marketplace-discovery.ts, and
// scaled-discovery.ts itself) — the exact same "native-binary package
// pulled into a real request path" issue already fixed once for this
// route's own sibling /api/admin-scraper/large-scale start/resume route
// (see that route's own header comment), just never applied here. This
// route is polled every JOB_POLL_INTERVAL_MS (2s) for as long as
// Inventory Growth stays open — far more often than the one-shot start/
// resume calls — and on top of the heavy import, had NO try/catch at
// all, so any resulting failure propagated as an uncaught exception
// straight into Next's own generic HTML error page (the
// `<html id="__next_error__">` document, not this route's JSON), which
// is exactly what the frontend's fetch then failed to parse. Both
// constants now live in scraper-config.ts — a plain, zero-import file —
// so this route no longer needs either heavy module just to read a
// number, and the whole handler is wrapped so it always returns
// NextResponse.json regardless of what goes wrong.
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isCurrentUserAdmin } from "@/lib/admin";
import { getUrlQueueStats } from "@/lib/inventory/url-queue";
import { getAllMarketplaceHealth } from "@/lib/inventory/marketplace-health";
import { DISCOVERY_CONCURRENCY, MAX_EXTRACTION_CONCURRENCY, OVERNIGHT_AGGRESSIVE_CONFIG } from "@/lib/scraper-config";

function sanitizedErrorResponse(details: string, status: number) {
  return NextResponse.json(
    { error: "Failed to load Inventory Growth metrics", code: "INVENTORY_GROWTH_METRICS_FAILED", details },
    { status },
  );
}

export async function GET(request: Request) {
  const routeName = "admin-scraper/large-scale/metrics";

  try {
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
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected server error.";
    console.error(`[${routeName}] Uncaught error in GET handler`, {
      message,
      stack: error instanceof Error ? error.stack : undefined,
    });
    return sanitizedErrorResponse(message, 500);
  }
}
