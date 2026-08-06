// Discovery scaling for Inventory Growth overnight runs — requirements
// 1/3/4 of the discovery-scaling spec (query diversification is
// query-generator.ts; discovery-history tracking is discovery-history.ts;
// this file is the actual crawl: parallel, independently-rate-limited,
// paginated, per-platform workers feeding one shared result set).
//
// Root cause this replaces: marketplace-discovery.ts's discoverListingUrls
// crawls the SAME small, fixed rotation of ~50 search terms at page 1
// every single round — after enough rounds there's nothing new left under
// those exact terms, so later batches increasingly just re-surface
// listings already in the table (diagnosed live: 62% -> 90% -> 93%
// duplicate rate across batches 1-3 of a real run). This module never
// changes duplicate detection itself (admin-scraper.ts's
// filterOutDuplicateCandidates is completely untouched) — it attacks the
// actual cause, by making sure discovery keeps finding genuinely NEW
// search combinations instead of running dry.
//
// Used ONLY by runLargeScaleAdminScraper (Inventory Growth) — the
// existing Style-Aware Scraper and Continuous Import admin cards keep
// calling marketplace-discovery.ts's discoverListingUrls exactly as
// before; nothing about their behavior changes.
import { type Page, type BrowserContext, type Browser } from "playwright";
import {
  normalizeUrl,
  extractProductLinksWithPriceHints,
  BROWSER_USER_AGENT,
  PAGE_NAV_TIMEOUT_MS,
  SETTLE_MS,
  LAUNCH_TIMEOUT_MS,
  BLOCKED_STATUS_CODES,
  type DiscoveredCandidate,
} from "@/lib/marketplace-discovery";
import { mapWithConcurrency, abortableDelay, BatchAbortedError } from "@/lib/concurrency";
import { allGeneratedQueries } from "@/lib/inventory/query-generator";
import {
  getProcessedQueries,
  isQueryPageProcessed,
  recordDiscoveryRun,
  getQueryYields,
  type QueryPageYield,
} from "@/lib/inventory/discovery-history";
import { recordDiscoveryAttempt, isPlatformEnabled } from "@/lib/inventory/marketplace-health";
import { acquirePooledBrowser, releasePooledBrowser } from "@/lib/browser-concurrency";
import { resolveBrowserLaunchOptions } from "@/lib/browser-launch-options";
import { DISCOVERY_CONCURRENCY } from "@/lib/scraper-config";
import os from "node:os";

// Discovery redesign requirement 5 — "marketplace-specific discovery
// strategies." HONEST SCOPE NOTE: real category/seller/closet-page
// enumeration would need actual category-ID/seller-username lists this
// codebase has no verified source for (fabricating IDs would silently
// return nothing, which is worse than not trying) — so each extra
// strategy here is a same-search, different-sort-parameter variant
// (verified as a real, documented query param on that platform's own
// search UI), not a different discovery surface entirely. This still
// diversifies what a query's results actually contain (e.g. newest-first
// surfaces items a relevance-sorted search page 1 would never reach) —
// the real "different surface" upgrade (category/seller/closet) is the
// natural next step once real ID lists exist.
interface DiscoveryStrategy {
  kind: string;
  buildUrl: (query: string, page: number) => string;
}

interface ScaledSource {
  platform: string;
  // Real pagination params, best-effort per platform (see this file's own
  // per-source comments) — Vinted's own catalog UI confirms &page=N works;
  // Depop/Poshmark are educated approximations of their real pagination
  // schemes and should be spot-checked live before relying on pages beyond
  // 1-2 actually returning distinct results.
  strategies: DiscoveryStrategy[];
  productPattern: RegExp;
  // "Independent worker... independent rate limiting" (requirement 4) —
  // each platform gets its OWN concurrency ceiling (how many pages of
  // THIS platform run at once) and its own minimum gap between two
  // requests to it, so one slow/blocking platform never steals capacity
  // from, or gets rate-limited because of, the others.
  concurrency: number;
  minDelayMs: number;
}

