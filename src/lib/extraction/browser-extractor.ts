// Browser-based fallback: launches headless Chromium and actually renders
// the page, for marketplaces that either block plain HTTP fetches or only
// populate product data client-side (html-extractor.ts sees neither).
//
// Two signal sources are combined here:
//  1. Re-run the same meta/JSON-LD parser html-extractor.ts uses, but
//     against the page's *rendered* HTML — this alone recovers most sites,
//     since SPAs frequently inject Open Graph/JSON-LD tags during
//     hydration even though the raw server response omits them.
//  2. A handful of generic, best-effort visible-DOM heuristics (page
//     title, an <h1>, price-looking text, brand/size-looking elements) to
//     fill in whatever's still missing — there's no universal product-page
//     structure across marketplaces, so these are intentionally loose.
import { chromium } from "playwright";
import { extractFromHtml, detectBlockedPageContent, type RawExtraction } from "./html-extractor";
import {
  acquireBrowserSlot,
  registerBrowserLaunch,
  registerBrowserClose,
  releaseBrowserSlotOnLaunchFailure,
} from "@/lib/browser-concurrency";
import { resolveBrowserLaunchOptions } from "@/lib/browser-launch-options";

const NAV_TIMEOUT_MS = 15_000;
// Networkidle doesn't guarantee client-side rendering has *finished* —
// some marketplaces keep patching the DOM in for a moment afterward, so
// this gives the page a brief settle window before reading it.
const RENDER_SETTLE_MS = 1_500;
// Explicit rather than relying on Playwright's own default (also 30s) —
// makes the actual bound visible in this file instead of implicit, and
// caps how long a single candidate's browser fallback can ever occupy a
// mapWithConcurrency worker slot even if the browser itself is slow to
// start (a real failure mode this bug's investigation specifically
// checked for — see this file's own header comment).
const LAUNCH_TIMEOUT_MS = 15_000;

// HTTP statuses that mean "the site is actively blocking/rate-limiting
// this request," not "the page genuinely doesn't exist" — logged clearly
// and treated as a normal, expected outcome (never a hang, never a thrown
// error the caller has to guess the cause of).
const BLOCKED_STATUS_CODES = new Set([403, 429, 503]);

function debugLog(message: string): void {
  console.warn(`[listing-extraction] ${message}`);
}

const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

interface VisibleDomSignals {
  pageTitle: string | null;
  visibleTitle: string | null;
  descriptionText: string | null;
  imageSrc: string | null;
  imageSrcs: string[];
  priceText: string | null;
  brandText: string | null;
  sizeText: string | null;
}

