// Discovers fresh product-listing URLs by crawling marketplace search
// results — the piece the single-URL importer (src/lib/listing-extraction.ts)
// doesn't have: that pipeline only ever processes a URL it's already been
// given. This is what lets /admin/import's bulk button find 100+ URLs on
// its own with no admin-supplied list.
//
// Only Vinted, Depop, and Poshmark are included — verified live (not
// assumed) that Etsy and eBay both return a hard 403 to a request from
// this exact headless-browser setup, before any DOM/selector concern even
// applies. That matches this project's earlier, separate finding that
// Depop/eBay bot-wall plain fetch() requests (see html-extractor.ts) —
// here a real rendered browser gets further with Depop, but Etsy and eBay
// still refuse the connection outright. If either ever opens back up,
// add it to DISCOVERY_SOURCES below; nothing else needs to change.
//
// Grailed was removed entirely (not just deprioritized): verified live its
// actual listing prices skew far higher than Depop/Poshmark/Vinted's for
// the same search terms (e.g. "cargo pants" returned $148 designer pieces
// on Grailed vs. $8-$28 elsewhere), and it's also a much more male-skewing
// resale platform than the rest of Lockette's sourcing — a bad fit on both
// axes for "affordable thrift find," not something the price-bias ordering
// alone should be relied on to paper over.
import { chromium, type Page } from "playwright";
import { SELECTED_CATEGORY_OPTIONS, type SelectedCategory } from "@/lib/selected-categories";
import { SELECTED_BRAND_OPTIONS, type SelectedBrand } from "@/lib/selected-brands";
import { mapWithConcurrency } from "@/lib/concurrency";
import {
  acquireBrowserSlot,
  registerBrowserLaunch,
  registerBrowserClose,
  releaseBrowserSlotOnLaunchFailure,
} from "@/lib/browser-concurrency";
import { resolveBrowserLaunchOptions } from "@/lib/browser-launch-options";

// Re-exported so existing importers of this module (bulk-import.ts, the
// discover/process-batch API routes) don't need to know the type/options
// actually live in selected-categories.ts/selected-brands.ts — that split
// exists purely so ImportListingView.tsx (a client component) can import
// the options lists without pulling this file's Playwright dependency into
// the client bundle.
export { SELECTED_CATEGORY_OPTIONS, SELECTED_BRAND_OPTIONS };
export type { SelectedCategory, SelectedBrand };

// The three price tiers exposed in /admin/import's Price Mode control. Both
// here (search-term/ordering bias) and src/lib/bulk-import.ts (ranking's
// soft cheap-listing preference) treat this as a preference, not a hard
// ceiling — see bulk-import.ts's priceModeValueScore for why a hard reject
// tied to this was removed (it was rejecting ~98% of real candidates).
export type PriceMode = "under10" | "under20" | "any";

// SelectedCategory (src/lib/selected-categories.ts) is the admin's own
// explicit /admin/import selection ("I can run: Import 100 under $10 ONLY
// low-rise jeans + tops") — distinct from src/lib/bulk-import.ts's
// CategoryBucket (tops/dresses/bottoms/outerwear/accessories/shoes/other),
// an internal, coarse classification used only for run-wide category
// BALANCE. The exact per-category search terms below are this feature's spec.
const SELECTED_CATEGORY_SEARCH_TERMS: Record<SelectedCategory, string[]> = {
  "low-rise-jeans": ["low rise jeans", "y2k low rise denim", "vintage low rise jeans"],
  "low-rise-shorts": ["low rise shorts", "y2k shorts"],
  "low-rise-skirts": ["low rise mini skirt", "y2k skirt"],
  tops: ["baby tee", "tank top", "camisole", "graphic tee", "y2k top"],
  dresses: ["mini dress", "floral dress", "slip dress"],
  skirts: ["mini skirt", "vintage skirt"],
  "sweaters-jackets": ["cardigan", "zip hoodie", "sweater", "light jacket"],
};

