// Discovery redesign, requirement 2 — per-platform rolling health so a
// consistently failing marketplace (100% timeout/block, as directly
// observed in a live trace: every Vinted/Depop/Poshmark request hit the
// full old 15s timeout, every eBay request got an instant 403) stops
// being retried every single round at full cost. In-memory only, module-
// level (process lifetime) — same posture as scaled-discovery.ts's own
// lastRequestAtByPlatform; this is a live circuit breaker for ONE running
// process, not a persisted cross-run stat.
//
// Deliberately NOT a permanent kill switch: a platform that's down for a
// few minutes (a transient block, a deploy on their end) should recover
// once its window ages out — see COOLDOWN_MS below — rather than being
// disabled for the rest of an overnight run on the strength of one bad
// patch.
//
// REVISED after a real incident: a live run found ALL THREE platforms
// disabled simultaneously, root-caused to local system overload (load
// average 98-144), not any actual marketplace problem — every page.goto()
// was timing out at 130,000+ms against a 5,000ms cap, which is only
// explainable by this machine being too resource-starved to service
// browser work in time, not by Depop/Vinted/Poshmark all failing
// identically at once. Timeouts and generic errors (including browser
// launch failures) are exactly as likely to mean "our machine can't keep
// up right now" as "this marketplace is actually down" — so they no
// longer count toward disabling a platform on their own. Only outcomes
// that are genuinely marketplace-specific do: a real block/rate-limit
// response ("blocked"), or the marketplace answering successfully but
// with no usable data ("empty_response" — e.g. its page structure
// changed and the parser can't find listings anymore).

export type DiscoveryOutcome = "success" | "timeout" | "blocked" | "error" | "empty_response";

interface Attempt {
  outcome: DiscoveryOutcome;
  latencyMs: number;
  at: number;
}

// Bounded ring buffer per platform — recent behavior matters, a request
// from an hour ago shouldn't still be dragging down today's success rate.
const WINDOW_SIZE = 20;
// Never judge a platform on too few samples — the first few requests of a
// run could just be unlucky.
const MIN_SAMPLES_TO_JUDGE = 6;
// Below this success rate (with enough samples), the platform is disabled.
const MIN_SUCCESS_RATE = 0.15;
// How long a disabled platform stays disabled before its window is reset
// and it gets re-probed — long enough to not hammer a rate-limiting
// source, short enough that a genuinely-recovered platform isn't skipped
// for the rest of an overnight run.
const COOLDOWN_MS = 5 * 60 * 1000;

// Only these outcomes are genuine, marketplace-specific signals — see
// this file's own header comment on why "timeout" and "error" are
// deliberately excluded from ever counting toward disabling a platform.
const CIRCUIT_BREAKER_OUTCOMES = new Set<DiscoveryOutcome>(["blocked", "empty_response"]);

function reasonFor(outcome: DiscoveryOutcome): string {
  switch (outcome) {
    case "success":
      return "successful response with usable data";
    case "timeout":
      return "timeout — may be local resource exhaustion, not a marketplace-specific signal; not counted";
    case "error":
      return "generic error (e.g. browser launch failure) — not a marketplace-specific signal; not counted";
    case "blocked":
      return "marketplace returned a block/rate-limit response — counted";
    case "empty_response":
      return "marketplace responded successfully but returned no usable data — counted";
  }
}

interface PlatformState {
  attempts: Attempt[];
  disabledAt: number | null;
}

const state = new Map<string, PlatformState>();

function getState(platform: string): PlatformState {
  let s = state.get(platform);
  if (!s) {
    s = { attempts: [], disabledAt: null };
    state.set(platform, s);
  }
  return s;
}

// Only the outcomes in CIRCUIT_BREAKER_OUTCOMES (plus real successes, as
// the denominator's other half) are eligible to be judged at all — a
// platform that's had nothing but timeouts this window has, correctly,
// zero judged attempts, so MIN_SAMPLES_TO_JUDGE's "not enough signal yet"
// path keeps it enabled rather than disabling it on the strength of
// samples that were never real signal in the first place.
function judgedAttempts(s: PlatformState): Attempt[] {
  return s.attempts.filter((a) => a.outcome === "success" || CIRCUIT_BREAKER_OUTCOMES.has(a.outcome));
}