const SCALED_SOURCES: ScaledSource[] = [
  {
    platform: "Vinted",
    strategies: [
      {
        kind: "search",
        buildUrl: (query, page) =>
          `https://www.vinted.com/catalog?search_text=${encodeURIComponent(query)}${page > 1 ? `&page=${page}` : ""}`,
      },
      {
        kind: "search-newest",
        buildUrl: (query, page) =>
          `https://www.vinted.com/catalog?search_text=${encodeURIComponent(query)}&order=newest_first${page > 1 ? `&page=${page}` : ""}`,
      },
    ],
    productPattern: /^https:\/\/www\.vinted\.com\/items\//,
    concurrency: 4,
    minDelayMs: 400,
  },
  {
    platform: "Depop",
    // Depop's public search results are infinite-scroll (offset-based),
    // not a simple &page= param — approximated here as 24-per-page
    // offsets. Best-effort: verify live if pages beyond 1 stop returning
    // new results.
    strategies: [
      {
        kind: "search",
        buildUrl: (query, page) =>
          `https://www.depop.com/search/?q=${encodeURIComponent(query)}${page > 1 ? `&offset=${(page - 1) * 24}` : ""}`,
      },
      {
        kind: "search-newest",
        buildUrl: (query, page) =>
          `https://www.depop.com/search/?q=${encodeURIComponent(query)}&sort=newlyListed${page > 1 ? `&offset=${(page - 1) * 24}` : ""}`,
      },
    ],
    productPattern: /^https:\/\/www\.depop\.com\/products\//,
    concurrency: 4,
    minDelayMs: 400,
  },
  {
    platform: "Poshmark",
    strategies: [
      {
        kind: "search",
        buildUrl: (query, page) =>
          `https://poshmark.com/search?query=${encodeURIComponent(query)}${page > 1 ? `&page=${page}` : ""}`,
      },
      {
        kind: "search-available",
        buildUrl: (query, page) =>
          `https://poshmark.com/search?query=${encodeURIComponent(query)}&availability=available${page > 1 ? `&page=${page}` : ""}`,
      },
    ],
    productPattern: /^https:\/\/poshmark\.com\/listing\//,
    concurrency: 3,
    minDelayMs: 600,
  },
  {
    platform: "eBay",
    // Added per this feature's own spec ("Depop, Vinted, eBay, Poshmark").
    // marketplace-discovery.ts's own header comment documents that eBay
    // returned a hard 403 to this exact headless-browser setup when last
    // verified live — kept in SCALED_SOURCES for the ordinary (non-
    // aggressive) large-scale path, but EXCLUDED from
    // AGGRESSIVE_DISCOVERY_PLATFORMS below (discovery redesign requirement
    // 4: "remove eBay from aggressive overnight discovery until a valid
    // strategy exists") — a live trace showed 100% of its requests were an
    // instant 403, contributing zero URLs while still consuming a worker
    // slot every round.
    strategies: [
      {
        kind: "search",
        buildUrl: (query, page) =>
          `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(query)}${page > 1 ? `&_pgn=${page}` : ""}`,
      },
    ],
    productPattern: /^https:\/\/www\.ebay\.com\/itm\//,
    concurrency: 3,
    minDelayMs: 600,
  },
];

// Discovery redesign requirement 4 — the platform set OVERNIGHT_AGGRESSIVE
// actually crawls; eBay stays in SCALED_SOURCES (above) for the ordinary
// large-scale path but is excluded here until a working eBay strategy
// exists (see that source's own comment).
export const AGGRESSIVE_DISCOVERY_PLATFORMS = ["Vinted", "Depop", "Poshmark"];

// How many pages deep one query is allowed to go before this run gives up
// on it and moves to the next query — bounded so a single popular query
// can't monopolize a whole crawl pass once page 1 is exhausted for
// everything else.
const DEFAULT_MAX_PAGES_PER_QUERY = 5;
// How many (query, page) combinations one platform worker pulls per call.
//
// INVENTORY GROWTH ZERO-PROGRESS ROOT CAUSE (confirmed live): every large-
// scale run now goes through process-batch/route.ts's single bounded
// call (SINGLE_BATCH_CALL_TIMEOUT_MS, scraper-config.ts) — there is no
// standalone/overnight process anymore that this constant's old value of
// 60 was actually sized for. A real page visit measured live at ~6.5-7s
// average latency; at a platform's own concurrency (3-4), 60 combinations
// alone need multiple minutes to finish — the outer batch watchdog fires
// long before a single round can complete, discarding all of that
// round's real (in-memory) progress and advancing current_round on zero
// credited work, forever, with no error ever surfaced (see
// process-batch/route.ts's own zero-progress-watchdog fix). Lowered so a
// full discovery pass for one platform reliably finishes within a few
// concurrency waves, leaving real time in the same call's budget for
// extraction.
const COMBINATIONS_PER_CALL = 15;

function debugLog(message: string): void {
  console.warn(`[scaled-discovery] ${message}`);
}