// Exported alongside the two DOM-scraping helpers above for
// scaled-discovery.ts's reuse — same browser identity/timeouts/blocked-
// status handling as this file's own crawl, not a second copy.
export const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

// Lowered from 15_000 (Inventory Growth discovery redesign) — a live trace
// showed EVERY Vinted/Depop/Poshmark navigation paying the full old 15s
// ceiling with a 0% success rate, meaning discovery's own timeout was the
// single biggest cost in the whole pipeline: at concurrency 5/platform,
// that's only 20 attempts/minute/platform even before considering that
// none of them succeeded. 5s fails faster per attempt (more attempts/min
// against the SAME 0% success rate) and, paired with marketplace-health.ts's
// circuit breaker below, stops burning time on a platform that's
// consistently failing well before it would have under the old ceiling.
export const PAGE_NAV_TIMEOUT_MS = 5_000;
// Networkidle doesn't guarantee the results grid has actually finished
// rendering (same caveat as browser-extractor.ts) — a short settle window
// after the best-effort networkidle wait catches most of the remainder.
export const SETTLE_MS = 2_000;
// Explicit rather than relying on Playwright's own default (also 30s) —
// see this file's own chromium.launch() call for why.
export const LAUNCH_TIMEOUT_MS = 15_000;
// Same list as browser-extractor.ts/html-extractor.ts's own
// BLOCKED_STATUS_CODES — a search page returning one of these means the
// platform is actively blocking/rate-limiting this crawl, not that the
// search genuinely has no results.
export const BLOCKED_STATUS_CODES = new Set([403, 429, 503]);

interface DiscoverySource {
  platform: string;
  searchUrl: (term: string) => string;
  productPattern: RegExp;
}

const DISCOVERY_SOURCES: DiscoverySource[] = [
  {
    platform: "Vinted",
    searchUrl: (term) => `https://www.vinted.com/catalog?search_text=${encodeURIComponent(term)}`,
    productPattern: /^https:\/\/www\.vinted\.com\/items\//,
  },
  {
    platform: "Depop",
    searchUrl: (term) => `https://www.depop.com/search/?q=${encodeURIComponent(term)}`,
    productPattern: /^https:\/\/www\.depop\.com\/products\//,
  },
  {
    platform: "Poshmark",
    searchUrl: (term) => `https://poshmark.com/search?query=${encodeURIComponent(term)}`,
    productPattern: /^https:\/\/poshmark\.com\/listing\//,
  },
];

// "Weight discovery: Vinted 50%, Depop 40%, Poshmark 10%" — applied to the
// final candidate list (see buildWeightedSelection below), not to how often
// each platform's search pages get crawled: every (term, platform)
// combination is still visited during the crawl itself so nothing loses
// coverage, but once results are in, the returned candidate list is
// interleaved to approximate this split.
const PLATFORM_WEIGHTS: Record<string, number> = {
  Vinted: 0.5,
  Depop: 0.4,
  Poshmark: 0.1,
};
const PLATFORM_NAMES = Object.keys(PLATFORM_WEIGHTS);

// Grouped by aesthetic rather than one flat list — narrow "vintage/leather
// jacket"-only searches (the old list) reliably surface expensive
// outerwear, which is exactly the skew this rebalance is fixing. Grouping
// also lets buildRoundRobinSearchTerms() below sample evenly across every
// aesthetic instead of exhausting one category before ever reaching the
// others.
const SEARCH_TERM_GROUPS: Record<string, string[]> = {
  y2k: ["y2k top", "y2k tank", "y2k baby tee", "y2k skirt", "y2k jeans", "y2k dress", "rhinestone top"],
  coquette: ["lace top", "bow top", "camisole", "babydoll top", "satin top", "floral dress"],
  indieSleaze: ["vintage band tee", "graphic tee", "low rise jeans", "mini skirt", "distressed denim"],
  cottagecore: ["linen top", "crochet top", "floral blouse", "embroidered top", "flowy dress"],
  vintage: ["vintage blouse", "vintage sweater", "vintage denim", "vintage skirt", "vintage dress"],
  streetwear: ["oversized hoodie", "cargo pants", "graphic tee", "streetwear top"],
  general: ["cute thrift finds", "thrift haul", "affordable vintage", "unique clothing", "closet cleanout"],
  // Search strategy aimed specifically at surfacing cheap listings: sellers
  // signaling they want an item gone fast (moving, closet cleanout, "need
  // gone") tend to price well below market, and appending a price-signaling
  // word to an otherwise-normal search term (the last two entries) tends to
  // surface the same items a seller has already priced to move.
  priceFriendly: [
    "cheap thrift finds",
    "budget clothing haul",
    "closet cleanout",
    "moving sale clothes",
    "need gone clothes",
    "thrift under 10",
    "y2k tank cheap",
    "vintage skirt under 10",
    "closet cleanout tops",
  ],
};

