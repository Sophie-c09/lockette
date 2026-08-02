// Global, process-wide Chromium concurrency limiter — added after a real
// production throughput audit found system load average hitting ~50 (DNS
// resolution itself failing machine-wide) because up to 10-20 concurrent
// per-URL browser launches (runBrowserExtraction, src/lib/extraction/
// browser-extractor.ts) each spawn ~6-7 real OS processes. This caps how
// many Chromium instances can be OPEN AT ONCE across every call site that
// launches one — browser-extractor.ts's per-URL fallback AND both
// discovery crawlers' per-round/per-platform browser (marketplace-
// discovery.ts, scaled-discovery.ts) — not per-batch, not per-call-site.
//
// Deliberately does not touch discovery/extraction/scoring logic itself:
// every existing call site keeps its own chromium.launch(...) call and its
// own try/finally browser.close() unchanged, just bracketed by
// acquireBrowserSlot() before launch and registerBrowserLaunch/Close
// around it — see this file's own function comments.
import { chromium, type Browser, type LaunchOptions } from "playwright";

export const MAX_ACTIVE_BROWSERS = Number(process.env.MAX_ACTIVE_BROWSERS) || 3;

// Reserved slots — incremented the instant a slot is granted (acquire),
// decremented on release. Tracked SEPARATELY from activeBrowsers below:
// a slot is reserved from the moment acquireBrowserSlot() grants it, even
// before chromium.launch() actually resolves with a Browser object, so a
// slow or failing launch still correctly counts against the limit instead
// of letting extra concurrent launches slip through underneath it.
let reservedSlots = 0;
const waitQueue: Array<() => void> = [];

// The actual tracked Browser instances — used for [browser] logging and
// for forceCloseAllTrackedBrowsers's own enumeration. Deliberately a
// second piece of state from reservedSlots above (not derived from
// activeBrowsers.size) so a slot reserved for an in-flight launch that
// hasn't resolved yet is still correctly counted against the limit.
const activeBrowsers = new Set<Browser>();

/**
 * Blocks until a global slot is free, then reserves it synchronously
 * before returning — call this immediately before chromium.launch() at
 * every launch site. Pair with EXACTLY ONE of registerBrowserLaunch (the
 * launch succeeded) or releaseBrowserSlotOnLaunchFailure (it didn't) —
 * see each call site's own finally block.
 */
export async function acquireBrowserSlot(): Promise<void> {
  if (reservedSlots < MAX_ACTIVE_BROWSERS) {
    reservedSlots++;
    return;
  }
  await new Promise<void>((resolve) => waitQueue.push(resolve));
  reservedSlots++;
}

function releaseSlotAndAdvanceQueue(): void {
  reservedSlots--;
  const next = waitQueue.shift();
  if (next) next();
}

/** Call once, right after a chromium.launch() call succeeds. */
export function registerBrowserLaunch(browser: Browser): void {
  activeBrowsers.add(browser);
  console.log(`[browser] launched (count=${activeBrowsers.size})`);
}

/**
 * Call once, right after browser.close() resolves at every launch site's
 * own finally block. Idempotent by design (checks Set.delete()'s return
 * value) — safe to call even if forceCloseAllTrackedBrowsers already
 * closed this same browser out from under an abandoned/hung call (see
 * that function's own comment), so callers never need their own
 * already-released bookkeeping.
 */
export function registerBrowserClose(browser: Browser): void {
  const wasTracked = activeBrowsers.delete(browser);
  if (!wasTracked) return;
  console.log(`[browser] closed (count=${activeBrowsers.size})`);
  releaseSlotAndAdvanceQueue();
}

/**
 * Call from a launch site's finally block when chromium.launch() itself
 * threw (browser stayed null) — releases the slot acquireBrowserSlot()
 * reserved, since registerBrowserLaunch/Close never ran for a launch that
 * never produced a Browser to track.
 */
export function releaseBrowserSlotOnLaunchFailure(): void {
  releaseSlotAndAdvanceQueue();
}

/**
 * Forced cleanup for the batch watchdog (see admin-scraper.ts's
 * withBatchWatchdog) — when a batch attempt is abandoned as hung, the
 * underlying runAdminScraper() call is left running (it can't be
 * cancelled), but without this, any browsers it had open at the moment of
 * the timeout would stay open indefinitely: orphaned, permanently holding
 * a slot (and real OS processes) for the rest of the process's lifetime.
 * Force-closes every currently tracked browser so their slots free up
 * immediately; each browser's own eventual browser.close() call (from
 * whatever abandoned code path gets there, if it ever does) becomes a
 * safe no-op via registerBrowserClose's idempotency check above.
 *
 * Closes ALL tracked browsers globally, not just ones belonging to the
 * timed-out attempt specifically — there is no per-attempt browser
 * tracking (that would need touching the scraper's own architecture, out
 * of scope here). Safe in this codebase's actual usage: only one
 * large-scale job runs at a time (see getActiveLargeScaleJob's
 * concurrency guard), so any browser open at the moment a batch watchdog
 * fires almost certainly belongs to that same abandoned attempt.
 */