// This runs inside the browser page via page.evaluate(). It's written as a
// plain JS *string*, not a TS function reference, on purpose: Next.js's
// bundler (like esbuild/tsx, used in this repo's own test scripts)
// instruments nested named functions with a call to a module-scoped
// `__name` helper for Function.name preservation, and Playwright evaluates
// a function by serializing it out of that module scope — so the compiled
// version throws `ReferenceError: __name is not defined` once it's run
// standalone in the page. A source string is never touched by that
// transform (it's just string data to the bundler), so it survives
// serialization intact. Confirmed against a real esbuild-compiled build,
// not just a hypothetical.
const READ_VISIBLE_DOM_SIGNALS_SCRIPT = `
(function () {
  function metaContent(properties) {
    for (var i = 0; i < properties.length; i++) {
      var property = properties[i];
      var el = document.querySelector(
        'meta[property="' + property + '"], meta[name="' + property + '"]'
      );
      var content = el && el.getAttribute("content");
      if (content) return content;
    }
    return null;
  }

  function firstText(selectors) {
    for (var i = 0; i < selectors.length; i++) {
      var elements = document.querySelectorAll(selectors[i]);
      for (var j = 0; j < elements.length; j++) {
        var text = elements[j].textContent && elements[j].textContent.trim();
        if (text) return text;
      }
    }
    return null;
  }

  function findPriceText() {
    var metaPrice = metaContent(["product:price:amount", "og:price:amount"]);
    if (metaPrice) return metaPrice;

    var priceLike = firstText(['[class*="price" i]', '[data-testid*="price" i]']);
    if (priceLike) return priceLike;

    var bodyText = (document.body && document.body.innerText) || "";
    var match = bodyText.match(/[$£€]\\s?\\d[\\d,.]*/);
    return match ? match[0] : null;
  }

  function findImageSrc() {
    var og = metaContent(["og:image", "og:image:secure_url"]);
    if (og) return og;

    var images = Array.prototype.slice.call(document.querySelectorAll("img"));
    var substantial = null;
    for (var i = 0; i < images.length; i++) {
      if (images[i].naturalWidth >= 200 && images[i].naturalHeight >= 200) {
        substantial = images[i];
        break;
      }
    }
    var chosen = substantial || images[0];
    return (chosen && (chosen.currentSrc || chosen.src)) || null;
  }

  // Every substantial (non-icon/thumbnail-sized) rendered <img> belonging
  // to THIS listing's own gallery/carousel container — NEVER a page-wide
  // scan. Root cause of a real bug (confirmed live against an actual Depop
  // product page): an earlier version always concatenated every tier,
  // including a bare "img" catch-all — since "img" matches every element
  // any more specific selector already matched, that catch-all made the
  // specific tiers pointless and effectively returned every substantial
  // image ANYWHERE on the page, including "More from this seller" and
  // "You may also like" widgets full of OTHER listings' photos (verified:
  // one real page returned 62 images this way, only ~3 of which actually
  // belonged to that listing). A later attempt narrowed that catch-all to
  // only fire when the scoped tier came up empty ("should now be rare") —
  // but "rare" still means a real listing occasionally still displays
  // another listing's photos, which is not an acceptable failure mode
  // here. The page-wide tier is removed entirely: if no gallery/carousel/
  // slider container matches, this returns nothing rather than guessing,
  // and the caller (runBrowserExtraction below) still has findImageSrc()'s
  // single hero image plus whatever JSON-LD/OG declared — fewer, certainly
  // -correct photos beats more, possibly-wrong ones.
  function findAllImageSrcs() {
    var selectors = [
      '[class*="gallery" i] img', '[class*="carousel" i] img', '[class*="slider" i] img',
      '[data-testid*="image" i] img'
    ];
    var seen = {};
    var result = [];
    for (var i = 0; i < selectors.length; i++) {
      var elements = Array.prototype.slice.call(document.querySelectorAll(selectors[i]));
      for (var j = 0; j < elements.length; j++) {
        var el = elements[j];
        if (el.naturalWidth < 200 || el.naturalHeight < 200) continue;
        var src = el.currentSrc || el.src;
        if (!src || seen[src]) continue;
        seen[src] = true;
        result.push(src);
      }
    }
    return result;
  }

  var h1 = document.querySelector("h1");

  return {
    pageTitle: document.title || null,
    visibleTitle: (h1 && h1.textContent && h1.textContent.trim()) || null,
    descriptionText: metaContent(["og:description", "description"]) || firstText(["p"]),
    imageSrc: findImageSrc(),
    imageSrcs: findAllImageSrcs(),
    priceText: findPriceText(),
    brandText: firstText(['[class*="brand" i]', '[data-testid*="brand" i]']),
    sizeText: firstText(['[class*="size" i]', '[data-testid*="size" i]'])
  };
})()
`;