// Interleaves the groups given (one term per group per round) rather than
// concatenating them — a crawl that stops early (targetCount reached)
// still gets a broad sample across every group this way, instead of the
// run's early stop always favoring whichever group happened to be listed
// first. Deduplicated afterward since a couple of terms (e.g. "graphic tee")
// intentionally appear in more than one group in the specs this was built
// from — visiting the identical search query twice wastes a page visit
// for zero new information. Generic over the group list so it serves both
// the default aesthetic groups below and buildSearchTermsForSelectedCategories.
function interleaveGroups(groups: string[][]): string[] {
  const maxLen = Math.max(...groups.map((group) => group.length));
  const ordered: string[] = [];

  for (let i = 0; i < maxLen; i++) {
    for (const group of groups) {
      if (group[i]) ordered.push(group[i]);
    }
  }

  return [...new Set(ordered)];
}

const SEARCH_TERMS = interleaveGroups(Object.values(SEARCH_TERM_GROUPS));

// Used only when the admin has selected specific categories on /admin/import
// (SelectedCategory above) — searches ONLY the terms mapped to those
// categories instead of the general aesthetic groups, so "Import 100 ONLY
// low-rise jeans + tops" actually searches for low-rise jeans and tops
// rather than searching broadly and relying on downstream filtering to
// throw away everything else.
function buildSearchTermsForSelectedCategories(selectedCategories: SelectedCategory[]): string[] {
  return interleaveGroups(selectedCategories.map((category) => SELECTED_CATEGORY_SEARCH_TERMS[category]));
}

// Appended to a brand-combined query when the admin has a Price Mode
// selected — "Combine: brand + category + price intent" (query generation
// spec). "any" contributes nothing: there's no price intent to express.
const PRICE_INTENT_PHRASE: Record<PriceMode, string | null> = {
  under10: "under 10",
  under20: "under 20",
  any: null,
};

// Used when the admin has selected specific brands on /admin/import's Brand
// Filters ("User can click brand buttons → scraper fetches ONLY those
// brands") — takes priority over buildSearchTermsForSelectedCategories/
// SEARCH_TERMS, since a search combining the brand name with a category/
// price intent is far more likely to actually surface that brand than a
// generic aesthetic search ever would.
//
// Example (this feature's own spec): selectedBrands=["Abercrombie"],
// selectedCategories=["low-rise-jeans"], priceMode="under10" ->
// "abercrombie low rise jeans under 10" (the category's own first mapped
// search term — SELECTED_CATEGORY_SEARCH_TERMS — combined with the brand
// and a price-intent phrase). No category selected -> brand (+ price
// intent) alone, e.g. "abercrombie under 10".
function buildSearchTermsForBrands(
  selectedBrands: SelectedBrand[],
  selectedCategories: SelectedCategory[],
  priceMode: PriceMode,
): string[] {
  const priceIntent = PRICE_INTENT_PHRASE[priceMode];
  const categoryPhrases: (string | null)[] =
    selectedCategories.length > 0
      ? selectedCategories.flatMap((category) => SELECTED_CATEGORY_SEARCH_TERMS[category])
      : [null];

  const groups = selectedBrands.map((brand) =>
    categoryPhrases.map((categoryPhrase) =>
      [brand.toLowerCase(), categoryPhrase, priceIntent].filter((part): part is string => Boolean(part)).join(" "),
    ),
  );

  return interleaveGroups(groups);
}