// ---------------------------------------------------------------------------
// Global discovery worker concurrency — added after a live incident: the
// admin dashboard's "Active discovery workers: 15" (3 platforms x the old
// OVERNIGHT_AGGRESSIVE_CONFIG.discoveryWorkers=5, see scraper-config.ts)
// combined with this machine's actual load average (98-144, confirmed
// independently of any code bug) to make every single page.goto() across
// every platform time out at 130,000+ms against a 5,000ms cap. This is a
// TRUE global cap — configurable via the DISCOVERY_CONCURRENCY env var —
// on how many individual page-search attempts run at once across ALL
// platforms combined, not a per-platform number that still multiplies out
// to something larger. Each platform's own `concurrency` field in
// SCALED_SOURCES above still bounds its own local fan-out, but this is the
// real ceiling now: replaces the old aggressive-mode concurrencyOverride
// entirely (see runAggressiveRound's own call site in admin-scraper.ts).
// Lives in scraper-config.ts now (Inventory Growth "HTML 500" fix — see
// this file's own import of it, and that file's own comment) — re-export
// kept here so nothing that still imports it from
// "@/lib/inventory/scaled-discovery" breaks.
export { DISCOVERY_CONCURRENCY };

let activeDiscoverySlots = 0;
const discoveryWaitQueue: Array<() => void> = [];

async function acquireDiscoverySlot(): Promise<void> {
  if (activeDiscoverySlots < DISCOVERY_CONCURRENCY) {
    activeDiscoverySlots++;
    return;
  }
  await new Promise<void>((resolve) => discoveryWaitQueue.push(resolve));
  activeDiscoverySlots++;
}

function releaseDiscoverySlot(): void {
  activeDiscoverySlots--;
  const next = discoveryWaitQueue.shift();
  if (next) next();
}

// ---------------------------------------------------------------------------
// Startup resource warning — checked once before a large-scale run starts
// (see runLargeScaleAdminScraper's own call), not per-batch or per-round:
// this is about whether the MACHINE looks overloaded right now, which
// doesn't change meaningfully within the seconds between rounds. Purely
// informational — never blocks or reduces anything on its own; an admin
// reading the log decides whether to act on it.
// ---------------------------------------------------------------------------
const LOAD_PER_CORE_WARNING_THRESHOLD = 1.5;

export function checkStartupResources(): void {
  const [load1] = os.loadavg();
  const cores = os.cpus().length || 1;
  const loadPerCore = load1 / cores;

  if (loadPerCore > LOAD_PER_CORE_WARNING_THRESHOLD) {
    const recommendedWorkers = Math.max(1, Math.floor(DISCOVERY_CONCURRENCY / loadPerCore));
    console.warn("[SCRAPER RESOURCE WARNING]", {
      loadAverage: load1,
      recommendedWorkers,
    });
  }
}

// Module-level (persists for the process's lifetime, across every call —
// deliberately not reset per call) — "independent rate limiting" per
// platform: no two requests to the SAME platform start less than
// minDelayMs apart, regardless of how many separate discoverListingUrlsAtScale
// calls span that window over the course of a long overnight run.
const lastRequestAtByPlatform: Record<string, number> = {};

async function waitForRateLimit(platform: string, minDelayMs: number, signal?: AbortSignal): Promise<void> {
  const last = lastRequestAtByPlatform[platform] ?? 0;
  const wait = last + minDelayMs - Date.now();
  // Cancellation fix — exits early on abort instead of always waiting out
  // the full rate-limit gap; the caller (crawlPlatform) checks
  // signal.aborted again immediately after this returns.
  if (wait > 0) {
    try {
      await abortableDelay(wait, signal);
    } catch {
      return;
    }
  }
  lastRequestAtByPlatform[platform] = Date.now();
}

// Discovery efficiency fix — a query whose most recent EXHAUSTED_ZERO_STREAK
// consecutive ATTEMPTED pages (in page order, not necessarily pages 1..N)
// all returned 0 new URLs is treated as exhausted for every page it hasn't
// tried yet too, not just the ones already tried. Root cause this
// addresses: pickNextCombinations previously only asked "has this exact
// (query, page) been tried," so once a query's early pages came up empty
// it would still eventually reach that same query's page 3/4/5 (breadth-
// first ordering just delays it) and burn a pick on a combination
// overwhelmingly likely to also be empty — a real search with ANY
// inventory almost always surfaces some of it by page 1-2; the reverse
// (nothing on page 1-2, real results on page 3+) is rare enough that
// skipping ahead is worth the small risk of missing it. Confirmed live:
// with a fixed query vocabulary and every (query, page) ever tried
// recorded permanently, a long-running job eventually exhausts the WHOLE
// space this way, producing the "no unprocessed combinations left" state
// this file already warns about.
const EXHAUSTED_ZERO_STREAK = 2;

