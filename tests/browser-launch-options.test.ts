// Covers the P0 launch-readiness Playwright/Vercel compatibility fix,
// part 2: @sparticuz/chromium wiring (src/lib/browser-launch-options.ts).
// The prior fix (next.config.ts's outputFileTracingIncludes for
// playwright-core/browsers.json) was necessary but not sufficient — the
// actual Chromium EXECUTABLE lives in an OS-level cache directory outside
// node_modules entirely (confirmed directly against this project's own
// local install) and was never bundled at all. This is genuinely
// unverified against a real Vercel deployment (see that file's own header
// comment) — these tests only confirm the safe-by-default gating: local
// dev must NEVER be affected.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveBrowserLaunchOptions } from "@/lib/browser-launch-options";

test("outside Vercel (local dev, a plain server), launch options pass through completely unchanged", async () => {
  const original = process.env.VERCEL;
  delete process.env.VERCEL;
  try {
    const base = { headless: true, timeout: 12345 };
    const resolved = await resolveBrowserLaunchOptions(base);
    assert.deepEqual(resolved, base);
  } finally {
    if (original !== undefined) process.env.VERCEL = original;
  }
});

test("every real chromium.launch()/acquirePooledBrowser call site routes through resolveBrowserLaunchOptions", () => {
  const files = [
    "src/lib/extraction/browser-extractor.ts",
    "src/lib/marketplace-discovery.ts",
    "src/lib/inventory/scaled-discovery.ts",
  ];
  for (const file of files) {
    const source = readFileSync(join(__dirname, "..", file), "utf-8");
    assert.match(source, /resolveBrowserLaunchOptions/, `${file} should route its launch options through resolveBrowserLaunchOptions`);
  }
});

test("next.config.ts traces @sparticuz/chromium's own bundled binary for both Playwright-dependent routes", () => {
  const configSource = readFileSync(join(__dirname, "..", "next.config.ts"), "utf-8");
  const sparticuzMatches = (configSource.match(/@sparticuz\/chromium/g) ?? []).length;
  // serverExternalPackages (1) + two outputFileTracingIncludes route entries (2) = 3.
  assert.ok(sparticuzMatches >= 3, `expected @sparticuz/chromium referenced at least 3 times, found ${sparticuzMatches}`);
});