// ---------------------------------------------------------------------------
// Price-hint extraction & biasing — a rough, best-effort price read straight
// off the search-results grid (before any real extraction happens), used
// only to ORDER candidates so cheaper-looking ones are more likely to be
// the ones actually processed once a batch is capped at targetCount.
// Deliberately never used to drop a candidate outright: "reduce discovery
// priority, don't completely reject expensive items" — see the spec this
// was built from.
// ---------------------------------------------------------------------------

const PRICE_TEXT_PATTERN = /\$\s?(\d+(?:\.\d{1,2})?)/;
// How many DOM ancestors to walk up from a product link looking for price
// text near it — verified live this is enough to find a price on all
// three platforms' current search-grid markup, without wandering so far
// up the tree that it picks up an unrelated price from a neighboring card.
const PRICE_SEARCH_ANCESTOR_DEPTH = 5;

// Ideal/good/lower-priority/avoid bands mirror src/lib/listing-quality.ts's
// calculatePriceValueScore — kept as a separate, simpler copy here (rather
// than importing that module) since this only needs a coarse sort key from
// an approximate scraped number, not the real scoring model applied to a
// fully-extracted listing. Bands narrow around whichever Price Mode ceiling
// the admin picked (/admin/import's Price Mode control) so "Under $10" runs
// actually prefer sub-$10 candidates over merely-sub-$20 ones, rather than
// applying the same fixed bands regardless of what was asked for.
function priceBiasRank(priceHint: number | null, priceMode: PriceMode): number {
  if (priceHint == null) return 2; // unknown — treated as middle-of-pack, never penalized

  if (priceMode === "under10") {
    if (priceHint <= 10) return 0;
    if (priceHint <= 20) return 1;
    return 2;
  }
  if (priceMode === "under20") {
    if (priceHint <= 20) return 0;
    return 1;
  }

  // "any" — same general thrift-find bands used before Price Mode existed.
  if (priceHint <= 6) return 0;
  if (priceHint <= 12) return 1;
  if (priceHint <= 20) return 2;
  if (priceHint <= 30) return 3;
  return 4; // avoid, but still included
}

// Section 8: "prefer listings with price visible in preview, and listings
// with price <= threshold" — a known price (even a middling one) beats an
// unknown one, and within each of those groups priceBiasRank breaks the tie.
function comparePriceHint(a: number | null, b: number | null, priceMode: PriceMode): number {
  const aKnown = a != null ? 0 : 1;
  const bKnown = b != null ? 0 : 1;
  if (aKnown !== bKnown) return aKnown - bKnown;
  return priceBiasRank(a, priceMode) - priceBiasRank(b, priceMode);
}

function debugLog(message: string): void {
  console.warn(`[marketplace-discovery] ${message}`);
}

// Strips query string/hash so the same listing found via two different
// search terms (or with different tracking params attached) normalizes to
// one canonical URL — both for in-run deduplication and so the eventual
// product_url stored in the DB is stable and comparable. Exported for
// src/lib/inventory/scaled-discovery.ts, which reuses this exact
// normalization rather than a second copy that could drift from this one.
export function normalizeUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

export interface DiscoveredCandidate {
  url: string;
  priceHint: number | null;
  platform: string;
}

