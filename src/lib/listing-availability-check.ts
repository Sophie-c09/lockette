// Sold-signal detection for the check-listing-status cron
// (src/app/api/cron/check-listing-status/route.ts). Deliberately
// fetch-only — no headless-browser fallback: this project has already hit
// real Cloudflare-style bot-challenge blocks fetching both eBay and Depop
// (see html-extractor.ts's BROWSER_HEADERS spoofing), so a blocked/
// inconclusive fetch is treated as "leave status alone, try again later"
// (the failsafe below), which is exactly what a fetch-only approach
// naturally produces — escalating to Playwright wouldn't reliably help
// against a real bot-challenge anyway, and running it on a timer inside a
// scheduled serverless function is meaningfully heavier infrastructure
// than this failure-handling rule actually calls for.
import { fetchHtml } from "@/lib/extraction/html-extractor";
import { detectUnavailabilitySignal, type AvailabilitySignal } from "@/lib/extraction/availability-signal";

export type { AvailabilitySignal };

export type CheckResult =
  | { outcome: "unavailable"; signalSource: "json-ld" | "phrase"; detail: string }
  | { outcome: "inconclusive" };

/**
 * Fetches `url` and runs sold-signal detection against it — the single
 * entry point the cron route calls per listing. Never throws: a failed
 * fetch (blocked, timed out, non-HTML response, network error — see
 * fetchHtml's own doc comment) is reported the same way as a page that
 * fetched fine but had no recognizable signal — `{ outcome: "inconclusive" }`
 * — so the caller's failsafe (stamp last_checked_at, leave status alone,
 * retry later) is the same single code path either way, matching the
 * spec's own "if the request fails, don't guess — just retry later" rule.
 */
export async function checkListingAvailability(url: string): Promise<CheckResult> {
  const html = await fetchHtml(url);
  if (!html) return { outcome: "inconclusive" };

  const signal = detectUnavailabilitySignal(html);
  if (signal.kind === "unavailable") {
    return { outcome: "unavailable", signalSource: signal.source, detail: signal.detail };
  }

  return { outcome: "inconclusive" };
}