export async function forceCloseAllTrackedBrowsers(reason: string): Promise<void> {
  const browsers = Array.from(activeBrowsers);
  if (browsers.length > 0) {
    console.warn(`[browser] Forced cleanup — closing ${browsers.length} tracked browser(s): ${reason}`);
    await Promise.all(
      browsers.map(async (browser) => {
        try {
          await browser.close();
        } catch (error) {
          console.error("[browser] Forced cleanup — error closing browser:", error);
        } finally {
          // Free the slot regardless of whether close() itself threw — a
          // browser that failed to close cleanly must not permanently
          // occupy a concurrency slot.
          registerBrowserClose(browser);
        }
      }),
    );
  }

  await forceClosePooledBrowsers(reason);
}

// ---------------------------------------------------------------------------
// Reusable browser pool — for discovery crawlers specifically
// (scaled-discovery.ts, marketplace-discovery.ts), which each used to
// launch a brand-new browser per platform per round/call. Over a
// long-running overnight job that's hundreds of real chromium launches,
// each one an expensive OS process spawn — this pool reuses already-warm
// browsers across calls instead.
//
// P0 launch-readiness fix — this used to gate new launches on its OWN
// `pooledBrowsers.length < MAX_ACTIVE_BROWSERS` check, entirely independent
// from acquireBrowserSlot/reservedSlots above (still used unchanged by
// browser-extractor.ts's per-URL fallback). That meant up to
// MAX_ACTIVE_BROWSERS fallback browsers AND MAX_ACTIVE_BROWSERS pooled
// browsers could be alive at the same moment — genuinely up to 2x the
// intended ceiling, the exact class of resource-exhaustion incident this
// constant exists to prevent (see this file's own header comment). Now a
// NEW pooled-browser launch reserves a slot from the SAME shared
// reservedSlots/waitQueue every fallback launch already uses — an idle
// pooled browser being reused (the common case) never touches slot
// accounting at all (it never released its slot in the first place; an
// idle-but-alive browser is still a real OS process, so it must keep
// counting against the cap exactly as an active one does), only a genuine
// new chromium.launch() call (from either pool) does.
// ---------------------------------------------------------------------------

const pooledBrowsers: Browser[] = [];
const idlePooledBrowsers: Browser[] = [];

function dropFromPool(browser: Browser): void {
  const poolIndex = pooledBrowsers.indexOf(browser);
  if (poolIndex !== -1) pooledBrowsers.splice(poolIndex, 1);
  const idleIndex = idlePooledBrowsers.indexOf(browser);
  if (idleIndex !== -1) idlePooledBrowsers.splice(idleIndex, 1);
}

/**
 * Hands back an already-launched, idle browser when one is available;
 * otherwise reserves a slot from the SAME global counter
 * acquireBrowserSlot/browser-extractor.ts's fallback path uses (waiting,
 * if necessary, for a fallback browser OR another pooled browser to free
 * one up) and launches a fresh one. Pair with EXACTLY ONE call to
 * releasePooledBrowser (in a finally block) once done with it — never
 * call browser.close() directly on a pooled browser, that would defeat
 * the entire point of reusing it.
 */
export async function acquirePooledBrowser(launchOptions?: LaunchOptions): Promise<Browser> {
  while (idlePooledBrowsers.length > 0) {
    const candidate = idlePooledBrowsers.pop()!;
    if (candidate.isConnected()) {
      console.log(`[browser] reused from pool (pool size=${pooledBrowsers.length})`);
      return candidate;
    }
    // Crashed/disconnected while idle — this browser is genuinely gone, so
    // its globally-shared slot frees up too, same as a real browser.close().
    dropFromPool(candidate);
    releaseSlotAndAdvanceQueue();
  }

  await acquireBrowserSlot();
  try {
    const browser = await chromium.launch(launchOptions);
    pooledBrowsers.push(browser);
    console.log(`[browser] launched into pool (pool size=${pooledBrowsers.length})`);
    return browser;
  } catch (error) {
    // Launch itself failed — release the slot this call reserved, same
    // "acquire failed launches must still release their slot" reasoning
    // as browser-extractor.ts's own releaseBrowserSlotOnLaunchFailure.
    releaseSlotAndAdvanceQueue();
    throw error;
  }
}

/**
 * Returns a browser acquired via acquirePooledBrowser back to the pool for
 * reuse. A disconnected/crashed browser is dropped from the pool outright
 * (freeing its global slot) rather than being re-idled — the NEXT
 * acquirePooledBrowser call will see the pool has room again and launch a
 * fresh replacement.
 */
export function releasePooledBrowser(browser: Browser): void {
  if (!browser.isConnected()) {
    dropFromPool(browser);
    releaseSlotAndAdvanceQueue();
    return;
  }

  idlePooledBrowsers.push(browser);
  console.log(`[browser] returned to pool (idle=${idlePooledBrowsers.length}, pool size=${pooledBrowsers.length})`);
}

async function forceClosePooledBrowsers(reason: string): Promise<void> {
  const browsers = [...pooledBrowsers];
  if (browsers.length === 0) return;

  console.warn(`[browser] Forced cleanup — closing ${browsers.length} pooled browser(s): ${reason}`);
  pooledBrowsers.length = 0;
  idlePooledBrowsers.length = 0;

  await Promise.all(
    browsers.map(async (browser) => {
      try {
        await browser.close();
      } catch (error) {
        console.error("[browser] Forced cleanup — error closing pooled browser:", error);
      } finally {
        // Every closed pooled browser held a global slot — free it,
        // same as forceCloseAllTrackedBrowsers already does for the
        // fallback pool via registerBrowserClose.
        releaseSlotAndAdvanceQueue();
      }
    }),
  );
}