// Exported for src/lib/inventory/scaled-discovery.ts, which reuses this
// exact DOM-scraping logic for its own (paginated, per-platform) crawl
// instead of a second, drifting copy.
export async function extractProductLinksWithPriceHints(
  page: Page,
  pattern: RegExp,
  platform: string,
): Promise<DiscoveredCandidate[]> {
  const raw = await page.evaluate(
    ({ ancestorDepth }) => {
      const results: { href: string; priceText: string | null }[] = [];
      const links = Array.from(document.querySelectorAll("a[href]")) as HTMLAnchorElement[];

      for (const link of links) {
        let el: Element | null = link;
        let priceText: string | null = null;

        for (let i = 0; i < ancestorDepth && el; i++) {
          const text = el.textContent || "";
          const match = text.match(/\$\s?\d+(?:\.\d{1,2})?/);
          if (match) {
            priceText = match[0];
            break;
          }
          el = el.parentElement;
        }

        results.push({ href: link.href, priceText });
      }

      return results;
    },
    { ancestorDepth: PRICE_SEARCH_ANCESTOR_DEPTH },
  );

  const seen = new Map<string, number | null>();
  for (const { href, priceText } of raw) {
    if (!pattern.test(href)) continue;
    const normalized = normalizeUrl(href);
    if (!normalized || seen.has(normalized)) continue;

    const priceMatch = priceText?.match(PRICE_TEXT_PATTERN);
    const priceHint = priceMatch ? Number(priceMatch[1]) : null;
    seen.set(normalized, Number.isFinite(priceHint) ? priceHint : null);
  }

  return [...seen.entries()].map(([url, priceHint]) => ({ url, priceHint, platform }));
}

// ---------------------------------------------------------------------------
// Platform weighting — shapes the final candidate list toward "Vinted 50%,
// Depop 40%, Poshmark 10%" (PLATFORM_WEIGHTS above). Applied once, after the
// whole crawl finishes: every (term, platform) combination is still visited
// during the crawl regardless of weight, so no platform loses search
// coverage — this only decides which of the found candidates make it into
// the final, targetCount-capped list, and in what order.
//
// Uses smooth weighted round-robin (the same algorithm nginx uses to spread
// requests across weighted backends), not "take platform A's whole share,
// then B's, then C's": a block-concatenated list would put every Vinted
// candidate before any Depop/Poshmark one, so a caller that processes this
// list in order and stops early (e.g. once enough listings have actually
// been imported) could easily see 100% Vinted and never reach the other
// platforms at all — the same "one group exhausts before another is ever
// reached" problem buildRoundRobinSearchTerms() above already had to solve
// for aesthetics. Interleaving fixes it here too.
// ---------------------------------------------------------------------------

function buildWeightedSelection(
  byPlatform: Map<string, DiscoveredCandidate[]>,
  targetCount: number,
): DiscoveredCandidate[] {
  const cursors: Record<string, number> = {};
  const currentWeight: Record<string, number> = {};
  for (const platform of PLATFORM_NAMES) {
    cursors[platform] = 0;
    currentWeight[platform] = 0;
  }

  const selected: DiscoveredCandidate[] = [];

  while (selected.length < targetCount) {
    const available = PLATFORM_NAMES.filter(
      (platform) => cursors[platform] < (byPlatform.get(platform)?.length ?? 0),
    );
    if (available.length === 0) break; // every platform's pool is exhausted

    for (const platform of PLATFORM_NAMES) {
      currentWeight[platform] += PLATFORM_WEIGHTS[platform] ?? 0;
    }

    let choice = available[0];
    for (const platform of available) {
      if (currentWeight[platform] > currentWeight[choice]) choice = platform;
    }
    currentWeight[choice] -= 1; // PLATFORM_WEIGHTS sums to 1

    const pool = byPlatform.get(choice)!;
    selected.push(pool[cursors[choice]]);
    cursors[choice]++;
  }

  return selected;
}

// How many (term, platform) page visits run at once — one shared Playwright
// `browser` instance, many concurrent `context`/`page` pairs (a standard,
// safe Playwright usage pattern). This was previously a single nested
// for-loop visiting one page at a time — for a typical run needing to
// visit a dozen-plus (term, platform) combinations before targetCount is
// reached, that alone could take a minute or more (each visit involves a
// real page navigation, a networkidle wait, and a settle timeout — see
// PAGE_NAV_TIMEOUT_MS/SETTLE_MS below), before a single candidate had even
// been extracted or scored. Concurrency here is the single biggest lever
// for fitting discovery inside a tight overall time budget (see
// admin-scraper.ts's TOTAL_TIME_BUDGET_MS).
const DISCOVERY_CONCURRENCY = 6;