/**
 * A query is exhausted once its most recent EXHAUSTED_ZERO_STREAK
 * attempted pages (by page number, in order — not necessarily contiguous
 * if some pages were skipped for other reasons) all found 0 new URLs.
 * Queries with fewer attempted pages than that are never exhausted yet —
 * there isn't enough signal to give up on them.
 */
function computeExhaustedQueries(yields: ReadonlyMap<string, QueryPageYield[]>): Set<string> {
  const exhausted = new Set<string>();
  for (const [query, pages] of yields) {
    if (pages.length < EXHAUSTED_ZERO_STREAK) continue;
    const trailing = pages.slice(-EXHAUSTED_ZERO_STREAK);
    if (trailing.every((p) => p.urlsFound === 0)) exhausted.add(query);
  }
  return exhausted;
}

/**
 * Reorders (never mutates — allGeneratedQueries()'s own cached array must
 * stay exactly as generated) queries by total observed yield, descending,
 * so a query already PROVEN productive gets first crack at its next
 * untried page rather than one that's merely never been tried (or one
 * that's already exhausted — those are filtered out separately, in
 * pickNextCombinations below, not by sorting). Ties (including every
 * never-tried query, all at yield 0) keep their original relative order —
 * Array.prototype.sort is a stable sort per the JS spec — which is what
 * keeps this fully deterministic across restarts (see query-generator.ts's
 * own header comment on why determinism matters here).
 */
function prioritizeQueriesByYield(allQueries: string[], yields: ReadonlyMap<string, QueryPageYield[]>): string[] {
  const totalYield = (query: string): number => {
    const pages = yields.get(query);
    return pages ? pages.reduce((sum, p) => sum + p.urlsFound, 0) : 0;
  };
  return [...allQueries].sort((a, b) => totalYield(b) - totalYield(a));
}

// Breadth-first across queries: every (non-exhausted) query's PAGE 1 is
// tried before any query's page 2, which is tried before any query's page
// 3, etc. — the direct fix for "never repeatedly scrape only page 1"
// (requirement 3): once every query in the generator's list has a
// processed page 1, this naturally starts returning page 2 for each
// instead of stalling out or re-processing page 1 again.
function pickNextCombinations(
  allQueries: string[],
  processed: ReadonlySet<string>,
  exhaustedQueries: ReadonlySet<string>,
  count: number,
  maxPagesPerQuery: number,
): { query: string; page: number }[] {
  const picks: { query: string; page: number }[] = [];
  const loggedExhausted = new Set<string>();

  for (let page = 1; page <= maxPagesPerQuery && picks.length < count; page++) {
    for (const query of allQueries) {
      if (picks.length >= count) break;

      if (exhaustedQueries.has(query)) {
        // Logged once per query per call (not once per skipped page) —
        // this loop revisits every exhausted query on every page
        // iteration by design, so gating on the FIRST time we see it
        // keeps this from spamming maxPagesPerQuery lines per query.
        if (!loggedExhausted.has(query)) {
          loggedExhausted.add(query);
          console.log(`[discovery] exhausted query skipped query="${query}"`);
        }
        continue;
      }

      if (!isQueryPageProcessed(processed, query, page)) {
        picks.push({ query, page });
      }
    }
  }

  return picks;
}

interface PlatformCrawlResult {
  pagesSearched: number;
  queriesUsed: Set<string>;
}