// Never throws — callers (listing-extraction.ts) already wrap this in a
// try/catch as a second safety net, but every failure mode we can
// anticipate (launch failure, navigation timeout, page crash) is caught
// here too so a Playwright hiccup degrades to "no browser data" instead of
// propagating.
export async function runBrowserExtraction(url: string): Promise<RawExtraction | null> {
  let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
  let slotAcquired = false;
  const hostname = (() => {
    try {
      return new URL(url).hostname;
    } catch {
      return url;
    }
  })();

  try {
    debugLog(`Browser extraction started for ${url}`);
    await acquireBrowserSlot();
    slotAcquired = true;
    browser = await chromium.launch(await resolveBrowserLaunchOptions({ headless: true, timeout: LAUNCH_TIMEOUT_MS }));
    registerBrowserLaunch(browser);
    const context = await browser.newContext({
      userAgent: BROWSER_USER_AGENT,
      viewport: { width: 1280, height: 900 },
    });
    const page = await context.newPage();

    // "networkidle" as a goto() condition is too strict for SPAs that keep
    // background traffic going indefinitely (analytics beacons, feature-flag
    // polling, etc.) — Depop in particular never goes idle, so goto() would
    // time out and throw before the page ever got read, discarding a fully
    // loaded page. Wait for DOM content instead, then *try* for networkidle
    // as a best-effort settle signal without letting its failure abort
    // extraction.
    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });

    const status = response?.status();
    // Extraction-pipeline tracing — page.url() is the URL AFTER any
    // navigation/redirect Playwright followed, same "did this end up
    // somewhere we didn't ask for" signal as html-extractor.ts's own
    // response.url. Logged before the block-status check below so a
    // blocked attempt still shows exactly what status/URL it got blocked
    // at, not just that it was skipped.
    console.log("[extraction] browser navigation result", {
      requestedUrl: url,
      finalUrl: page.url(),
      status: status ?? null,
    });

    if (status && BLOCKED_STATUS_CODES.has(status)) {
      debugLog(`${hostname} blocked request (status ${status}): skipping`);
      return null;
    }

    try {
      await page.waitForLoadState("networkidle", { timeout: NAV_TIMEOUT_MS });
    } catch {
      // Background network chatter never stopped — proceed with whatever
      // rendered anyway.
    }
    await page.waitForTimeout(RENDER_SETTLE_MS);

    const renderedHtml = await page.content();
    const { looksLikeCaptcha, looksLikeLogin } = detectBlockedPageContent(renderedHtml);
    console.log("[extraction] browser rendered HTML", {
      requestedUrl: url,
      htmlLength: renderedHtml.length,
      looksLikeCaptcha,
      looksLikeLogin,
      htmlSnippet: renderedHtml.slice(0, 500),
    });
    if (looksLikeCaptcha || looksLikeLogin) {
      debugLog(
        `${hostname} rendered page (status ${status ?? "unknown"}) looks like a ` +
          `${looksLikeCaptcha ? "CAPTCHA/bot-check" : "login"} page even after a full browser render.`,
      );
    }

    const fromRenderedHtml = extractFromHtml(renderedHtml);
    const dom = await page.evaluate<VisibleDomSignals>(READ_VISIBLE_DOM_SIGNALS_SCRIPT);

    return {
      title: fromRenderedHtml.title ?? dom.visibleTitle ?? dom.pageTitle,
      description: fromRenderedHtml.description ?? dom.descriptionText,
      price: fromRenderedHtml.price ?? dom.priceText,
      imageUrl: fromRenderedHtml.imageUrl ?? dom.imageSrc,
      // JSON-LD/OG images (from the rendered HTML) first, then whatever the
      // DOM gallery scan found that those didn't already cover.
      images: [...fromRenderedHtml.images, ...dom.imageSrcs],
      canonicalUrl: fromRenderedHtml.canonicalUrl,
      brand: fromRenderedHtml.brand ?? dom.brandText,
      category: fromRenderedHtml.category,
      size: fromRenderedHtml.size ?? dom.sizeText,
      color: fromRenderedHtml.color,
      // No visible-DOM heuristic for these — engagement counts only ever
      // come from the rendered page's own JSON-LD (see html-extractor.ts).
      sourceLikesCount: fromRenderedHtml.sourceLikesCount,
      sourceViewsCount: fromRenderedHtml.sourceViewsCount,
      sourceCommentsCount: fromRenderedHtml.sourceCommentsCount,
      // No visible-DOM heuristic for this either — same reasoning as the
      // engagement counts above; a rendered page's sold/removed banner is
      // covered by extractFromHtml's own phrase/JSON-LD scan already run
      // above (fromRenderedHtml), not something the generic DOM script
      // looks for.
      unavailabilitySignal: fromRenderedHtml.unavailabilitySignal,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`[listing-extraction] Browser extraction threw for ${url}: ${reason}`);
    return null;
  } finally {
    if (browser) {
      await browser.close();
      registerBrowserClose(browser);
    } else if (slotAcquired) {
      releaseBrowserSlotOnLaunchFailure();
    }
  }
}