/**
 * Crawls (term × platform) search-result pages CONCURRENTLY (see
 * DISCOVERY_CONCURRENCY), collecting product-listing URLs until
 * `targetCount` unique, not-already-known URLs are found, every source is
 * exhausted, or `deadline` (epoch ms, optional) passes. Never throws — a
 * single blocked/slow/malformed page visit is logged and skipped; the
 * crawl moves on rather than failing the whole discovery run.
 *
 * The returned list is shaped in two ways, neither of which ever drops a
 * discovered URL outright — everything found is still somewhere in the
 * returned list, just reordered/reweighted:
 *  - Platform weighting (PLATFORM_WEIGHTS/buildWeightedSelection): the
 *    final list approximates Vinted 50% / Depop 40% / Poshmark 10%.
 *  - Price bias (priceBiasRank/comparePriceHint): within each platform,
 *    candidates whose scraped-from-the-grid price fits `priceMode` (and
 *    has a visible price at all) sort earlier.
 *
 * `excludeUrls` should be normalized product_urls already present in the
 * database (or already seen in an earlier round of the same scraper run —
 * see admin-scraper.ts) — checked here (not only after extraction) so a
 * page visit whose only links are already-known listings doesn't count
 * toward targetCount with nothing new to show for it.
 *
 * Callers should ask for more than they actually need (e.g. 1.5x, or 2x
 * for a strict "Under $10" run — see /admin/import's discoveryBuffer):
 * later per-URL extraction can still fail, turn out to be an image_url
 * duplicate, or get rejected for being over the admin's chosen price
 * ceiling, and discovery has no way to know any of that in advance.
 *
 * `selectedCategories`: when the admin has picked specific categories on
 * /admin/import, search terms come ONLY from those categories' mappings
 * (SELECTED_CATEGORY_SEARCH_TERMS) instead of the general aesthetic groups
 * — an empty array (the default) means "no filter," which behaves exactly
 * like the system did before this feature existed.
 *
 * `selectedBrands`: when the admin has picked specific brands on
 * /admin/import's Brand Filters, search terms are brand-prioritized —
 * built by combining each brand with selectedCategories/priceMode (see
 * buildSearchTermsForBrands) — which takes priority over
 * selectedCategories-only or general search terms. An empty array (the
 * default) means "no filter" (section: Fallback).
 *
 * `deadline`: epoch ms after which no NEW page visit starts (in-flight
 * visits still finish — Playwright has no cheap mid-navigation cancel,
 * and a page that's already loading will resolve in a few seconds
 * regardless). Omit for "no deadline, only targetCount/exhaustion stop
 * this."
 */
