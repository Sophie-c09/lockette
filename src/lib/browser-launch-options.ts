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

// Inflating the bundled binary is expensive — do it at most once per
// warm Function instance, not once per browser launch.
let cachedExecutablePath: Promise<string> | null = null;

/**
 * Merges @sparticuz/chromium's serverless-safe executablePath/args into a
 * caller's own chromium.launch() options — but ONLY on a real Vercel
 * deployment. Everywhere else (local dev, a plain Node server), returns
 * `base` completely unchanged, so this can never affect local development
 * or a non-Vercel production deployment.
 */
export async function resolveBrowserLaunchOptions(base: LaunchOptions): Promise<LaunchOptions> {
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