async function crawlPlatform(
  source: ScaledSource,
  excludeUrls: ReadonlySet<string>,
  sharedFound: Map<string, DiscoveredCandidate>,
  targetTotal: number,
  maxPagesPerQuery: number,
  concurrencyOverride?: number,
  // Discovery redesign requirement 1 — invoked the moment a SINGLE page
  // succeeds, with just that page's new candidates, so a caller (the
  // aggressive-mode round in admin-scraper.ts) can enqueue them into
  // scraper_url_queue immediately instead of waiting for this whole
  // platform (or every platform, via discoverListingUrlsAtScale's own
  // Promise.all) to finish. Optional and purely additive — sharedFound is
  // still populated exactly as before for callers that only want the
  // final batched return.
  onUrlsFound?: (candidates: DiscoveredCandidate[]) => Promise<void> | void,
  // Cancellation fix — see discoverListingUrlsAtScale's own comment.
  signal?: AbortSignal,
): Promise<PlatformCrawlResult> {
  const queriesUsed = new Set<string>();
  let pagesSearched = 0;

  if (signal?.aborted) {
    debugLog(`${source.platform}: aborted before starting — no new work launched`);
    return { pagesSearched, queriesUsed };
  }

  const [processed, yields] = await Promise.all([
    getProcessedQueries(source.platform),
    getQueryYields(source.platform),
  ]);
  const exhaustedQueries = computeExhaustedQueries(yields);
  const prioritizedQueries = prioritizeQueriesByYield(allGeneratedQueries(), yields);
  const picks = pickNextCombinations(prioritizedQueries, processed, exhaustedQueries, COMBINATIONS_PER_CALL, maxPagesPerQuery);

  if (picks.length === 0) {
    debugLog(`${source.platform}: no unprocessed query/page combinations left within ${maxPagesPerQuery} pages`);
    return { pagesSearched, queriesUsed };
  }

  let browser: Browser | null = null;

  // Recovery mechanism — if EVERY attempt this pass timed out (a strong
  // signal of local resource exhaustion, exactly as observed live: 130s+
  // average latency against a 5s cap, uniformly across every platform),
  // back off for 30s and retry the SAME picks once more at reduced
  // concurrency, rather than either hammering an already-overloaded
  // machine again immediately or giving up on real candidates entirely.
  // Not a loop — one retry only, so a genuinely down/unreachable platform
  // still moves on rather than stalling a batch indefinitely.
  const RECOVERY_WAIT_MS = 30_000;
  let attemptedCount = 0;
  let timeoutCount = 0;

  async function runPass(concurrency: number): Promise<void> {
    attemptedCount = 0;
    timeoutCount = 0;

    await mapWithConcurrency(picks, concurrency, async ({ query, page }, index) => {
      if (sharedFound.size >= targetTotal) return;

      // Cancellation fix — stop launching new attempts the moment an
      // abort is observed; in-flight attempts (already past this check)
      // are interrupted separately below via their own page/context.
      if (signal?.aborted) return;

      // Discovery redesign requirement 2/4 — marketplace-health's circuit
      // breaker. Skipped WITHOUT calling recordDiscoveryRun below, so this
      // exact combination is retried later (once the platform recovers)
      // rather than being permanently marked "already tried."
      if (!isPlatformEnabled(source.platform)) {
        // Previously a completely silent return — made every disabled
        // platform indistinguishable from "searched but found nothing" in
        // the logs, which is exactly the ambiguity a live "why is this
        // marketplace at 0%" investigation needs resolved.
        console.log("[DISCOVERY WORKER]", {
          marketplace: source.platform,
          query,
          success: false,
          urlsFound: 0,
          error: "platform disabled (marketplace-health circuit breaker)",
        });
        return;
      }

      await waitForRateLimit(source.platform, source.minDelayMs, signal);
      if (signal?.aborted) return;

      // Global discovery concurrency gate (DISCOVERY_CONCURRENCY) — see
      // its own header comment. Acquired per-attempt, right before the
      // actual page work starts, released in the finally below alongside
      // everything else this attempt touches.
      await acquireDiscoverySlot();
      attemptedCount++;

      // Rotate strategies round-robin (requirement 5) — see SCALED_SOURCES'
      // own comment on the honest scope of what a "strategy" means here.
      const strategy = source.strategies[index % source.strategies.length];

      let context: BrowserContext | null = null;
      let pageHandle: Page | null = null;
      let urlsFoundThisPage = 0;
      const attemptStart = Date.now();
      let abortedThisAttempt = false;
      let wasAborted = false;
      // Cancellation fix — page.goto()/waitForLoadState() have no
      // AbortSignal support of their own; closing the page/context out
      // from under them is the supported way to interrupt an in-flight
      // navigation (both reject almost immediately with a "Target
      // closed"-style error, which the catch block below recognizes via
      // `abortedThisAttempt`/signal.aborted rather than treating it as a
      // genuine marketplace failure).
      const onAbort = () => {
        abortedThisAttempt = true;
        pageHandle?.close().catch(() => {});
        context?.close().catch(() => {});
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      try {
        context = await browser!.newContext({
          userAgent: BROWSER_USER_AGENT,
          viewport: { width: 1280, height: 900 },
        });
        pageHandle = await context.newPage();
        const response = await pageHandle.goto(strategy.buildUrl(query, page), {
          waitUntil: "domcontentloaded",
          timeout: PAGE_NAV_TIMEOUT_MS,
        });

        const status = response?.status();
        if (status && BLOCKED_STATUS_CODES.has(status)) {
          debugLog(`${source.platform} blocked request (status ${status}) for "${query}" page ${page}: skipping`);
          recordDiscoveryAttempt(source.platform, "blocked", Date.now() - attemptStart);
          console.log("[DISCOVERY WORKER]", {
            marketplace: source.platform,
            query,
            success: false,
            urlsFound: 0,
            error: `blocked (status ${status})`,
          });
          return;
        }

        try {
          await pageHandle.waitForLoadState("networkidle", { timeout: PAGE_NAV_TIMEOUT_MS });
        } catch {
          // Background network chatter never stopped — proceed with
          // whatever rendered anyway (same tradeoff as
          // marketplace-discovery.ts's own crawl).
        }
        await pageHandle.waitForTimeout(SETTLE_MS);

        const candidates = await extractProductLinksWithPriceHints(pageHandle, source.productPattern, source.platform);
        const newThisPage: DiscoveredCandidate[] = [];
        let duplicatesThisPage = 0;
        for (const { url, priceHint, platform } of candidates) {
          const normalized = normalizeUrl(url) ?? url;
          if (excludeUrls.has(normalized) || sharedFound.has(normalized)) {
            duplicatesThisPage++;
            continue;
          }
          const candidate = { url: normalized, priceHint, platform };
          sharedFound.set(normalized, candidate);
          newThisPage.push(candidate);
          urlsFoundThisPage++;
        }

        // Discovery/extraction handoff tracing — this is the discovery-side
        // dedup point (against this run's own excludeUrls/sharedFound),
        // distinct from the later post-extraction dedup in admin-scraper.ts's
        // filterOutDuplicateCandidates. Logged unconditionally (not just on
        // a nonzero count) so "0 raw links this page" is just as visible in
        // a trace as "12 links, all duplicates" — both look identical
        // downstream (0 new URLs) but have very different causes.
        if (candidates.length > 0) {
          console.log("[DISCOVERY] URLs discovered", {
            marketplace: source.platform,
            query,
            page,
            rawLinksFound: candidates.length,
            newUrls: urlsFoundThisPage,
            duplicatesFiltered: duplicatesThisPage,
          });
        }

        // "empty_response" (marketplace answered, nothing usable) is now a
        // distinct, genuinely marketplace-specific circuit-breaker signal
        // from "success" — see marketplace-health.ts's own header comment
        // on why lumping every non-blocked response into "success"
        // regardless of whether it found anything made the breaker unable
        // to tell "the marketplace is fine, we're just between hits" from
        // "the marketplace answered but nothing usable ever comes back."
        const outcome = candidates.length === 0 ? "empty_response" : "success";
        recordDiscoveryAttempt(source.platform, outcome, Date.now() - attemptStart);
        if (newThisPage.length > 0 && onUrlsFound) await onUrlsFound(newThisPage);

        debugLog(
          `${source.platform} [${strategy.kind}] / "${query}" page ${page}: ${candidates.length} links, ${urlsFoundThisPage} new`,
        );
        console.log("[DISCOVERY WORKER]", {
          marketplace: source.platform,
          query,
          success: outcome === "success",
          urlsFound: urlsFoundThisPage,
          error: outcome === "empty_response" ? "responded successfully but returned no usable data" : null,
        });
      } catch (error) {
        // Cancellation fix — a page/context closed BECAUSE of our own
        // abort must never be classified as a marketplace/network
        // failure: no circuit-breaker hit (recordDiscoveryAttempt below)
        // and no "already tried, found nothing" history entry
        // (recordDiscoveryRun in the finally block, skipped when aborted)
        // — this combination genuinely was never attempted to completion,
        // so a future run must still be free to try it for real.
        wasAborted = abortedThisAttempt || error instanceof BatchAbortedError || Boolean(signal?.aborted);

        if (wasAborted) {
          debugLog(`${source.platform} / "${query}" page ${page} — cancelled (batch aborted), not a failure`);
          console.log("[DISCOVERY WORKER]", {
            marketplace: source.platform,
            query,
            success: false,
            urlsFound: 0,
            error: "cancelled (batch aborted)",
          });
        } else {
          const reason = error instanceof Error ? error.message : String(error);
          const outcome = /timeout/i.test(reason) ? "timeout" : "error";
          if (outcome === "timeout") timeoutCount++;
          recordDiscoveryAttempt(source.platform, outcome, Date.now() - attemptStart);
          debugLog(`${source.platform} / "${query}" page ${page} failed: ${reason}`);
          console.log("[DISCOVERY WORKER]", {
            marketplace: source.platform,
            query,
            success: false,
            urlsFound: 0,
            error: reason,
          });
        }
      } finally {
        signal?.removeEventListener("abort", onAbort);
        releaseDiscoverySlot();
        // Pages are always closed before their context — closing a
        // context implicitly closes its pages too, but doing this
        // explicitly means a page that's somehow still holding resources
        // (a stuck render, a pending request) doesn't wait on the
        // context-level teardown to let go of them.
        if (pageHandle) {
          try {
            await pageHandle.close();
          } catch {
            // Already closed/crashed — nothing left to release.
          }
        }
        if (context) await context.close();

        if (!wasAborted) {
          pagesSearched++;
          queriesUsed.add(query);
          // Recorded even on 0 results / a failed visit — a page that's
          // been tried and came up empty is exactly the combination that
          // must NOT be retried next round; only that (never re-crawling
          // a combination whether or not it panned out) is what keeps the
          // duplicate rate from climbing the way it did before this
          // module existed. Skipped entirely when aborted (see the catch
          // block above) — an aborted attempt was never really tried.
          await recordDiscoveryRun(source.platform, query, page, urlsFoundThisPage);
          // Logged unconditionally here (not in the success-only branch
          // above) so it always matches exactly what recordDiscoveryRun
          // just persisted, whether this attempt succeeded, was blocked,
          // or threw.
          console.log(`[discovery] query="${query}" results=${urlsFoundThisPage}`);
        }
      }
    });
  }

  try {
    // Cancellation fix — never acquire a new browser after abort.
    if (signal?.aborted) {
      debugLog(`${source.platform}: aborted before acquiring a browser — no new work launched`);
      return { pagesSearched, queriesUsed };
    }
    browser = await acquirePooledBrowser(await resolveBrowserLaunchOptions({ headless: true, timeout: LAUNCH_TIMEOUT_MS }));

    await runPass(concurrencyOverride ?? source.concurrency);

    if (!signal?.aborted && attemptedCount > 0 && timeoutCount === attemptedCount) {
      console.warn(
        `[scaled-discovery] ${source.platform}: all ${attemptedCount} attempt(s) timed out this pass — ` +
          `waiting ${RECOVERY_WAIT_MS / 1000}s and retrying once at reduced concurrency ` +
          "(likely local resource exhaustion, not a marketplace-specific problem).",
      );
      try {
        await abortableDelay(RECOVERY_WAIT_MS, signal);
      } catch {
        debugLog(`${source.platform}: aborted during recovery-wait backoff — skipping the retry pass`);
        return { pagesSearched, queriesUsed };
      }
      const reducedConcurrency = Math.max(1, Math.floor((concurrencyOverride ?? source.concurrency) / 2));
      await runPass(reducedConcurrency);
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`[scaled-discovery] ${source.platform} browser launch/crawl failed:`, reason);
  } finally {
    // browser stays null only if acquirePooledBrowser itself threw — the
    // pool's own bookkeeping never reserved anything in that case (see its
    // header comment), so there is nothing to release back to it.
    if (browser) releasePooledBrowser(browser);
  }

  return { pagesSearched, queriesUsed };
}

export interface ScaledDiscoveryResult {
  urls: string[];
  queriesCompleted: number;
  pagesSearched: number;
  uniqueUrlsDiscovered: number;
}

/**
 * Parallel, independently-rate-limited, paginated discovery across every
 * platform in SCALED_SOURCES — requirement 4 of the discovery-scaling
 * spec. Each platform is its own independent worker (own concurrency
 * pool, own rate limiter, own discovery-history lookup) feeding one
 * shared result map; `Promise.all` below is what makes them run
 * concurrently rather than one after another. Never throws — a single
 * platform's browser/crawl failure is caught and logged inside
 * crawlPlatform, same "one bad source never aborts the whole discovery
 * pass" posture as marketplace-discovery.ts's own crawl.
 */
// Discovery -> extraction handoff fix — a live funnel audit found
// unique_urls_discovered (thousands, per a real completed job: 4,927)
// wildly outnumbering what ever reached extraction (84), a ~98% loss.
// Root cause: this function used to return
// `[...sharedFound.keys()].slice(0, targetCount)` — targetCount (30-150,
// see admin-scraper.ts's ROUND_DISCOVERY_MULTIPLIER/MAX_ROUND_DISCOVERY_
// TARGET) is meant to control when crawlPlatform STOPS looking for more
// (checked per-attempt inside its mapWithConcurrency loop), not how many
// of what it already found get handed to the caller. Because every
// platform's own concurrency keeps several page-fetches in flight at
// once, sharedFound routinely overshoots targetCount well before any
// worker notices — a single Vinted page alone can return 96 links — so
// the slice was silently discarding the overwhelming majority of what
// discovery had already paid the cost of finding. Non-aggressive mode
// (the only caller that reads this return value directly, rather than
// consuming per-page results via onUrlsFound as they're found — see
// runAggressiveRound's own callback) had no other path back to those
// URLs: once sliced away here, they were never queued, never extracted,
// never retried.
//
// Fixed by returning EVERY key in sharedFound, unconditionally.
// targetCount's only remaining job is exactly what it always should have
// been: a stopping signal for crawlPlatform's own discovery loop
// (`sharedFound.size >= targetTotal`, unchanged, still checked there and
// nowhere else). Whatever's already in sharedFound by the time every
// platform's Promise.all resolves — including URLs found by attempts
// that were already in flight when the stopping threshold was crossed —
// survives into the returned array. Factored into its own function
// (rather than inlined into the return statement) specifically so this
// no-truncation guarantee has a single, direct unit test (see
// tests/scaled-discovery.test.ts) instead of relying on a full
// Playwright-driven integration run to notice a regression here.
export function collectDiscoveredUrls(sharedFound: ReadonlyMap<string, DiscoveredCandidate>): string[] {
  return [...sharedFound.keys()];
}

export async function discoverListingUrlsAtScale(
  targetCount: number,
  excludeUrls: ReadonlySet<string>,
  maxPagesPerQuery: number = DEFAULT_MAX_PAGES_PER_QUERY,
  // OVERNIGHT_AGGRESSIVE's discoveryWorkers (scraper-config.ts) — widens
  // EVERY platform's own concurrency ceiling by the same amount when set,
  // rather than one flat number split across platforms (each platform
  // keeps its own independent rate limiter regardless).
  concurrencyOverride?: number,
  // Discovery redesign requirement 4 — restricts the crawl to this exact
  // platform set (by `source.platform` name); omitted = every
  // SCALED_SOURCES entry, same as before this parameter existed.
  allowedPlatforms?: string[],
  // Discovery redesign requirement 1 — streamed per-page, per-platform, as
  // soon as each page succeeds (see crawlPlatform's own comment). Purely
  // additive: `urls`/`uniqueUrlsDiscovered` below are still populated from
  // the same sharedFound map exactly as before for any caller that only
  // wants the final batched result.
  onUrlsFound?: (candidates: DiscoveredCandidate[]) => Promise<void> | void,
  // Cancellation fix — only ever set by Inventory Growth's own per-attempt
  // AbortController (runLargeScaleAdminScraper via runAdminScraper); every
  // other caller omits it. crawlPlatform stops launching new page-search
  // attempts and closes its active page/context the moment this aborts.
  signal?: AbortSignal,
): Promise<ScaledDiscoveryResult> {
  const sharedFound = new Map<string, DiscoveredCandidate>();
  const sources = allowedPlatforms ? SCALED_SOURCES.filter((s) => allowedPlatforms.includes(s.platform)) : SCALED_SOURCES;

  const results = await Promise.all(
    sources.map((source) =>
      crawlPlatform(source, excludeUrls, sharedFound, targetCount, maxPagesPerQuery, concurrencyOverride, onUrlsFound, signal),
    ),
  );

  const queriesUsed = new Set<string>();
  let pagesSearched = 0;
  for (const result of results) {
    pagesSearched += result.pagesSearched;
    for (const query of result.queriesUsed) queriesUsed.add(query);
  }

  const urls = collectDiscoveredUrls(sharedFound);

  // Funnel visibility (before this fix, the only number ever logged here
  // was uniqueUrlsDiscovered — the "urls returned" count wasn't visible
  // anywhere, which is exactly how a 98% silent loss went unnoticed).
  // "queued" isn't tracked here — this function doesn't know which of its
  // callers durably enqueue vs. consume `urls` directly; see admin-
  // scraper.ts's own [FUNNEL] log for the queued/extractionAttempts counts
  // once a caller's onUrlsFound (or direct use of `urls`) has run.
  console.log("[FUNNEL] discovery", {
    discovered: sharedFound.size,
    urlsReturned: urls.length,
  });

  return {
    urls,
    queriesCompleted: queriesUsed.size,
    pagesSearched,
    uniqueUrlsDiscovered: sharedFound.size,
  };
}