export async function discoverListingUrls(
  targetCount: number,
  excludeUrls: Set<string>,
  priceMode: PriceMode = "any",
  selectedCategories: SelectedCategory[] = [],
  selectedBrands: SelectedBrand[] = [],
  deadline?: number,
): Promise<string[]> {
  const searchTerms =
    selectedBrands.length > 0
      ? buildSearchTermsForBrands(selectedBrands, selectedCategories, priceMode)
      : selectedCategories.length > 0
        ? buildSearchTermsForSelectedCategories(selectedCategories)
        : SEARCH_TERMS;

  const found = new Map<string, { priceHint: number | null; platform: string }>();

  // Flattened (term, source) work list — same visiting order as the old
  // nested for-loop (every source for a term, before moving to the next
  // term) so the round-robin-across-aesthetics property SEARCH_TERMS was
  // built for is preserved; only HOW the list is processed (concurrently,
  // bounded, with early skips) changed.
  const workItems: { term: string; source: DiscoverySource }[] = [];
  for (const term of searchTerms) {
    for (const source of DISCOVERY_SOURCES) {
      workItems.push({ term, source });
    }
  }

  let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
  let slotAcquired = false;

  try {
    // Explicit rather than relying on Playwright's own default (also 30s)
    // — makes the actual bound visible here instead of implicit, part of
    // this bug's fix ensuring no single external request/browser
    // operation can ever hang a scraper run indefinitely.
    await acquireBrowserSlot();
    slotAcquired = true;
    browser = await chromium.launch(await resolveBrowserLaunchOptions({ headless: true, timeout: LAUNCH_TIMEOUT_MS }));
    registerBrowserLaunch(browser);
    const activeBrowser = browser;

    await mapWithConcurrency(workItems, DISCOVERY_CONCURRENCY, async ({ term, source }) => {
      // Checked per work item now (not per term) — with concurrent
      // workers there's no single "finished this term's full round"
      // moment to gate on the way the old sequential loop did; a worker
      // that's already running when targetCount/deadline is hit still
      // finishes (cheap — it's already mid-flight), it just won't start
      // a NEW page visit once either condition is true.
      if (found.size >= targetCount) return;
      if (deadline != null && Date.now() >= deadline) return;

      // context creation moved INSIDE the try (it used to sit before it)
      // — a single failed newContext() call (browser under memory
      // pressure, crashed mid-run) used to throw straight out of this
      // work item and, since mapWithConcurrency's Promise.all has no
      // per-item isolation, abort every OTHER concurrent work item too,
      // silently truncating a round's whole discovery pass. Now a bad
      // context only ever costs this one (term, platform) attempt.
      let context: Awaited<ReturnType<typeof activeBrowser.newContext>> | null = null;

      try {
        context = await activeBrowser.newContext({
          userAgent: BROWSER_USER_AGENT,
          viewport: { width: 1280, height: 900 },
        });
        const page = await context.newPage();
        const response = await page.goto(source.searchUrl(term), {
          waitUntil: "domcontentloaded",
          timeout: PAGE_NAV_TIMEOUT_MS,
        });

        const status = response?.status();
        if (status && BLOCKED_STATUS_CODES.has(status)) {
          debugLog(`${source.platform} blocked request (status ${status}) for "${term}": skipping`);
          return;
        }

        try {
          await page.waitForLoadState("networkidle", { timeout: PAGE_NAV_TIMEOUT_MS });
        } catch {
          // Background network chatter never stopped — proceed with
          // whatever rendered anyway (same tradeoff as browser-extractor.ts).
        }
        await page.waitForTimeout(SETTLE_MS);

        const candidates = await extractProductLinksWithPriceHints(page, source.productPattern, source.platform);
        let newCount = 0;
        for (const { url, priceHint, platform } of candidates) {
          if (!excludeUrls.has(url) && !found.has(url)) {
            found.set(url, { priceHint, platform });
            newCount++;
          }
        }
        debugLog(`${source.platform} / "${term}": ${candidates.length} links, ${newCount} new`);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        debugLog(`${source.platform} / "${term}" failed: ${reason}`);
      } finally {
        if (context) await context.close();
      }
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error("[marketplace-discovery] Browser launch/crawl failed:", reason);
  } finally {
    if (browser) {
      await browser.close();
      registerBrowserClose(browser);
    } else if (slotAcquired) {
      releaseBrowserSlotOnLaunchFailure();
    }
  }

  const byPlatform = new Map<string, DiscoveredCandidate[]>();
  for (const [url, { priceHint, platform }] of found.entries()) {
    const list = byPlatform.get(platform) ?? [];
    list.push({ url, priceHint, platform });
    byPlatform.set(platform, list);
  }
  for (const list of byPlatform.values()) {
    list.sort((a, b) => comparePriceHint(a.priceHint, b.priceHint, priceMode));
  }

  return buildWeightedSelection(byPlatform, targetCount)
    .slice(0, targetCount)
    .map((candidate) => candidate.url);
}
