"use client";

import { useEffect, useRef, useState } from "react";
import { CheckCircle2, Loader2, XCircle } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { getImportDashboardStats, type ImportDashboardStats } from "@/lib/import-dashboard";
import type { CategoryCounts, PriceMode } from "@/lib/bulk-import";
import { SELECTED_CATEGORY_OPTIONS, type SelectedCategory } from "@/lib/selected-categories";
import { SELECTED_BRAND_OPTIONS } from "@/lib/selected-brands";
import { SCRAPER_CONFIG, TARGET_INVENTORY_SIZE, BATCH_SIZE, type ScraperMode } from "@/lib/scraper-config";
import { getScraperJobStatus, pauseScraperJob } from "@/app/actions/admin-scraper";
import { getInventoryIntelligenceStats, type InventoryIntelligenceStats } from "@/app/actions/inventory-dashboard";
import type { ScraperJobRow } from "@/lib/scraper-jobs";
import { parseApiResponse } from "@/lib/api-response";

type Phase = "idle" | "importing" | "done";

// Human-readable explanation per finished-but-short scraper job status —
// the scraper is no longer time-boxed (it keeps running rounds until the
// requested count is reached), so a shortfall on a "completed" job always
// means it ran out of new inventory/hit a safety limit, not "ran out of
// time." A "failed" job instead carries its own error_message from the
// job row itself.
const SHORTFALL_MESSAGE =
  "Some rounds found nothing new, or a safety limit was hit, before the full request could be filled — check the server logs for the exact stop reason, or just run it again to keep collecting.";

// How often the admin UI polls getScraperJobStatus while a scrape is
// queued/running — short enough to feel live, long enough not to hammer
// the DB for a job that can run for minutes. NotificationBell.tsx's own
// 30s poll is for a much lower-urgency background check; a job the admin
// is actively watching warrants a tighter interval.
const JOB_POLL_INTERVAL_MS = 2000;

// Client-side last resort for triggerLargeScaleProcessBatch's fetch() call
// — see that function's own comment. Set above process-batch's own 60s
// maxDuration (with margin for real network latency) so this only ever
// fires for a genuinely hung connection, never racing an ordinary slow
// response.
const LARGE_SCALE_PROCESS_BATCH_TIMEOUT_MS = 75_000;

// If a "running" job's own heartbeat hasn't moved in this long, treat it
// as stalled rather than showing an indefinite spinner — this exact
// scenario (a job stuck at status='running' forever with no way to tell
// from the UI whether it's actually still working) is the bug this admin
// panel was rebuilt to surface. A single round can legitimately take a
// couple of minutes on a big request, so this is set well above that.
const STALE_JOB_THRESHOLD_MS = 5 * 60 * 1000;

function isJobStale(job: ScraperJobRow): boolean {
  const lastSignal = job.last_heartbeat ?? job.updated_at ?? job.created_at;
  return Date.now() - new Date(lastSignal).getTime() > STALE_JOB_THRESHOLD_MS;
}

// Persisted so a page refresh (or reopening the tab) resumes watching the
// SAME in-progress job instead of losing track of it — the whole point of
// this feature is that a scrape survives the admin leaving the page.
const STYLE_JOB_STORAGE_KEY = "reworn-admin-style-scraper-job-id";

// Same resume-after-refresh reasoning as STYLE_JOB_STORAGE_KEY above, kept
// as its own key so a Continuous Import run and a Style-Aware Scraper run
// can each be resumed independently.
const CONTINUOUS_JOB_STORAGE_KEY = "reworn-admin-continuous-import-job-id";

// Bulk-import ("Import N Listings") flow — separate from the manual
// paste-a-list-of-URLs flow above/below it, since it needs no input at
// all: it finds its own candidate URLs (src/lib/marketplace-discovery.ts)
// rather than requiring the admin to supply any.
type BulkPhase = "idle" | "discovering" | "importing" | "done";

// The three sizes admin can choose from — every listing still goes
// through the exact same discovery/extraction/classification/tagging
// pipeline (src/lib/bulk-import.ts, untouched by this control panel);
// this only changes how many the client asks for.
const BULK_IMPORT_SIZES = [25, 100, 500] as const;
// Imports at or above this size show the AI-processing-time warning
// before starting — 25 is quick enough not to need it.
const LARGE_IMPORT_THRESHOLD = 100;
const LARGE_IMPORT_WARNING =
  "Large imports may take several minutes because every listing is processed through AI classification and image tagging.";

// "25 listings per database insert" (see src/lib/bulk-import.ts) is also
// the unit of work this client sends per request — each process-batch
// call only has to survive ~25 listings' worth of extraction+AI work,
// not the whole run, and it's what lets the "Imported N/target" counter
// below advance in visible steps instead of jumping straight to the end.
const BULK_CHUNK_SIZE = 25;

// Options for the Price Mode control — "Under $10" matches Lockette's
// affordable-thrift-find identity, so it's the default rather than "Any".
const PRICE_MODE_OPTIONS: { value: PriceMode; label: string }[] = [
  { value: "under10", label: "Under $10" },
  { value: "under20", label: "Under $20" },
  { value: "any", label: "Any price" },
];

