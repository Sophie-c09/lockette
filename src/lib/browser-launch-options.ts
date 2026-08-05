// P0 launch-readiness fix (Playwright/Vercel production compatibility,
// part 2) — the earlier fix in this same pass (next.config.ts's
// outputFileTracingIncludes) made the deployed Function's file trace
// finally include playwright-core's own browsers.json manifest, which
// fixed the exact confirmed production error ("Cannot find module
// '.../playwright-core/browsers.json'"). That fix is necessary but NOT
// sufficient: the actual Chromium EXECUTABLE Playwright launches
// (~150-200MB of browser binary) is never installed into node_modules at
// all — confirmed directly against this project's own local install: it
// lives in an OS-level cache directory (macOS:
// ~/Library/Caches/ms-playwright, Linux: ~/.cache/ms-playwright),
// completely outside node_modules and therefore outside anything
// outputFileTracingIncludes' node_modules/** globs could ever reach.
// Vercel's build environment has no such pre-populated cache, so even
// with browsers.json now present, chromium.launch() would still fail —
// with "Executable doesn't exist at .../chrome-linux/headless_shell" (or
// similar) instead of the browsers.json error, a different failure for
// the same underlying root cause: normal Playwright installs assume a
// persistent local machine, not a fresh serverless Function filesystem.
//
// @sparticuz/chromium is the standard, widely-used fix for exactly this
// combination (Playwright/Puppeteer + Vercel/AWS Lambda serverless
// Functions) — it ships its OWN compressed Chromium build INSIDE its npm
// package (so it DOES get picked up by ordinary node_modules tracing,
// unlike a normal Playwright install), inflates it into /tmp at runtime,
// and provides the serverless-safe launch args (--single-process,
// --disable-gpu, etc.) a restricted Function filesystem needs.
//
// IMPORTANT — genuinely unverified: this was written and reasoned through
// but could not be tested against a real Vercel deployment or a real
// serverless filesystem in this environment. Confirm end-to-end (Start a
// Continuous Import / Inventory Growth run against a real Vercel deploy)
// before relying on it.
import chromiumBinary from "@sparticuz/chromium";
import type { LaunchOptions } from "playwright";

// VERCEL is set by Vercel's own build/runtime environment on every deploy
// (preview and production alike) — unlike NODE_ENV=production, which also
// fires for a plain `next build && next start` on a normal always-on
// server, where the locally-installed Playwright browser genuinely exists
// on disk and should be used as-is, not replaced with the serverless one.
const IS_VERCEL_SERVERLESS = process.env.VERCEL === "1";

// Render-worker migration — RENDER is set automatically by Render's own
// runtime environment on every service it runs (documented platform env
// var, not something this repo sets). Used here ONLY to add Chromium's
// standard Docker shared-memory workaround: Render's container platform
// gives no way to raise /dev/shm size the way a plain `docker run
// --shm-size` would, and the default 64MB is well known to crash Chromium
// under real concurrent-tab load. `--disable-dev-shm-usage` makes Chromium
// use /tmp instead, sidestepping the limit entirely regardless of host
// configuration. Deliberately NOT @sparticuz/chromium (Section 8 of this
// migration's own spec: that package's bundled binary + serverless-shaped
// args exist for Vercel/Lambda's restricted filesystem, not a normal
// long-running container — the Render worker's Dockerfile installs a real
// Playwright browser directly, see Dockerfile.worker).
const IS_RENDER = process.env.RENDER === "true";

// Inflating the bundled binary is expensive — do it at most once per
// warm Function instance, not once per browser launch.
let cachedExecutablePath: Promise<string> | null = null;

/**
 * Merges @sparticuz/chromium's serverless-safe executablePath/args into a
 * caller's own chromium.launch() options — but ONLY on a real Vercel
 * deployment. On Render, adds just the shared-memory launch flag (see
 * IS_RENDER's own comment) on top of the caller's own options. Everywhere
 * else (local dev), returns `base` completely unchanged.
 */
export async function resolveBrowserLaunchOptions(base: LaunchOptions): Promise<LaunchOptions> {
  if (IS_RENDER) {
    return { ...base, args: [...(base.args ?? []), "--disable-dev-shm-usage"] };
  }

  if (!IS_VERCEL_SERVERLESS) return base;

  if (!cachedExecutablePath) {
    cachedExecutablePath = chromiumBinary.executablePath();
  }

  return {
    ...base,
    executablePath: await cachedExecutablePath,
    args: [...(base.args ?? []), ...chromiumBinary.args],
  };
}