export function recordDiscoveryAttempt(platform: string, outcome: DiscoveryOutcome, latencyMs: number): void {
  const s = getState(platform);
  console.log("[MARKETPLACE HEALTH]", {
    marketplace: platform,
    failureType: outcome,
    countedForCircuitBreaker: outcome === "success" || CIRCUIT_BREAKER_OUTCOMES.has(outcome),
    reason: reasonFor(outcome),
  });
  s.attempts.push({ outcome, latencyMs, at: Date.now() });
  if (s.attempts.length > WINDOW_SIZE) s.attempts.shift();
}

export interface MarketplaceHealth {
  platform: string;
  attempts: number;
  successRate: number;
  timeoutRate: number;
  blockedRate: number;
  avgLatencyMs: number;
  enabled: boolean;
}

function computeHealth(platform: string, s: PlatformState): MarketplaceHealth {
  // Displayed stats deliberately still cover EVERY recorded attempt
  // (including timeouts/errors) — this is diagnostic visibility into
  // everything that happened, not the (narrower) judged set enabled below
  // is computed from.
  const attempts = s.attempts.length;
  const successes = s.attempts.filter((a) => a.outcome === "success").length;
  const timeouts = s.attempts.filter((a) => a.outcome === "timeout").length;
  const blocked = s.attempts.filter((a) => a.outcome === "blocked").length;
  const avgLatencyMs = attempts > 0 ? s.attempts.reduce((sum, a) => sum + a.latencyMs, 0) / attempts : 0;

  return {
    platform,
    attempts,
    successRate: attempts > 0 ? successes / attempts : 1,
    timeoutRate: attempts > 0 ? timeouts / attempts : 0,
    blockedRate: attempts > 0 ? blocked / attempts : 0,
    avgLatencyMs,
    enabled: isPlatformEnabled(platform),
  };
}

/**
 * The circuit breaker itself — checked before every page attempt in
 * scaled-discovery.ts's crawlPlatform. A platform crosses into "disabled"
 * once it has enough JUDGED samples (real/blocked/empty-response — see
 * judgedAttempts) AND its success rate among THOSE is below threshold;
 * once disabled, it stays disabled for COOLDOWN_MS (not judged again
 * during that window, so it isn't re-disabled on the very next check),
 * then its window is cleared so it gets a clean, fresh re-probe rather
 * than being judged on stale failures forever.
 */
export function isPlatformEnabled(platform: string): boolean {
  const s = getState(platform);

  if (s.disabledAt !== null) {
    if (Date.now() - s.disabledAt < COOLDOWN_MS) return false;
    // Cooldown elapsed — clear the window for a fresh read instead of
    // judging the platform on the same failures that got it disabled.
    s.attempts = [];
    s.disabledAt = null;
    return true;
  }

  const judged = judgedAttempts(s);
  if (judged.length < MIN_SAMPLES_TO_JUDGE) return true;

  const successes = judged.filter((a) => a.outcome === "success").length;
  const successRate = successes / judged.length;

  if (successRate < MIN_SUCCESS_RATE) {
    s.disabledAt = Date.now();
    console.warn(
      `[marketplace-health] ${platform} disabled for ${(COOLDOWN_MS / 60_000).toFixed(0)}min — ` +
        `success rate ${(successRate * 100).toFixed(0)}% over ${judged.length} marketplace-specific attempts ` +
        `(${s.attempts.length} total attempts this window, timeouts/errors excluded from this judgment).`,
    );
    return false;
  }

  return true;
}

export function getMarketplaceHealth(platform: string): MarketplaceHealth {
  return computeHealth(platform, getState(platform));
}

export function getAllMarketplaceHealth(): MarketplaceHealth[] {
  return Array.from(state.entries()).map(([platform, s]) => computeHealth(platform, s));
}