// Cheap listings have a higher failure + duplicate rate (more crossposted/
// resold items, more listings that turn out to already be sold) — a
// strict "Under $10" run asks discovery for proportionally more candidates
// up front than the standard 1.5x buffer so the actual imported count
// still lands close to the requested size.
function discoveryBufferMultiplier(priceMode: PriceMode): number {
  return priceMode === "under10" ? 2.0 : 1.5;
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

function formatLastImport(lastImportAt: string | null): string {
  if (!lastImportAt) return "Never";
  return new Date(lastImportAt).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

interface ImportResult {
  url: string;
  status: "success" | "error";
  message: string;
}

function parseUrls(raw: string): string[] {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

// "starting" covers the brief create-job request itself; "running" covers
// both the job's own 'queued' and 'running' statuses, since from the
// admin's perspective there's nothing actionable to distinguish between
// them (queueing happens essentially instantly — see the run route's own
// comment on why).
type StylePhase = "idle" | "starting" | "running" | "done";

// Same shape as StylePhase — Continuous Import polls the exact same job
// row via the exact same endpoint (/api/admin-scraper/run, which already
// runs runContinuousAdminScraper server-side — see that route's own
// comment), just kept as its own type/state so this feature doesn't share
// mutable state with the separate Style-Aware Scraper card above it.
type ContinuousPhase = "idle" | "starting" | "running" | "done";

// This feature's own category vocabulary — distinct from
// SELECTED_CATEGORY_OPTIONS (the existing bulk-import's search-term
// selection above), matching src/lib/admin-scraper-filter.ts's
// substring-match approach against the real `listings.category` text.
const STYLE_CATEGORY_OPTIONS = ["tops", "skirts", "jeans", "dresses", "sweaters"] as const;

// Vinted/Depop/Poshmark are the only real sources discoverListingUrls
// ever crawls (Grailed was removed entirely — see marketplace-discovery.ts) —
// SCRAPER_CONFIG.allowedSources defaults to the first two, but all three
// are real, toggleable options here.
const STYLE_SOURCE_OPTIONS = ["vinted", "depop", "poshmark"] as const;
const STYLE_LIMIT_OPTIONS = [10, 25, 50, 100] as const;

// Runs the single-URL pipeline for one URL via a single fetch() call —
// /api/import-listing now does extraction, classification, AND the
// Supabase write server-side, in one request. This client component calls
// only that route; it never calls a Server Action directly (that used to
// happen via a separate saveListing action called in this same loop,
// which caused a "Cannot read properties of undefined (reading 'apply')"
// runtime error — see the route handler for the full explanation). Never
// throws: every failure mode becomes an ImportResult so the bulk loop
// below can always move on to the next URL (requirement 6).
async function importOneUrl(url: string): Promise<ImportResult> {
  try {
    const response = await fetch("/api/import-listing", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });
    const data = await response.json();

    if (!response.ok || !data.success) {
      throw new Error(data.error ?? "Failed to import this listing.");
    }

    return {
      url,
      status: "success",
      message: data.data?.title ?? "Imported",
    };
  } catch (err) {
    return {
      url,
      status: "error",
      message:
        err instanceof Error ? err.message : "Failed to import this listing.",
    };
  }
}

export function ImportListingView({ initialStats }: { initialStats: ImportDashboardStats }) {
  const [rawUrls, setRawUrls] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [results, setResults] = useState<ImportResult[]>([]);
  const [total, setTotal] = useState(0);
  const [formError, setFormError] = useState<string | null>(null);

  const [stats, setStats] = useState(initialStats);

  // Part 13 — Inventory Intelligence dashboard. Client-fetched on mount
  // (rather than threaded through as a page-level prop like `stats`
  // above) so this addition doesn't require changing this component's
  // existing props contract or the admin page that renders it.
  const [inventoryStats, setInventoryStats] = useState<InventoryIntelligenceStats | null>(null);
  const [inventoryStatsLoading, setInventoryStatsLoading] = useState(true);

  // The mount effect below inlines its own .then()/.catch() rather than
  // calling a named async function — the stricter react-hooks lint rule
  // flags ANY function reference invoked from an effect body that
  // contains a setState call anywhere inside it, even after an await, so
  // only a directly-inlined promise chain (setState calls living inside
  // the .then()/.catch() callbacks themselves) satisfies it. Same fix
  // shape as BundleOutfitView.tsx's ItemSidePanel effect from earlier
  // this session.
  useEffect(() => {
    let cancelled = false;

    getInventoryIntelligenceStats()
      .then((result) => {
        if (cancelled) return;
        setInventoryStats(result.stats);
        setInventoryStatsLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        console.error("Failed to load inventory intelligence stats:", err);
        setInventoryStatsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  // Used by the manual "Refresh" button (a click handler, not an effect)
  // — safe to eagerly flip loading back to true here since this only
  // ever runs in response to a user action, and to call an async helper
  // that itself sets state, since that restriction is specific to effects.
  async function refreshInventoryStats() {
    setInventoryStatsLoading(true);
    try {
      const result = await getInventoryIntelligenceStats();
      setInventoryStats(result.stats);
    } catch (err) {
      console.error("Failed to load inventory intelligence stats:", err);
    } finally {
      setInventoryStatsLoading(false);
    }
  }

  const [indexerTriggering, setIndexerTriggering] = useState(false);
  const [backfillTriggering, setBackfillTriggering] = useState(false);

  // Fire-and-forget — the route itself runs the actual round via after()
  // (see src/app/api/inventory/index/route.ts's own header comment), so
  // this just starts it and gives the stats a moment to catch up.
  async function handleRunIndexingRound() {
    setIndexerTriggering(true);
    try {
      await fetch("/api/inventory/index", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      setTimeout(refreshInventoryStats, 5000);
    } catch (err) {
      console.error("Failed to start indexing round:", err);
    } finally {
      setIndexerTriggering(false);
    }
  }

  // Same fire-and-forget shape, `fullBackfill: true` — loops the same
  // bounded stages server-side (runFullInventoryEmbeddingBackfill) until
  // the whole catalog actually has embeddings, instead of requiring one
  // click per bounded batch. Stats refresh is delayed longer since a full
  // backfill genuinely takes a while (many rounds of real AI calls).
  async function handleRunFullBackfill() {
    setBackfillTriggering(true);
    try {
      await fetch("/api/inventory/index", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fullBackfill: true }),
      });
      setTimeout(refreshInventoryStats, 5000);
    } catch (err) {
      console.error("Failed to start full backfill:", err);
    } finally {
      setBackfillTriggering(false);
    }
  }

  const [bulkPhase, setBulkPhase] = useState<BulkPhase>("idle");
  const [bulkTarget, setBulkTarget] = useState<number>(BULK_IMPORT_SIZES[0]);
  const [priceMode, setPriceMode] = useState<PriceMode>("under10");
  // Empty = no filter ("behave as current system" — section 8): every
  // category is fetched/considered, same as before this feature existed.
  const [selectedCategories, setSelectedCategories] = useState<SelectedCategory[]>([]);
  // Brand Filters (Abercrombie/Hollister/American Eagle) — empty = no
  // filter (Fallback: "behave normally"). Plain string[], matching this
  // feature's own state-shape spec exactly (values only ever come from
  // toggling one of SELECTED_BRAND_OPTIONS' buttons, never free text).
  const [selectedBrands, setSelectedBrands] = useState<string[]>([]);
  const [bulkImported, setBulkImported] = useState(0);
  const [bulkFailed, setBulkFailed] = useState(0);
  const [bulkDuplicates, setBulkDuplicates] = useState(0);
  const [bulkPriceRejected, setBulkPriceRejected] = useState(0);
  const [bulkCategoryRejected, setBulkCategoryRejected] = useState(0);
  const [bulkBrandRejected, setBulkBrandRejected] = useState(0);
  const [bulkQualityRejected, setBulkQualityRejected] = useState(0);
  const [bulkError, setBulkError] = useState<string | null>(null);

  // Style-Aware Admin Scraper — a separate tool from the bulk-import flow
  // above, seeded from SCRAPER_CONFIG's defaults but fully admin-editable
  // before each run (see src/app/actions/admin-scraper.ts's own comment
  // on why SCRAPER_CONFIG itself is never read at request time).
  const [stylePhase, setStylePhase] = useState<StylePhase>("idle");
  const [styleMaxPrice, setStyleMaxPrice] = useState(SCRAPER_CONFIG.maxPrice);
  const [styleLimit, setStyleLimit] = useState<number>(SCRAPER_CONFIG.limit);
  const [styleSources, setStyleSources] = useState<string[]>(SCRAPER_CONFIG.allowedSources);
  const [styleCategories, setStyleCategories] = useState<string[]>([]);
  const [styleBrands, setStyleBrands] = useState<string[]>([]);
  const [styleJob, setStyleJob] = useState<ScraperJobRow | null>(null);
  const [styleError, setStyleError] = useState<string | null>(null);
  const stylePollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Counts CONSECUTIVE failed polls — the background scrape itself runs
  // via a service-role client inside after() (see
  // /api/admin-scraper/run/route.ts) entirely independently of this
  // admin's own browser session, so a single getScraperJobStatus call
  // failing (most commonly: the session cookie expiring during a long
  // run — this poll is the ONLY session-dependent part of the whole
  // feature) does NOT mean the scrape itself failed. Giving up on the
  // very first failure was confirmed to misreport a run that had
  // actually already finished successfully (50/50 inserted) as
  // "Not authorized," which reads exactly like a broken import even
  // though nothing about the import was broken.
  const stylePollFailuresRef = useRef(0);
  const MAX_CONSECUTIVE_POLL_FAILURES = 3;

  function stopStylePolling() {
    if (stylePollRef.current) {
      clearInterval(stylePollRef.current);
      stylePollRef.current = null;
    }
  }

  // Continuous Import — same job-polling mechanism as the Style-Aware
  // Scraper above (same getScraperJobStatus, same /api/admin-scraper/run
  // endpoint, which already runs runContinuousAdminScraper server-side),
  // kept as its own state/ref/storage-key so the two cards can each be
  // running (and independently resumed after a refresh) at once.
  const [continuousPhase, setContinuousPhase] = useState<ContinuousPhase>("idle");
  const [continuousJob, setContinuousJob] = useState<ScraperJobRow | null>(null);
  const [continuousError, setContinuousError] = useState<string | null>(null);
  const continuousPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const continuousPollFailuresRef = useRef(0);

  function stopContinuousPolling() {
    if (continuousPollRef.current) {
      clearInterval(continuousPollRef.current);
      continuousPollRef.current = null;
    }
  }

  // One poll tick, shared by both the interval below and the resume-on-mount
  // effect — fetches the job row and reacts to a terminal status by
  // stopping the interval and refreshing the pending/active counts, same
  // as the old one-shot runStyleAwareScrape used to do on its own return.
  async function pollStyleJob(jobId: string) {
    const { job, error } = await getScraperJobStatus(jobId);

    if (error || !job) {
      stylePollFailuresRef.current += 1;
      if (stylePollFailuresRef.current < MAX_CONSECUTIVE_POLL_FAILURES) {
        // Ride out a transient blip (a network hiccup, a token-refresh
        // race) rather than treating one failed poll as the end of the
        // world — see this state's own comment above.
        return;
      }

      stopStylePolling();
      setStyleError(
        error === "Not authorized."
          ? "Lost track of this job because your admin session expired while it ran in the background — " +
              "the scrape itself is unaffected (it doesn't depend on your session) and may already be done. " +
              "Check /admin/listings for new pending listings, or sign back in and reopen this page to keep watching."
          : (error ?? "Lost track of the running scraper job."),
      );
      setStylePhase("idle");
      window.localStorage.removeItem(STYLE_JOB_STORAGE_KEY);
      return;
    }

    stylePollFailuresRef.current = 0;
    setStyleJob(job);

    if (job.status === "completed" || job.status === "failed") {
      stopStylePolling();
      setStylePhase("done");
      window.localStorage.removeItem(STYLE_JOB_STORAGE_KEY);
      refreshStats();
    } else {
      setStylePhase("running");
    }
  }

  function startStylePolling(jobId: string) {
    stopStylePolling();
    stylePollFailuresRef.current = 0;
    pollStyleJob(jobId);
    stylePollRef.current = setInterval(() => pollStyleJob(jobId), JOB_POLL_INTERVAL_MS);
  }

  // Resume watching an in-progress job after a page refresh/reopen — the
  // whole point of moving this to a background job is that leaving the
  // page doesn't lose the scrape, so reopening the admin panel should
  // reconnect to it rather than showing a blank "idle" form.
  useEffect(() => {
    const storedJobId = window.localStorage.getItem(STYLE_JOB_STORAGE_KEY);
    if (!storedJobId) return;

    // Deferred via setTimeout (same "don't call the setState-triggering
    // work synchronously inside the effect body" shape as
    // NotificationBell.tsx's own setInterval(async () => ...) poll) —
    // pollStyleJob itself sets stylePhase/styleJob once its fetch resolves.
    const timeoutId = setTimeout(() => startStylePolling(storedJobId), 0);

    return () => {
      clearTimeout(timeoutId);
      stopStylePolling();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once on mount only
  }, []);

  // Same poll-tick shape as pollStyleJob above — reused rather than shared
  // because the two cards track entirely separate jobs/phases.
  async function pollContinuousJob(jobId: string) {
    const { job, error } = await getScraperJobStatus(jobId);

    if (error || !job) {
      continuousPollFailuresRef.current += 1;
      if (continuousPollFailuresRef.current < MAX_CONSECUTIVE_POLL_FAILURES) {
        return;
      }

      stopContinuousPolling();
      setContinuousError(
        error === "Not authorized."
          ? "Lost track of this job because your admin session expired while it ran in the background — " +
              "the import itself is unaffected (it doesn't depend on your session) and may still be running. " +
              "Check /admin/listings for new pending listings, or sign back in and reopen this page to keep watching."
          : (error ?? "Lost track of the running continuous import job."),
      );
      setContinuousPhase("idle");
      window.localStorage.removeItem(CONTINUOUS_JOB_STORAGE_KEY);
      return;
    }

    continuousPollFailuresRef.current = 0;
    setContinuousJob(job);

    if (job.status === "completed" || job.status === "failed") {
      stopContinuousPolling();
      setContinuousPhase("done");
      window.localStorage.removeItem(CONTINUOUS_JOB_STORAGE_KEY);
      refreshStats();
    } else {
      setContinuousPhase("running");
    }
  }

  function startContinuousPolling(jobId: string) {
    stopContinuousPolling();
    continuousPollFailuresRef.current = 0;
    pollContinuousJob(jobId);
    continuousPollRef.current = setInterval(() => pollContinuousJob(jobId), JOB_POLL_INTERVAL_MS);
  }

  // Resume watching an in-progress Continuous Import job after a page
  // refresh/reopen — same reasoning as the Style-Aware Scraper's own
  // resume effect above.
  useEffect(() => {
    const storedJobId = window.localStorage.getItem(CONTINUOUS_JOB_STORAGE_KEY);
    if (!storedJobId) return;

    const timeoutId = setTimeout(() => startContinuousPolling(storedJobId), 0);

    return () => {
      clearTimeout(timeoutId);
      stopContinuousPolling();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once on mount only
  }, []);

  // Inventory Growth — large-scale continuous ingestion
  // (/api/admin-scraper/large-scale, src/lib/admin-scraper.ts's
  // runLargeScaleAdminScraper). Same job-polling mechanism as the two
  // cards above, kept as its own state/ref/storage-key so all three can
  // run (and each be independently resumed after a refresh) at once.
  // 'paused' is its own phase, distinct from 'running' — a paused job
  // keeps being polled (in case an admin resumes it from another tab) but
  // shows a Resume button instead of a spinner.
  type LargeScalePhase = "idle" | "starting" | "running" | "paused" | "done";
  const [largeScalePhase, setLargeScalePhase] = useState<LargeScalePhase>("idle");
  const [largeScaleTarget, setLargeScaleTarget] = useState<number>(TARGET_INVENTORY_SIZE);
  const [largeScaleBatchSize, setLargeScaleBatchSize] = useState<number>(BATCH_SIZE);
  const [largeScaleMode, setLargeScaleMode] = useState<ScraperMode>("quality");
  // OVERNIGHT_MODE (src/lib/scraper-config.ts) — a run-continuation
  // setting distinct from largeScaleMode above (AI-enrichment depth per
  // candidate): "runs continuously... does not stop after fixed batches."
  // Every real stop condition (target reached, paused, too many
  // consecutive failures) is unaffected — see route.ts's own comment.
  const [largeScaleOvernightMode, setLargeScaleOvernightMode] = useState(false);
  // OVERNIGHT_AGGRESSIVE (discovery redesign) — orthogonal to overnight
  // mode above (that's "how long," this is "how each batch acquires").
  const [largeScaleAggressiveMode, setLargeScaleAggressiveMode] = useState(false);
  const [largeScaleJob, setLargeScaleJob] = useState<ScraperJobRow | null>(null);
  // Discovery redesign requirement 6 — live-only numbers fetched
  // separately from the job row itself (see the metrics route's own
  // comment on why these aren't scraper_jobs columns). Best-effort: a
  // failed fetch just leaves the last-known values on screen rather than
  // interrupting the job poll above.
  const [largeScaleLiveMetrics, setLargeScaleLiveMetrics] = useState<{
    extractionQueueDepth: number;
    // P0 launch-readiness dashboard fix — both already computed/returned by
    // the metrics route (extractionQueueClaimed was already in its
    // response; permanentlyFailedUrlCount is new), but neither was ever
    // read into this dashboard's own state before now.
    extractionQueueClaimed: number;
    permanentlyFailedUrlCount: number;
    activeDiscoveryWorkers: number;
    activeExtractionWorkers: number;
    marketplaceHealth: { platform: string; attempts: number; successRate: number; timeoutRate: number; avgLatencyMs: number; enabled: boolean }[];
  } | null>(null);
  const [largeScaleError, setLargeScaleError] = useState<string | null>(null);
  const [largeScalePausing, setLargeScalePausing] = useState(false);
  const [largeScaleResuming, setLargeScaleResuming] = useState(false);
  const largeScalePollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const largeScalePollFailuresRef = useRef(0);
  // Guards against overlapping process-batch calls — a batch can take up
  // to that route's own maxDuration (well longer than JOB_POLL_INTERVAL_MS),
  // so without this, every poll tick while one is still in flight would
  // fire a redundant second call for the same job.
  const largeScaleBatchInFlightRef = useRef(false);
  // Requirement 4 — "the frontend must select the correct currently active
  // job." clearInterval only stops FUTURE ticks; it can't cancel a
  // getScraperJobStatus call already in flight (e.g. the mount-effect's
  // resume-on-load poll for whatever job id was last in localStorage). If
  // that old, in-flight poll's promise resolves AFTER a fresh Start/Resume
  // has already begun tracking a different job, its setLargeScaleJob/
  // setLargeScalePhase calls would silently overwrite the new job's real
  // state with a stale (possibly already-paused) job's — exactly what
  // would make a brand-new run look like it "immediately paused itself."
  // This ref is the single source of truth for "which job id do we
  // actually care about right now"; every poll tick checks it before
  // touching any state.
  const largeScaleActiveJobIdRef = useRef<string | null>(null);
  const LARGE_SCALE_JOB_STORAGE_KEY = "reworn-admin-large-scale-job-id";

  function stopLargeScalePolling() {
    if (largeScalePollRef.current) {
      clearInterval(largeScalePollRef.current);
      largeScalePollRef.current = null;
    }
  }

  // Architecture fix — Inventory Growth no longer runs the whole scraper
  // inside the Start request (see the API route's own header comment for
  // why: that used to crash production outright, and could never survive
  // a multi-hour run on Vercel regardless). This is the "keep going" half:
  // as long as the dashboard stays open and the job is queued/running,
  // each poll tick (pollLargeScaleJob below) also asks the server to run
  // ONE more bounded batch, entirely independent of the job-status poll
  // itself — a failed/slow batch call never blocks or breaks polling.
  // "Stuck at 0/50,000 with no visible error" root cause (server side):
  // process-batch's own maxDuration/watchdog mismatch meant Vercel could
  // silently kill that request with no response ever coming back — see
  // that route's own comment. Belt-and-suspenders on the client too:
  // fetch() has NO default timeout, so a genuinely hung connection (a
  // dropped/never-acknowledged TCP session, not just a slow server)
  // would leave largeScaleBatchInFlightRef stuck true forever, silently
  // blocking every future poll tick's attempt to trigger a batch — this
  // is what actually made that failure mode PERMANENT rather than
  // "delayed until the next successful call." LARGE_SCALE_PROCESS_BATCH_TIMEOUT_MS
  // is set comfortably ABOVE process-batch's own 60s maxDuration so this
  // never races the server's own, now-much-more-likely-to-succeed
  // response — it only ever fires as a true last resort.
  async function triggerLargeScaleProcessBatch(jobId: string) {
    if (largeScaleBatchInFlightRef.current) return;
    largeScaleBatchInFlightRef.current = true;

    const abortController = new AbortController();
    const timeoutId = setTimeout(() => abortController.abort(), LARGE_SCALE_PROCESS_BATCH_TIMEOUT_MS);

    try {
      const response = await fetch("/api/admin-scraper/large-scale/process-batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId }),
        signal: abortController.signal,
      });
      await parseApiResponse(response, "Inventory Growth");
    } catch (err) {
      // Not surfaced as largeScaleError — a single failed batch call
      // shouldn't interrupt the dashboard; the job's own polled status
      // already reflects a real terminal failure (failScraperJob sets
      // status: 'failed' server-side), which the status poll below
      // handles on its own.
      console.error("[large-scale] process-batch call failed:", err);
    } finally {
      clearTimeout(timeoutId);
      largeScaleBatchInFlightRef.current = false;
    }
  }

  async function pollLargeScaleJob(jobId: string) {
    const { job, error } = await getScraperJobStatus(jobId);

    // See largeScaleActiveJobIdRef's own comment — this call may have been
    // in flight for an old job (or overtaken by a newer poll for the SAME
    // job) by the time it resolves; only the poll for whatever job is
    // CURRENTLY tracked is allowed to update state.
    if (largeScaleActiveJobIdRef.current !== jobId) return;

    if (error || !job) {
      largeScalePollFailuresRef.current += 1;
      if (largeScalePollFailuresRef.current < MAX_CONSECUTIVE_POLL_FAILURES) return;

      stopLargeScalePolling();
      largeScaleActiveJobIdRef.current = null;
      setLargeScaleError(
        error === "Not authorized."
          ? "Lost track of this job because your admin session expired while it ran in the background — " +
              "the run itself is unaffected and may still be going. Check /admin/listings for new pending " +
              "listings, or sign back in and reopen this page to keep watching."
          : (error ?? "Lost track of the running large-scale job."),
      );
      setLargeScalePhase("idle");
      window.localStorage.removeItem(LARGE_SCALE_JOB_STORAGE_KEY);
      return;
    }

    largeScalePollFailuresRef.current = 0;
    setLargeScaleJob(job);

    if (job.status === "completed" || job.status === "failed") {
      stopLargeScalePolling();
      largeScaleActiveJobIdRef.current = null;
      setLargeScalePhase("done");
      window.localStorage.removeItem(LARGE_SCALE_JOB_STORAGE_KEY);
      refreshStats();
      // Inventory count display fix — the "done" card below shows the
      // real current total (inventoryStats.totalInventory), not just this
      // run's own inserted_count, so it must be fresh the moment a run
      // finishes rather than whatever it was on page load/last manual
      // "Refresh" click.
      void refreshInventoryStats();
    } else if (job.status === "paused") {
      setLargeScalePhase("paused");
    } else {
      setLargeScalePhase("running");
      // 'pending' or 'running' — keep the job actually moving. Fire-and-
      // forget: this must never block the status poll's own cadence, and
      // the in-flight guard above keeps a slow batch from overlapping
      // with the next poll tick.
      void triggerLargeScaleProcessBatch(jobId);
    }

    try {
      const metricsResponse = await fetch(
        `/api/admin-scraper/large-scale/metrics?aggressive=${largeScaleAggressiveMode}`,
      );
      if (metricsResponse.ok) setLargeScaleLiveMetrics(await metricsResponse.json());
    } catch {
      // Best-effort — see this state's own comment.
    }
  }

  function startLargeScalePolling(jobId: string) {
    stopLargeScalePolling();
    largeScaleActiveJobIdRef.current = jobId;
    largeScalePollFailuresRef.current = 0;
    pollLargeScaleJob(jobId);
    largeScalePollRef.current = setInterval(() => pollLargeScaleJob(jobId), JOB_POLL_INTERVAL_MS);
  }

  useEffect(() => {
    const storedJobId = window.localStorage.getItem(LARGE_SCALE_JOB_STORAGE_KEY);
    if (!storedJobId) return;

    const timeoutId = setTimeout(() => startLargeScalePolling(storedJobId), 0);

    return () => {
      clearTimeout(timeoutId);
      stopLargeScalePolling();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once on mount only
  }, []);

  async function handleStartLargeScale() {
    // Prevent-meaningless-runs fix — defensive re-check even though the
    // button above is already disabled for this case; the server route
    // enforces the same rule (TARGET_ALREADY_MET) regardless, so this is
    // purely to avoid a network round-trip for a request that's already
    // known to be pointless.
    if (inventoryStats?.totalInventory != null && largeScaleTarget <= inventoryStats.totalInventory) {
      setLargeScaleError("Your inventory already exceeds this target. Enter a target above the current total.");
      return;
    }

    setLargeScalePhase("starting");
    setLargeScaleError(null);
    setLargeScaleJob(null);
    window.localStorage.removeItem(LARGE_SCALE_JOB_STORAGE_KEY);
    // Stop watching whatever job (if any) was previously tracked BEFORE
    // this request even goes out — closes the window where an old
    // in-flight poll (e.g. the mount-effect's resume-on-load poll for a
    // stale localStorage id) could resolve after this Start call and
    // stomp its state over the new job's, per largeScaleActiveJobIdRef's
    // own comment.
    stopLargeScalePolling();
    largeScaleActiveJobIdRef.current = null;

    try {
      const response = await fetch("/api/admin-scraper/large-scale", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          targetInventorySize: largeScaleTarget,
          batchSize: largeScaleBatchSize,
          mode: largeScaleMode,
          overnightMode: largeScaleOvernightMode,
          aggressiveMode: largeScaleAggressiveMode,
        }),
      });
      // Never response.json() directly — see src/lib/api-response.ts's own
      // header comment for the exact production incident (a framework-
      // level 500 HTML page, not this route's JSON) this replaced.
      const data = await parseApiResponse<{ jobId?: string; status?: string }>(response, "Inventory Growth");

      if (!data.jobId) {
        throw new Error("Failed to start large-scale ingestion.");
      }

      window.localStorage.setItem(LARGE_SCALE_JOB_STORAGE_KEY, data.jobId);
      setLargeScalePhase("running");
      startLargeScalePolling(data.jobId);
    } catch (err) {
      setLargeScaleError(err instanceof Error ? err.message : "Failed to start large-scale ingestion.");
      setLargeScalePhase("idle");
    }
  }

  async function handlePauseLargeScale() {
    if (!largeScaleJob) return;
    setLargeScalePausing(true);
    setLargeScaleError(null);

    try {
      const result = await pauseScraperJob(largeScaleJob.id);
      if (result.error) {
        setLargeScaleError(result.error);
      }
      // Poll picks up the 'paused' status on its own next tick — no local
      // phase flip here, so a batch already in flight (pause only takes
      // effect at the next batch boundary) doesn't briefly show a stale
      // "paused" state before the job row itself actually reflects it.
    } catch (err) {
      setLargeScaleError(err instanceof Error ? err.message : "Failed to pause large-scale ingestion.");
    } finally {
      // Must always run, even if pauseScraperJob throws — otherwise the
      // button gets stuck showing "Pausing..." forever (the bug being fixed
      // here).
      setLargeScalePausing(false);
    }
  }

  async function handleResumeLargeScale() {
    if (!largeScaleJob) return;
    setLargeScaleResuming(true);
    setLargeScaleError(null);

    try {
      const response = await fetch("/api/admin-scraper/large-scale", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resumeJobId: largeScaleJob.id }),
      });
      const data = await parseApiResponse<{ jobId?: string; status?: string }>(response, "Inventory Growth");

      if (!data.jobId) {
        throw new Error("Failed to resume large-scale ingestion.");
      }

      setLargeScalePhase("running");
      startLargeScalePolling(data.jobId);
    } catch (err) {
      setLargeScaleError(err instanceof Error ? err.message : "Failed to resume large-scale ingestion.");
    } finally {
      setLargeScaleResuming(false);
    }
  }

  function handleLargeScaleStartOver() {
    stopLargeScalePolling();
    largeScaleActiveJobIdRef.current = null;
    setLargeScalePhase("idle");
    setLargeScaleJob(null);
    setLargeScaleError(null);
    window.localStorage.removeItem(LARGE_SCALE_JOB_STORAGE_KEY);
  }

  // Best-effort — refreshes the pending/active/last-import numbers after
  // a run completes so they don't sit stale until the next full page
  // load. Never blocks or fails the import itself either way.
  async function refreshStats() {
    try {
      const result = await getImportDashboardStats();
      setStats(result.stats);
    } catch (err) {
      console.error("[import-dashboard] Failed to refresh stats:", err);
    }
  }

  // Discovery finds its own candidates (src/lib/marketplace-discovery.ts,
  // via /api/bulk-import/discover) — no admin-supplied list — then this
  // client drives the actual import one 25-URL chunk at a time
  // (/api/bulk-import/process-batch), so no single request has to stay
  // open for the whole multi-minute run. Never throws past this function:
  // every failure mode (discovery failing, a chunk request failing
  // outright) is caught and turned into bulkError or counted as failures,
  // same "one bad step never stops the rest" posture as importOneUrl
  // above.
  async function handleBulkImport(target: number) {
    if (target >= LARGE_IMPORT_THRESHOLD) {
      const confirmed = window.confirm(LARGE_IMPORT_WARNING);
      if (!confirmed) return;
    }

    setBulkTarget(target);
    setBulkPhase("discovering");
    setBulkImported(0);
    setBulkFailed(0);
    setBulkDuplicates(0);
    setBulkPriceRejected(0);
    setBulkCategoryRejected(0);
    setBulkBrandRejected(0);
    setBulkQualityRejected(0);
    setBulkError(null);

    // Discovery is asked for more than `target` up front, since some
    // discovered URLs will inevitably fail extraction or turn out to be
    // duplicates once processed — this buffer is what keeps the actual
    // imported count close to the requested size rather than falling short
    // every time. A strict "Under $10" run uses a bigger buffer (see
    // discoveryBufferMultiplier) since cheap listings have a higher
    // failure + duplicate rate.
    const discoveryBuffer = Math.ceil(target * discoveryBufferMultiplier(priceMode));

    let urls: string[];
    try {
      const response = await fetch("/api/bulk-import/discover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetCount: discoveryBuffer, priceMode, selectedCategories, selectedBrands }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error ?? "Failed to find listings.");
      }
      urls = Array.isArray(data.urls) ? data.urls : [];
    } catch (err) {
      setBulkError(err instanceof Error ? err.message : "Failed to find listings.");
      setBulkPhase("idle");
      return;
    }

    if (urls.length === 0) {
      setBulkError("Couldn't find any new listings right now — try again later.");
      setBulkPhase("idle");
      return;
    }

    setBulkPhase("importing");

    let imported = 0;
    let failed = 0;
    let duplicates = 0;
    let priceRejected = 0;
    let categoryRejected = 0;
    let brandRejected = 0;
    let qualityRejected = 0;
    // Threaded from one batch's response into the next batch's request so
    // processBulkImportBatch's category-balance tie-break (src/lib/bulk-import.ts)
    // is computed against the whole run's running total, not reset every
    // ~25-URL chunk.
    let categoryCounts: CategoryCounts = {};

    for (const batch of chunk(urls, BULK_CHUNK_SIZE)) {
      if (imported >= target) break;

      try {
        const response = await fetch("/api/bulk-import/process-batch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            urls: batch,
            categoryCounts,
            totalInsertedSoFar: imported,
            priceMode,
            selectedCategories,
            selectedBrands,
          }),
        });
        const data = await response.json();
        if (!response.ok) {
          throw new Error(data.error ?? "This batch failed.");
        }

        imported += data.successCount ?? 0;
        failed += data.failedCount ?? 0;
        duplicates += data.duplicateCount ?? 0;
        priceRejected += data.priceRejectedCount ?? 0;
        categoryRejected += data.categoryRejectedCount ?? 0;
        brandRejected += data.brandRejectedCount ?? 0;
        qualityRejected += data.qualityRejectedCount ?? 0;
        if (data.categoryCounts) categoryCounts = data.categoryCounts;
      } catch (err) {
        console.error("[bulk-import]", err);
        failed += batch.length;
      }

      setBulkImported(imported);
      setBulkFailed(failed);
      setBulkDuplicates(duplicates);
      setBulkPriceRejected(priceRejected);
      setBulkCategoryRejected(categoryRejected);
      setBulkBrandRejected(brandRejected);
      setBulkQualityRejected(qualityRejected);
    }

    setBulkPhase("done");
    refreshStats();
  }

  function handleBulkStartOver() {
    setBulkPhase("idle");
    setBulkImported(0);
    setBulkFailed(0);
    setBulkDuplicates(0);
    setBulkPriceRejected(0);
    setBulkCategoryRejected(0);
    setBulkBrandRejected(0);
    setBulkQualityRejected(0);
    setBulkError(null);
  }

  function toggleSelectedCategory(category: SelectedCategory) {
    setSelectedCategories((prev) =>
      prev.includes(category) ? prev.filter((entry) => entry !== category) : [...prev, category],
    );
  }

  function toggleSelectedBrand(brand: string) {
    setSelectedBrands((prev) =>
      prev.includes(brand) ? prev.filter((entry) => entry !== brand) : [...prev, brand],
    );
  }

  function toggleStyleSource(source: string) {
    setStyleSources((prev) => (prev.includes(source) ? prev.filter((entry) => entry !== source) : [...prev, source]));
  }

  function toggleStyleCategory(category: string) {
    setStyleCategories((prev) =>
      prev.includes(category) ? prev.filter((entry) => entry !== category) : [...prev, category],
    );
  }

  function toggleStyleBrand(brand: string) {
    setStyleBrands((prev) => (prev.includes(brand) ? prev.filter((entry) => entry !== brand) : [...prev, brand]));
  }

  // Creates a scraper_jobs row and returns its id immediately — the actual
  // scrape then runs via after() inside /api/admin-scraper/run, entirely
  // outside this fetch's own request/response cycle (see that route's
  // header comment). This function itself only ever waits on the quick
  // "job created" response, never the scrape itself, which is the whole
  // point: the admin can navigate away or close the tab right after this
  // resolves and the scrape keeps going.
  async function handleRunStyleAwareScrape() {
    setStylePhase("starting");
    setStyleError(null);
    setStyleJob(null);
    window.localStorage.removeItem(STYLE_JOB_STORAGE_KEY);

    try {
      const response = await fetch("/api/admin-scraper/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          maxPrice: styleMaxPrice,
          limit: styleLimit,
          allowedSources: styleSources,
          categoryFilter: styleCategories.length > 0 ? styleCategories : null,
          brandMode: styleBrands.length > 0 ? styleBrands : null,
        }),
      });
      // Never response.json() directly — see src/lib/api-response.ts's own
      // header comment for the exact production incident (a framework-
      // level 500 HTML page, not this route's JSON) this replaced.
      const data = await parseApiResponse<{ jobId?: string }>(response, "Style-Aware Scraper");

      if (!data.jobId) {
        throw new Error("Failed to start the scraper.");
      }

      window.localStorage.setItem(STYLE_JOB_STORAGE_KEY, data.jobId);
      setStylePhase("running");
      startStylePolling(data.jobId);
    } catch (err) {
      setStyleError(err instanceof Error ? err.message : "Failed to start the scraper.");
      setStylePhase("idle");
    }
  }

  function handleStyleStartOver() {
    stopStylePolling();
    setStylePhase("idle");
    setStyleJob(null);
    setStyleError(null);
    window.localStorage.removeItem(STYLE_JOB_STORAGE_KEY);
  }

  // Calls the SAME endpoint as the Style-Aware Scraper above
  // (/api/admin-scraper/run) with no options in the request body — the
  // route already fills every field in from SCRAPER_CONFIG's defaults
  // when they're omitted (see that route's own parsing), and that route
  // already runs runContinuousAdminScraper (src/lib/admin-scraper.ts)
  // rather than a single bounded batch, so no new backend logic is needed
  // here — this is purely a second client for the same background job.
  async function handleRunContinuousImport() {
    setContinuousPhase("starting");
    setContinuousError(null);
    setContinuousJob(null);
    window.localStorage.removeItem(CONTINUOUS_JOB_STORAGE_KEY);

    try {
      const requestUrl = "/api/admin-scraper/run";
      const requestMethod = "POST";
      const response = await fetch(requestUrl, {
        method: requestMethod,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      // Never response.json() directly — see src/lib/api-response.ts's own
      // header comment for the exact production incident (a framework-
      // level 500 HTML page, not this route's JSON) this replaced. This is
      // the fix for "Continuous Import failed: Unexpected token '<',
      // \"<!DOCTYPE \"... is not valid JSON" — the route itself is also
      // fixed (see its own header comment) to never let an uncaught
      // exception produce that HTML page in the first place, but this
      // client-side guard means ANY non-JSON response (a proxy error, a
      // platform-level timeout page, anything neither side anticipated)
      // still surfaces a real, readable error instead of a raw parse
      // exception. "Continuous Import" (not "Inventory Growth") is what
      // this now actually says on failure — see parseApiResponse's own
      // featureLabel param.
      const data = await parseApiResponse<{ jobId?: string }>(response, "Continuous Import");

      if (!data.jobId) {
        throw new Error("Failed to start continuous import.");
      }

      window.localStorage.setItem(CONTINUOUS_JOB_STORAGE_KEY, data.jobId);
      setContinuousPhase("running");
      startContinuousPolling(data.jobId);
    } catch (err) {
      setContinuousError(err instanceof Error ? err.message : "Failed to start continuous import.");
      setContinuousPhase("idle");
    }
  }

  function handleContinuousStartOver() {
    stopContinuousPolling();
    setContinuousPhase("idle");
    setContinuousJob(null);
    setContinuousError(null);
    window.localStorage.removeItem(CONTINUOUS_JOB_STORAGE_KEY);
  }

  const urlCount = parseUrls(rawUrls).length;

  // Sequential on purpose — not Promise.all. Each URL can trigger a real
  // page fetch, a headless-browser render, and an OpenAI call; running 50
  // of those concurrently would hammer both the target sites and this
  // server. One at a time is simpler and a lot safer (requirement 6),
  // and it's what lets the "Importing N/total" counter below advance
  // one-by-one instead of jumping straight to the end.
  async function handleImportAll() {
    const urls = parseUrls(rawUrls);

    if (urls.length === 0) {
      setFormError("Paste at least one listing URL to import.");
      return;
    }

    setFormError(null);
    setResults([]);
    setTotal(urls.length);
    setPhase("importing");

    for (const url of urls) {
      const result = await importOneUrl(url);
      setResults((prev) => [...prev, result]);
    }

    setPhase("done");
    refreshStats();
  }

  function handleStartOver() {
    setRawUrls("");
    setResults([]);
    setTotal(0);
    setFormError(null);
    setPhase("idle");
  }

  const successCount = results.filter((r) => r.status === "success").length;
  const failureCount = results.filter((r) => r.status === "error").length;

  return (
    <div className="min-h-[calc(100vh-137px)] px-6 py-16">
      <div className="mx-auto max-w-2xl">
        <div className="mb-8 text-center">
          <span className="font-display text-sm uppercase tracking-[0.2em] text-oxblood">
            Admin
          </span>
          <h1 className="mt-2 font-display text-3xl font-semibold text-ink sm:text-4xl">
            Import listings
          </h1>
          <p className="mt-2 text-sm text-ink-soft">
            Paste one or more product URLs (one per line) to pull them into
            Lockette.
          </p>
        </div>

        <Card className="mb-6 grid grid-cols-3 divide-x divide-border/60 p-0 text-center">
          <div className="flex flex-col gap-0.5 p-4">
            <span className="font-display text-xl font-semibold text-ink">{stats.flaggedCount}</span>
            <span className="text-xs text-ink-soft">Flagged for review</span>
          </div>
          <div className="flex flex-col gap-0.5 p-4">
            <span className="font-display text-xl font-semibold text-ink">{stats.activeCount}</span>
            <span className="text-xs text-ink-soft">Active listings</span>
          </div>
          <div className="flex flex-col gap-0.5 p-4">
            <span className="font-display text-sm font-semibold text-ink">{formatLastImport(stats.lastImportAt)}</span>
            <span className="text-xs text-ink-soft">Last import</span>
          </div>
        </Card>

        <Card className="mb-8 p-6">
          <div className="mb-4 flex items-center justify-between">
            <p className="font-display text-lg font-semibold text-ink">Inventory Intelligence</p>
            <button
              type="button"
              onClick={refreshInventoryStats}
              disabled={inventoryStatsLoading}
              className="text-xs font-medium text-oxblood underline-offset-2 hover:underline disabled:opacity-50"
            >
              {inventoryStatsLoading ? "Refreshing..." : "Refresh"}
            </button>
          </div>

          {inventoryStats && (
            <div className="flex flex-col gap-4 text-left">
              <div>
                <div className="flex items-baseline justify-between text-sm text-ink">
                  <span className="font-semibold">
                    Inventory: {inventoryStats.totalInventory != null ? inventoryStats.totalInventory.toLocaleString() : "—"} /{" "}
                    {inventoryStats.targetInventory.toLocaleString()}
                  </span>
                </div>
                <div className="mt-1.5 h-2 w-full overflow-hidden rounded-pill bg-inner">
                  <div
                    className="h-full rounded-pill bg-oxblood transition-all duration-500 ease-out"
                    style={{
                      width:
                        inventoryStats.totalInventory != null
                          ? `${Math.min(100, Math.round((inventoryStats.totalInventory / Math.max(1, inventoryStats.targetInventory)) * 100))}%`
                          : "0%",
                    }}
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-2xl bg-inner/60 p-4 text-sm text-ink sm:grid-cols-3">
                <span>
                  AI analyzed: <span className="font-semibold">{inventoryStats.aiAnalyzedCount.toLocaleString()}</span>
                </span>
                <span>
                  Pending AI jobs: <span className="font-semibold">{inventoryStats.pendingAiJobs.toLocaleString()}</span>
                </span>
                <span>
                  Processing: <span className="font-semibold">{inventoryStats.processingAiJobs.toLocaleString()}</span>
                </span>
                <span>
                  Failed AI jobs: <span className="font-semibold">{inventoryStats.failedAiJobs.toLocaleString()}</span>
                </span>
                <span>
                  Avg. quality score:{" "}
                  <span className="font-semibold">{inventoryStats.averageQualityScore ?? "—"}</span>
                </span>
                <span>
                  New today: <span className="font-semibold">{inventoryStats.newListingsToday.toLocaleString()}</span>
                </span>
                <span>
                  Expired: <span className="font-semibold">{inventoryStats.expiredListings.toLocaleString()}</span>
                </span>
                <span>
                  Duplicates prevented:{" "}
                  <span className="font-semibold">{inventoryStats.duplicatesPreventedAtScrapeTime.toLocaleString()}</span>
                </span>
              </div>

              <div className="flex items-center gap-3">
                <Button
                  type="button"
                  variant="secondary"
                  onClick={handleRunIndexingRound}
                  disabled={indexerTriggering}
                  className="w-fit"
                >
                  {indexerTriggering ? "Starting..." : "Run indexing round"}
                </Button>
                <p className="text-xs text-ink-soft">
                  Validates + queues newly-imported listings for AI analysis, then processes one
                  bounded batch of that queue. Runs in the background — call again (or schedule
                  it) to keep working through the backlog.
                </p>
              </div>

              <div className="mt-3 flex items-center gap-3">
                <Button
                  type="button"
                  variant="secondary"
                  onClick={handleRunFullBackfill}
                  disabled={backfillTriggering}
                  className="w-fit"
                >
                  {backfillTriggering ? "Starting..." : "Run full embedding backfill"}
                </Button>
                <p className="text-xs text-ink-soft">
                  Runs the same indexing round above repeatedly, in the background, until every
                  listing has a visual_embedding — hybrid image+semantic search (Discover&apos;s
                  &quot;search by photo&quot;) can only find listings this has already processed.
                  Can take a while on a large catalog; check back on this page&apos;s stats above.
                </p>
              </div>
            </div>
          )}
        </Card>

        <Card className="mb-8 flex flex-col items-center gap-3 p-6 text-center">
          <p className="font-display text-lg font-semibold text-ink">Bulk import</p>
          <p className="text-sm text-ink-soft">
            Finds fresh listings on Vinted, Depop, and Poshmark on its own —
            no URLs to paste. Everything lands as pending in{" "}
            <span className="font-medium text-ink">/admin/listings</span> for
            review, never live directly.
          </p>

          {bulkPhase === "idle" && (
            <>
              <div className="flex flex-wrap items-center justify-center gap-2">
                <label htmlFor="price-mode" className="text-xs font-medium uppercase tracking-[0.1em] text-ink-soft">
                  Price Mode
                </label>
                <select
                  id="price-mode"
                  value={priceMode}
                  onChange={(event) => setPriceMode(event.target.value as PriceMode)}
                  className="rounded-full border border-border bg-surface px-3 py-1.5 text-sm text-ink focus:border-oxblood focus:outline-none"
                >
                  {PRICE_MODE_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
                <Button
                  type="button"
                  variant={priceMode === "under10" ? "primary" : "secondary"}
                  onClick={() => setPriceMode(priceMode === "under10" ? "any" : "under10")}
                  className="w-fit"
                >
                  💸 Under $10 Only
                </Button>
              </div>

              <div className="flex flex-col items-center gap-2">
                <span className="text-xs font-medium uppercase tracking-[0.1em] text-ink-soft">
                  Categories {selectedCategories.length === 0 && "(all — no filter)"}
                </span>
                <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-2">
                  {SELECTED_CATEGORY_OPTIONS.map((option) => (
                    <label
                      key={option.value}
                      className="flex items-center gap-1.5 text-sm text-ink"
                    >
                      <input
                        type="checkbox"
                        checked={selectedCategories.includes(option.value)}
                        onChange={() => toggleSelectedCategory(option.value)}
                        className="h-4 w-4 rounded border-border accent-oxblood"
                      />
                      {option.label}
                    </label>
                  ))}
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => setSelectedCategories(SELECTED_CATEGORY_OPTIONS.map((option) => option.value))}
                    className="w-fit px-3 py-1 text-xs"
                  >
                    Select All
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => setSelectedCategories([])}
                    className="w-fit px-3 py-1 text-xs"
                  >
                    Clear All
                  </Button>
                </div>
              </div>

              <div className="flex flex-col items-center gap-2">
                <span className="text-xs font-medium uppercase tracking-[0.1em] text-ink-soft">
                  Brand Filters {selectedBrands.length === 0 && "(all — no filter)"}
                </span>
                <div className="flex flex-wrap items-center justify-center gap-2">
                  {SELECTED_BRAND_OPTIONS.map((option) => (
                    <Button
                      key={option.value}
                      type="button"
                      variant={selectedBrands.includes(option.value) ? "primary" : "secondary"}
                      onClick={() => toggleSelectedBrand(option.value)}
                      className="w-fit"
                    >
                      {option.label}
                    </Button>
                  ))}
                </div>
              </div>

              <div className="flex flex-wrap items-center justify-center gap-2">
                {BULK_IMPORT_SIZES.map((size) => (
                  <Button
                    key={size}
                    type="button"
                    variant={size === LARGE_IMPORT_THRESHOLD ? "primary" : "secondary"}
                    onClick={() => handleBulkImport(size)}
                    className="w-fit"
                  >
                    Import {size} Listings
                  </Button>
                ))}
              </div>
            </>
          )}

          {(bulkPhase === "discovering" || bulkPhase === "importing") && (
            <div className="flex flex-col items-center gap-2">
              <Loader2 className="h-8 w-8 animate-spin text-oxblood" strokeWidth={1.5} />
              <p className="text-sm font-medium text-ink">
                {bulkPhase === "discovering" ? "Finding listings..." : `Imported ${bulkImported}/${bulkTarget}`}
              </p>
            </div>
          )}

          {bulkPhase === "done" && (
            <div className="flex flex-col items-center gap-2">
              <p className="font-display text-base font-semibold text-ink">
                Completed: {bulkImported} pending listings
              </p>
              {(() => {
                const parts = [
                  bulkDuplicates > 0 && `${bulkDuplicates} already imported`,
                  bulkFailed > 0 && `${bulkFailed} failed`,
                  bulkPriceRejected > 0 && `${bulkPriceRejected} price rejected`,
                  bulkCategoryRejected > 0 && `${bulkCategoryRejected} category rejected`,
                  bulkBrandRejected > 0 && `${bulkBrandRejected} brand rejected`,
                  bulkQualityRejected > 0 && `${bulkQualityRejected} quality rejected`,
                ].filter(Boolean);

                return parts.length > 0 ? (
                  <p className="text-xs text-ink-soft">{parts.join(" · ")}</p>
                ) : null;
              })()}
              <Button type="button" variant="secondary" onClick={handleBulkStartOver} className="w-fit">
                Run again
              </Button>
            </div>
          )}

          {bulkError && (
            <p className="rounded-2xl bg-tag-pink px-4 py-3 text-sm text-tag-pink-ink">{bulkError}</p>
          )}
        </Card>

        <Card className="mb-8 flex flex-col items-center gap-3 p-6 text-center">
          <p className="font-display text-lg font-semibold text-ink">Style-Aware Scraper</p>
          <p className="text-sm text-ink-soft">
            Scores candidates against fixed style archetypes (boho_y2k, soft_feminine, y2k_casual)
            before importing. Same rules as bulk import — everything lands as pending in{" "}
            <span className="font-medium text-ink">/admin/listings</span>, never live directly.
          </p>

          {stylePhase === "idle" && (
            <>
              <div className="flex flex-wrap items-center justify-center gap-2">
                <label htmlFor="style-max-price" className="text-xs font-medium uppercase tracking-[0.1em] text-ink-soft">
                  Max Price
                </label>
                <input
                  id="style-max-price"
                  type="number"
                  min={1}
                  step={1}
                  value={styleMaxPrice}
                  onChange={(event) => setStyleMaxPrice(Number(event.target.value) || 0)}
                  className="w-20 rounded-full border border-border bg-surface px-3 py-1.5 text-sm text-ink focus:border-oxblood focus:outline-none"
                />
              </div>

              <div className="flex flex-col items-center gap-2">
                <span className="text-xs font-medium uppercase tracking-[0.1em] text-ink-soft">Sources</span>
                <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-2">
                  {STYLE_SOURCE_OPTIONS.map((source) => (
                    <label key={source} className="flex items-center gap-1.5 text-sm capitalize text-ink">
                      <input
                        type="checkbox"
                        checked={styleSources.includes(source)}
                        onChange={() => toggleStyleSource(source)}
                        className="h-4 w-4 rounded border-border accent-oxblood"
                      />
                      {source}
                    </label>
                  ))}
                </div>
              </div>

              <div className="flex flex-col items-center gap-2">
                <span className="text-xs font-medium uppercase tracking-[0.1em] text-ink-soft">
                  Category {styleCategories.length === 0 && "(all — no filter)"}
                </span>
                <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-2">
                  {STYLE_CATEGORY_OPTIONS.map((category) => (
                    <label key={category} className="flex items-center gap-1.5 text-sm capitalize text-ink">
                      <input
                        type="checkbox"
                        checked={styleCategories.includes(category)}
                        onChange={() => toggleStyleCategory(category)}
                        className="h-4 w-4 rounded border-border accent-oxblood"
                      />
                      {category}
                    </label>
                  ))}
                </div>
              </div>

              <div className="flex flex-col items-center gap-2">
                <span className="text-xs font-medium uppercase tracking-[0.1em] text-ink-soft">
                  Brand Filters {styleBrands.length === 0 && "(all — no filter)"}
                </span>
                <div className="flex flex-wrap items-center justify-center gap-2">
                  {SELECTED_BRAND_OPTIONS.map((option) => (
                    <Button
                      key={option.value}
                      type="button"
                      variant={styleBrands.includes(option.value) ? "primary" : "secondary"}
                      onClick={() => toggleStyleBrand(option.value)}
                      className="w-fit"
                    >
                      {option.label}
                    </Button>
                  ))}
                </div>
              </div>

              <div className="flex flex-wrap items-center justify-center gap-2">
                {STYLE_LIMIT_OPTIONS.map((size) => (
                  <Button
                    key={size}
                    type="button"
                    variant={size === styleLimit ? "primary" : "secondary"}
                    onClick={() => setStyleLimit(size)}
                    className="w-fit"
                  >
                    {size}
                  </Button>
                ))}
              </div>

              <Button type="button" onClick={handleRunStyleAwareScrape} className="w-fit">
                Run Style-Aware Scraper
              </Button>
              <p className="max-w-sm text-center text-xs text-ink-soft">
                Runs in the background — safe to navigate away or close this tab once it starts.
              </p>
            </>
          )}

          {stylePhase === "starting" && (
            <div className="flex flex-col items-center gap-2">
              <Loader2 className="h-8 w-8 animate-spin text-oxblood" strokeWidth={1.5} />
              <p className="text-sm font-medium text-ink">Starting scrape...</p>
            </div>
          )}

          {stylePhase === "running" && (
            <div className="flex w-full flex-col items-center gap-2">
              {styleJob && isJobStale(styleJob) ? (
                <div className="w-full rounded-2xl bg-tag-pink px-4 py-3 text-left text-sm text-tag-pink-ink">
                  <p className="font-semibold">This run may have stalled</p>
                  <p className="mt-1 text-xs">
                    No progress reported in over 5 minutes — check the server logs. You can start a fresh
                    run below without waiting for this one; the stalled job is harmless and won&apos;t block
                    a new one.
                  </p>
                  <Button type="button" variant="secondary" onClick={handleStyleStartOver} className="mt-2 w-fit">
                    Start a new run
                  </Button>
                </div>
              ) : (
                <Loader2 className="h-8 w-8 animate-spin text-oxblood" strokeWidth={1.5} />
              )}
              <p className="text-sm font-medium text-ink">Scraper running...</p>

              {styleJob ? (
                <div className="w-full max-w-xs rounded-2xl bg-inner/60 p-4 text-left text-sm text-ink">
                  <p>
                    Processed:{" "}
                    <span className="font-semibold">
                      {styleJob.scraped_count} / {styleJob.requested_count}
                    </span>
                  </p>
                  <p>
                    Found: <span className="font-semibold">{styleJob.passed_count}</span>
                  </p>
                  <p>
                    Inserted: <span className="font-semibold">{styleJob.inserted_count}</span>
                  </p>
                  <p>
                    Errors: <span className="font-semibold">{styleJob.error_count ?? 0}</span>
                  </p>
                  {styleJob.last_url && (
                    <p className="mt-2 truncate text-xs text-ink-soft" title={styleJob.last_url}>
                      Last processed URL: {styleJob.last_url}
                    </p>
                  )}
                </div>
              ) : (
                <p className="text-xs text-ink-soft">Scraping started...</p>
              )}

              <p className="max-w-sm text-center text-xs text-ink-soft">
                Feel free to leave this page — it keeps running in the background; come back anytime to
                check progress.
              </p>
            </div>
          )}

          {stylePhase === "done" && styleJob && (
            <div className="flex w-full flex-col items-center gap-2">
              <p className="font-display text-base font-semibold text-ink">
                {styleJob.status === "failed"
                  ? "Scraper failed"
                  : `Completed: ${styleJob.inserted_count}/${styleJob.requested_count} pending listings`}
              </p>
              {styleJob.status === "failed" && styleJob.error_message && (
                <p className="max-w-sm text-center text-xs text-ink-soft">{styleJob.error_message}</p>
              )}
              {styleJob.status === "completed" && styleJob.inserted_count < styleJob.requested_count && (
                <p className="max-w-sm text-center text-xs text-ink-soft">
                  Scraped {styleJob.scraped_count} · {styleJob.scored_count} scored ·{" "}
                  {styleJob.passed_count} passed style filter. {SHORTFALL_MESSAGE}
                </p>
              )}
              <div className="w-full max-w-xs rounded-2xl bg-inner/60 p-4 text-left text-sm text-ink">
                <p>
                  Processed:{" "}
                  <span className="font-semibold">
                    {styleJob.scraped_count} / {styleJob.requested_count}
                  </span>
                </p>
                <p>
                  Found: <span className="font-semibold">{styleJob.passed_count}</span>
                </p>
                <p>
                  Inserted: <span className="font-semibold">{styleJob.inserted_count}</span>
                </p>
                <p>
                  Errors: <span className="font-semibold">{styleJob.error_count ?? 0}</span>
                </p>
              </div>
              <Button type="button" variant="secondary" onClick={handleStyleStartOver} className="w-fit">
                Run again
              </Button>
            </div>
          )}

          {styleError && (
            <p className="rounded-2xl bg-tag-pink px-4 py-3 text-sm text-tag-pink-ink">{styleError}</p>
          )}
        </Card>

        <Card className="mb-8 flex flex-col items-center gap-3 p-6 text-center">
          <p className="font-display text-lg font-semibold text-ink">Continuous Import</p>
          <p className="text-sm text-ink-soft">
            Keeps running the same scraper in back-to-back rounds automatically, importing
            hundreds or thousands of listings over time instead of stopping after one batch.
            Everything lands as pending in{" "}
            <span className="font-medium text-ink">/admin/listings</span> for review, never
            live directly.
          </p>

          {continuousPhase === "idle" && (
            <Button type="button" onClick={handleRunContinuousImport} className="w-fit">
              Start Continuous Import
            </Button>
          )}

          {(continuousPhase === "starting" || continuousPhase === "running") && (
            <Button type="button" disabled className="w-fit">
              <Loader2 className="h-4 w-4 animate-spin" />
              Importing Inventory...
            </Button>
          )}

          {continuousPhase === "starting" && (
            <p className="text-xs text-ink-soft">Starting continuous import...</p>
          )}

          {continuousPhase === "running" && (
            <div className="flex w-full flex-col items-center gap-2">
              {continuousJob && isJobStale(continuousJob) && (
                <div className="w-full rounded-2xl bg-tag-pink px-4 py-3 text-left text-sm text-tag-pink-ink">
                  <p className="font-semibold">This run may have stalled</p>
                  <p className="mt-1 text-xs">
                    No progress reported in over 5 minutes — check the server logs. You can
                    start a fresh run below without waiting for this one; the stalled job is
                    harmless and won&apos;t block a new one.
                  </p>
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={handleContinuousStartOver}
                    className="mt-2 w-fit"
                  >
                    Start a new run
                  </Button>
                </div>
              )}

              {continuousJob ? (
                <div className="w-full max-w-xs rounded-2xl bg-inner/60 p-4 text-left text-sm text-ink">
                  <p>
                    Processed:{" "}
                    <span className="font-semibold">
                      {continuousJob.scraped_count} / {continuousJob.requested_count}
                    </span>
                  </p>
                  <p>
                    Found: <span className="font-semibold">{continuousJob.passed_count}</span>
                  </p>
                  <p>
                    Inserted: <span className="font-semibold">{continuousJob.inserted_count}</span>
                  </p>
                  <p>
                    Errors: <span className="font-semibold">{continuousJob.error_count ?? 0}</span>
                  </p>
                  {continuousJob.last_url && (
                    <p className="mt-2 truncate text-xs text-ink-soft" title={continuousJob.last_url}>
                      Last processed URL: {continuousJob.last_url}
                    </p>
                  )}
                </div>
              ) : (
                <p className="text-xs text-ink-soft">Importing started...</p>
              )}

              <p className="max-w-sm text-center text-xs text-ink-soft">
                Feel free to leave this page — it keeps running in the background; come back
                anytime to check progress.
              </p>
            </div>
          )}

          {continuousPhase === "done" && continuousJob && (
            <div className="flex w-full flex-col items-center gap-2">
              <p className="font-display text-base font-semibold text-ink">
                {continuousJob.status === "failed"
                  ? "Continuous import failed"
                  : `Completed: ${continuousJob.inserted_count} pending listings`}
              </p>
              {continuousJob.status === "failed" && continuousJob.error_message && (
                <p className="max-w-sm text-center text-xs text-ink-soft">
                  {continuousJob.error_message}
                </p>
              )}
              <div className="w-full max-w-xs rounded-2xl bg-inner/60 p-4 text-left text-sm text-ink">
                <p>
                  Processed: <span className="font-semibold">{continuousJob.scraped_count}</span>
                </p>
                <p>
                  Found: <span className="font-semibold">{continuousJob.passed_count}</span>
                </p>
                <p>
                  Inserted: <span className="font-semibold">{continuousJob.inserted_count}</span>
                </p>
                <p>
                  Errors: <span className="font-semibold">{continuousJob.error_count ?? 0}</span>
                </p>
              </div>
              <Button type="button" variant="secondary" onClick={handleContinuousStartOver} className="w-fit">
                Run again
              </Button>
            </div>
          )}

          {continuousError && (
            <p className="rounded-2xl bg-tag-pink px-4 py-3 text-sm text-tag-pink-ink">{continuousError}</p>
          )}
        </Card>

        <Card className="mb-8 flex flex-col items-center gap-3 p-6 text-center">
          <p className="font-display text-lg font-semibold text-ink">Inventory Growth</p>
          <p className="text-sm text-ink-soft">
            Builds and maintains a large, continuously-replenished inventory over an extended
            run — target size and batch size are yours to set; it works through controlled
            batches of {largeScaleBatchSize} (never one giant request) until the live inventory
            reaches your target, checking in between batches so it can be paused and resumed.
          </p>

          {largeScalePhase === "idle" && (
            <div className="flex w-full max-w-xs flex-col gap-3">
              <label className="flex flex-col gap-1 text-left text-sm text-ink">
                Target inventory size
                {/* Prevent-meaningless-runs fix — shown right next to the
                    input the admin is about to set a target in, so
                    there's no need to cross-reference the Inventory
                    Intelligence card above to know whether a given
                    target is even worth running. */}
                <span className="text-xs font-normal text-ink-soft">
                  {inventoryStats?.totalInventory != null
                    ? `Current total: ${inventoryStats.totalInventory.toLocaleString()} listings`
                    : "Current total: unavailable"}
                </span>
                <input
                  type="number"
                  min={1}
                  value={largeScaleTarget}
                  onChange={(event) => setLargeScaleTarget(Math.max(1, Number(event.target.value) || 0))}
                  className="rounded-2xl border border-border bg-surface px-4 py-2 text-sm text-ink focus:border-oxblood focus:outline-none"
                />
              </label>
              <label className="flex flex-col gap-1 text-left text-sm text-ink">
                Batch size
                <input
                  type="number"
                  min={1}
                  value={largeScaleBatchSize}
                  onChange={(event) => setLargeScaleBatchSize(Math.max(1, Number(event.target.value) || 0))}
                  className="rounded-2xl border border-border bg-surface px-4 py-2 text-sm text-ink focus:border-oxblood focus:outline-none"
                />
              </label>
              <div className="flex items-center justify-center gap-4 text-sm text-ink">
                <label className="flex items-center gap-1.5">
                  <input
                    type="radio"
                    name="largeScaleMode"
                    checked={largeScaleMode === "quality"}
                    onChange={() => setLargeScaleMode("quality")}
                    className="accent-oxblood"
                  />
                  Quality mode
                </label>
                <label className="flex items-center gap-1.5">
                  <input
                    type="radio"
                    name="largeScaleMode"
                    checked={largeScaleMode === "fast"}
                    onChange={() => setLargeScaleMode("fast")}
                    className="accent-oxblood"
                  />
                  Fast mode
                </label>
              </div>
              <p className="text-xs text-ink-soft">
                {largeScaleMode === "fast"
                  ? "Fewer AI checks per listing, larger effective throughput."
                  : "Full AI classification + image scoring per listing (default)."}
              </p>
              <label className="flex items-center justify-center gap-2 text-sm text-ink">
                <input
                  type="checkbox"
                  checked={largeScaleOvernightMode}
                  onChange={(event) => setLargeScaleOvernightMode(event.target.checked)}
                  className="accent-oxblood"
                />
                Overnight mode
              </label>
              <p className="text-xs text-ink-soft">
                {largeScaleOvernightMode
                  ? "Keeps generating fresh search combinations and runs well past the usual batch cap — still stops the moment the target is reached, is paused, or too many batches fail in a row."
                  : "Runs a bounded number of batches before stopping on its own, even if the target isn't reached yet."}
              </p>
              <label className="flex items-center justify-center gap-2 text-sm text-ink">
                <input
                  type="checkbox"
                  checked={largeScaleAggressiveMode}
                  onChange={(event) => setLargeScaleAggressiveMode(event.target.checked)}
                  className="accent-oxblood"
                />
                Aggressive acquisition
              </label>
              <p className="text-xs text-ink-soft">
                {largeScaleAggressiveMode
                  ? "Discovery and extraction run concurrently against scraper_url_queue, AI enrichment is deferred to the background queue, and eBay is skipped until it has a working strategy — maximizes raw import throughput."
                  : "Discovery runs a full pass before extraction starts, same as an ordinary batch."}
              </p>
              {/* Prevent-meaningless-runs fix — client-side half of the
                  same check the start route now also enforces
                  server-side (TARGET_ALREADY_MET); this is just the
                  earlier, no-network-round-trip warning. */}
              {inventoryStats?.totalInventory != null && largeScaleTarget <= inventoryStats.totalInventory && (
                <p className="text-xs text-oxblood">
                  Your inventory already exceeds this target. Enter a target above the current total.
                </p>
              )}
              <Button
                type="button"
                onClick={handleStartLargeScale}
                disabled={inventoryStats?.totalInventory != null && largeScaleTarget <= inventoryStats.totalInventory}
                className="w-fit self-center"
              >
                Start Inventory Growth
              </Button>
            </div>
          )}

          {largeScalePhase === "starting" && (
            <Button type="button" disabled className="w-fit">
              <Loader2 className="h-4 w-4 animate-spin" />
              Starting inventory growth…
            </Button>
          )}

          {(largeScalePhase === "running" || largeScalePhase === "paused") && largeScaleJob && (
            <div className="flex w-full flex-col items-center gap-3">
              {(() => {
                const target = largeScaleJob.target_count ?? largeScaleTarget;
                const current = largeScaleJob.inserted_count;
                const pct = target > 0 ? Math.min(100, Math.round((current / target) * 100)) : 0;
                const elapsedMinutes = (Date.now() - new Date(largeScaleJob.created_at).getTime()) / 60_000;
                const perMinute = elapsedMinutes > 0.1 ? current / elapsedMinutes : 0;
                const perHour = perMinute * 60;
                const remaining = Math.max(0, target - current);
                const etaMinutes = perMinute > 0 ? Math.ceil(remaining / perMinute) : null;
                const validCount = largeScaleJob.valid_count ?? 0;
                const duplicateCount = largeScaleJob.duplicate_count ?? 0;
                const duplicateRate =
                  validCount + duplicateCount > 0 ? Math.round((duplicateCount / (validCount + duplicateCount)) * 100) : null;
                const extractedSuccessfullyCount = largeScaleJob.extracted_successfully_count ?? 0;
                const extractionFailuresByReason = largeScaleJob.extraction_failures_by_reason ?? {};
                const topExtractionFailureReasons = Object.entries(extractionFailuresByReason)
                  .sort(([, a], [, b]) => b - a)
                  .slice(0, 3);

                return (
                  <div className="w-full max-w-sm text-left">
                    <div className="flex items-baseline justify-between text-sm text-ink">
                      <span className="font-semibold">
                        {current.toLocaleString()} / {target.toLocaleString()}
                      </span>
                      <span className="text-xs text-ink-soft">{pct}%</span>
                    </div>
                    <div className="mt-1.5 h-2 w-full overflow-hidden rounded-pill bg-inner">
                      <div
                        className="h-full rounded-pill bg-oxblood transition-all duration-500 ease-out"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 rounded-2xl bg-inner/60 p-4 text-sm text-ink">
                      <span>
                        Current batch:{" "}
                        <span className="font-semibold">
                          {largeScaleJob.current_round ?? 0} / {largeScaleJob.total_batches ?? "?"}
                        </span>
                      </span>
                      <span>
                        Valid: <span className="font-semibold">{validCount}</span>
                      </span>
                      <span>
                        Duplicates: <span className="font-semibold">{duplicateCount}</span>
                      </span>
                      <span>
                        Rejected: <span className="font-semibold">{largeScaleJob.rejected_count ?? 0}</span>
                      </span>
                      <span>
                        URLs extracted successfully:{" "}
                        <span className="font-semibold">{extractedSuccessfullyCount}</span>
                      </span>
                      <span>
                        Database insert failures:{" "}
                        <span className="font-semibold">{largeScaleJob.insert_failed_count ?? 0}</span>
                      </span>
                      <span>
                        Duplicate rate:{" "}
                        <span className="font-semibold">{duplicateRate == null ? "—" : `${duplicateRate}%`}</span>
                      </span>
                      <span>
                        Queries completed: <span className="font-semibold">{largeScaleJob.queries_completed ?? 0}</span>
                      </span>
                      <span>
                        Pages searched: <span className="font-semibold">{largeScaleJob.pages_searched ?? 0}</span>
                      </span>
                      <span>
                        Unique URLs found:{" "}
                        <span className="font-semibold">{largeScaleJob.unique_urls_discovered ?? 0}</span>
                      </span>
                      <span>
                        URLs discovered/min:{" "}
                        <span className="font-semibold">
                          {elapsedMinutes > 0.1 ? ((largeScaleJob.unique_urls_discovered ?? 0) / elapsedMinutes).toFixed(1) : "—"}
                        </span>
                      </span>
                      <span>
                        Extraction queue depth:{" "}
                        <span className="font-semibold">{largeScaleLiveMetrics?.extractionQueueDepth ?? "—"}</span>
                      </span>
                      <span>
                        Currently leased URLs:{" "}
                        <span className="font-semibold">{largeScaleLiveMetrics?.extractionQueueClaimed ?? "—"}</span>
                      </span>
                      <span>
                        Permanently failed URLs:{" "}
                        <span className="font-semibold">{largeScaleLiveMetrics?.permanentlyFailedUrlCount ?? "—"}</span>
                      </span>
                      {largeScaleAggressiveMode && (
                        <span>
                          Active discovery workers:{" "}
                          <span className="font-semibold">{largeScaleLiveMetrics?.activeDiscoveryWorkers ?? "—"}</span>
                        </span>
                      )}
                      <span>
                        Current workers active:{" "}
                        <span className="font-semibold">{largeScaleLiveMetrics?.activeExtractionWorkers ?? "—"}</span>
                      </span>
                      <span>
                        Imported/minute: <span className="font-semibold">{perMinute.toFixed(1)}</span>
                      </span>
                      <span>
                        Imports/hour: <span className="font-semibold">{perHour.toFixed(0)}</span>
                      </span>
                      <span>
                        Est. completion:{" "}
                        <span className="font-semibold">
                          {etaMinutes == null
                            ? "—"
                            : etaMinutes < 60
                              ? `~${etaMinutes}m`
                              : `~${(etaMinutes / 60).toFixed(1)}h`}
                        </span>
                      </span>
                    </div>
                    {topExtractionFailureReasons.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 rounded-2xl bg-inner/60 px-4 py-2 text-xs text-ink-soft">
                        <span className="w-full font-semibold text-ink">Extraction failures by reason:</span>
                        {topExtractionFailureReasons.map(([reason, count]) => (
                          <span key={reason}>
                            {reason}: {count}
                          </span>
                        ))}
                      </div>
                    )}
                    {largeScaleLiveMetrics && largeScaleLiveMetrics.marketplaceHealth.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 rounded-2xl bg-inner/60 px-4 py-2 text-xs text-ink-soft">
                        {largeScaleLiveMetrics.marketplaceHealth.map((health) => (
                          <span key={health.platform}>
                            {health.platform}: {Math.round(health.successRate * 100)}% success
                            {!health.enabled && " (disabled)"}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })()}

              {largeScalePhase === "running" ? (
                <>
                  <Button type="button" variant="secondary" onClick={handlePauseLargeScale} disabled={largeScalePausing} className="w-fit">
                    {largeScalePausing ? "Pausing..." : "Pause"}
                  </Button>
                  <p className="max-w-sm text-center text-xs text-ink-soft">
                    Feel free to leave this page — it keeps running in the background; come back
                    anytime to check progress.
                  </p>
                </>
              ) : (
                <>
                  <p className="text-sm font-medium text-ink">Paused</p>
                  <Button type="button" onClick={handleResumeLargeScale} disabled={largeScaleResuming} className="w-fit">
                    {largeScaleResuming ? "Resuming..." : "Resume"}
                  </Button>
                </>
              )}
            </div>
          )}

          {largeScalePhase === "done" && largeScaleJob && (
            <div className="flex w-full flex-col items-center gap-2">
              <p className="font-display text-base font-semibold text-ink">
                {largeScaleJob.status === "failed"
                  ? "Inventory growth run failed"
                  : `This run added ${largeScaleJob.inserted_count.toLocaleString()} new listing${largeScaleJob.inserted_count === 1 ? "" : "s"}`}
              </p>
              {largeScaleJob.status === "failed" && largeScaleJob.error_message && (
                <p className="max-w-sm text-center text-xs text-ink-soft">{largeScaleJob.error_message}</p>
              )}
              {largeScaleJob.status !== "failed" && (
                <>
                  {/* Inventory count display fix — ROOT CAUSE REGRESSION:
                      this used to render `inventoryStats.totalInventory`
                      unconditionally the moment inventoryStats was
                      non-null, which is also exactly the shape a FAILED
                      request returns (EMPTY_STATS, totalInventory: null
                      — see inventory-dashboard.ts's own comment on why
                      that used to be a fake 0). A null totalInventory
                      here means "unknown right now," never "zero
                      listings" — the three branches below are the only
                      three real states: still loading (never got a
                      value yet), loaded but this specific count's own
                      query failed (never got a value, and won't retry on
                      its own), or a genuine number. A PREVIOUS valid
                      number is always preferred over either loading/
                      failed text while a refresh is in flight, so the
                      real total never disappears just because a new
                      fetch started. */}
                  <p className="text-sm text-ink-soft">
                    {inventoryStats?.totalInventory != null
                      ? `Current inventory: ${inventoryStats.totalInventory.toLocaleString()} listing${inventoryStats.totalInventory === 1 ? "" : "s"}${inventoryStatsLoading ? " (refreshing…)" : ""}.`
                      : inventoryStatsLoading
                        ? "Refreshing inventory total…"
                        : "Current inventory total is temporarily unavailable."}
                  </p>
                  <p className="text-xs text-ink-soft">
                    Run target: {(largeScaleJob.target_count ?? largeScaleTarget).toLocaleString()} listing
                    {(largeScaleJob.target_count ?? largeScaleTarget) === 1 ? "" : "s"}
                    {inventoryStats?.totalInventory != null &&
                    inventoryStats.totalInventory >= (largeScaleJob.target_count ?? largeScaleTarget)
                      ? " — already met by the existing inventory."
                      : "."}
                  </p>
                </>
              )}
              <Button type="button" variant="secondary" onClick={handleLargeScaleStartOver} className="w-fit">
                Start another run
              </Button>
            </div>
          )}

          {largeScaleError && (
            <p className="rounded-2xl bg-tag-pink px-4 py-3 text-sm text-tag-pink-ink">{largeScaleError}</p>
          )}
        </Card>

        <div className="mb-6 text-center">
          <span className="text-xs font-medium uppercase tracking-[0.15em] text-ink-soft">
            Or paste URLs manually
          </span>
        </div>

        {phase !== "done" && (
          <div className="flex flex-col gap-4">
            <div>
              <label
                htmlFor="listing-urls"
                className="mb-1.5 block text-sm font-medium text-ink"
              >
                Listing URLs
              </label>
              <textarea
                id="listing-urls"
                required
                rows={10}
                value={rawUrls}
                onChange={(event) => setRawUrls(event.target.value)}
                disabled={phase === "importing"}
                placeholder={
                  "https://www.depop.com/products/...\n" +
                  "https://www.etsy.com/listing/...\n" +
                  "https://www.poshmark.com/listing/..."
                }
                className="w-full rounded-2xl border border-border bg-surface px-4 py-3 font-mono text-sm text-ink placeholder:text-ink-soft/60 focus:border-oxblood focus:outline-none disabled:opacity-60"
              />
              <p className="mt-1.5 text-xs text-ink-soft">
                {urlCount} URL{urlCount === 1 ? "" : "s"} detected
              </p>
            </div>

            {formError && (
              <p className="rounded-2xl bg-tag-pink px-4 py-3 text-sm text-tag-pink-ink">
                {formError}
              </p>
            )}

            <Button
              type="button"
              onClick={handleImportAll}
              disabled={phase === "importing"}
              className="w-fit"
            >
              {phase === "importing" ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Importing {results.length}/{total}...
                </>
              ) : (
                "Import All"
              )}
            </Button>

            {phase === "importing" && results.length > 0 && (
              <ImportResultsList results={results} />
            )}
          </div>
        )}

        {phase === "done" && (
          <div className="flex flex-col gap-4">
            <Card className="p-6 text-center">
              <p className="font-display text-lg font-semibold text-ink">
                Imported {successCount} of {total}
              </p>
              {failureCount > 0 && (
                <p className="mt-1 text-sm text-ink-soft">
                  {failureCount} failed — see details below.
                </p>
              )}
            </Card>

            <ImportResultsList results={results} />

            <Button type="button" onClick={handleStartOver} className="w-fit">
              Import more
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

function ImportResultsList({ results }: { results: ImportResult[] }) {
  return (
    <ul className="flex flex-col gap-2">
      {results.map((result, index) => (
        <li
          key={`${result.url}-${index}`}
          className={`flex items-start gap-2 rounded-2xl px-4 py-3 text-sm ${
            result.status === "success"
              ? "bg-tag-teal text-tag-teal-ink"
              : "bg-tag-pink text-tag-pink-ink"
          }`}
        >
          {result.status === "success" ? (
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" strokeWidth={2} />
          ) : (
            <XCircle className="mt-0.5 h-4 w-4 shrink-0" strokeWidth={2} />
          )}
          <div className="min-w-0">
            <p className="truncate font-medium">{result.message}</p>
            <p className="truncate text-xs opacity-70">{result.url}</p>
          </div>
        </li>
      ))}
    </ul>
  );
}
