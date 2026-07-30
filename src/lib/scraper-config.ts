// Default values only — this object is never read or mutated at request
// time. The admin panel (ImportListingView.tsx's "Style-Aware Scraper"
// section) seeds its own local React state from these values, and
// src/app/actions/admin-scraper.ts's runStyleAwareScrape merges the
// panel's current selections over these same defaults when it's
// actually invoked.
//
// `enabled: false` stays here as a checked-in, never-true safety
// default, but it is NOT the real gate — a shared, module-level mutable
// flag toggled around a call is unsafe in a serverless deployment (a
// concurrent admin request, or this one erroring before it gets reset,
// could leave it stuck on, or never actually gate anything if the
// module instance differs per invocation). The real gate is
// requireAdmin() inside the server action that's the only thing allowed
// to call runAdminScraper — see admin-scraper.ts's own comment.
export const SCRAPER_CONFIG = {
  enabled: false,
  maxPrice: 25,
  minStyleScore: 15,
  // Image-based outfit-potential gate (src/lib/image-score.ts) — only
  // ever checked AFTER the (cheaper, no-network-call) text-based checks
  // pass, so a listing that fails on price/banned-words/etc. never
  // spends an OpenAI call at all.
  minImageScore: 60,
  allowedSources: ["vinted", "depop"] as string[],
  brandMode: null as string[] | null,
  categoryFilter: null as string[] | null,
  limit: 50,
};

// ---------------------------------------------------------------------------
// Large-scale continuous ingestion ("build a 50,000+ listing inventory over
// time") — defaults only, same non-mutated-at-request-time posture as
// SCRAPER_CONFIG above. The admin UI's "Inventory Growth" card seeds its own
// state from these and can override target/batch size per run; see
// runLargeScaleAdminScraper (src/lib/admin-scraper.ts) for how they're
// actually used.
// ---------------------------------------------------------------------------

// How large the FULL inventory should grow to — this is a floor on TOTAL
// active+pending listings in the table, not "import 50,000 more right now."
// A run started when the table already has, say, 12,000 rows only needs to
// import ~38,000 more to reach this.
export const TARGET_INVENTORY_SIZE = 50_000;

// How many qualified listings ONE batch (one runAdminScraper call) asks for
// — deliberately the same order of magnitude as this scraper's existing
// per-round discovery sizing (MIN/MAX_ROUND_DISCOVERY_TARGET in
// admin-scraper.ts), so one batch is still a normal, boundable unit of work,
// not a single 50,000-row request.
export const BATCH_SIZE = 500;

// Absolute backstop on how many batches ONE large-scale run will attempt —
// same "safety ceiling, not the primary stop condition" role MAX_ROUNDS
// already plays inside a single runAdminScraper call. The real stop
// condition is "inventory reached TARGET_INVENTORY_SIZE"; this only exists
// so a logic bug (or a target that's unreachable at the current pass rate)
// can't loop forever. At BATCH_SIZE=500 this comfortably covers reaching
// TARGET_INVENTORY_SIZE from empty (100 * 500 = 50,000) with room to spare
// for a run that doesn't start from zero.
export const MAX_BATCHES = 100;

// Delay between batches, specific to the large-scale continuous path —
// separate from admin-scraper.ts's own CONTINUOUS_ROUND_DELAY_MS (used by
// the existing, smaller "Continuous Import" card) so tuning one doesn't
// silently change the other.
export const LARGE_SCALE_BATCH_COOLDOWN_MS = 5_000;

// How many times ONE batch is retried (with a cooldown between attempts)
// before it's recorded as a genuinely failed batch and the run moves on to
// the next one — see this file's own "resilient" requirement: a single
// batch failing must never kill the whole job.
export const MAX_BATCH_RETRIES = 3;

// ---------------------------------------------------------------------------
// Overnight mode — a run-CONTINUATION setting, distinct from ScraperMode
// below (which controls AI-enrichment depth per candidate, not how long
// or how the run keeps going). "OVERNIGHT_MODE" per this feature's own
// spec: runLargeScaleAdminScraper still stops for the same safe reasons
// it always has (target reached, paused, too many consecutive batch
// failures) — this only removes the ordinary MAX_BATCHES ceiling in favor
// of a much larger one, and switches batch-level discovery over to
// src/lib/inventory/scaled-discovery.ts's query-generator-backed crawl
// (see admin-scraper.ts's own use of this) so a run spanning many more
// batches than MAX_BATCHES keeps finding genuinely new search
// combinations instead of exhausting the same small term rotation.
// ---------------------------------------------------------------------------
export const OVERNIGHT_MODE = "overnight" as const;

// Safety ceiling for an overnight run — same "backstop, not the real stop
// condition" role MAX_BATCHES already plays for an ordinary run (see its
// own comment above), just large enough that reaching TARGET_INVENTORY_SIZE
// (or a much larger admin-chosen target) from empty overnight is never cut
// short by batch count alone.
export const OVERNIGHT_MAX_BATCHES = 5_000;

// How many pages deep discoverListingUrlsAtScale is allowed to go per
// query before moving on — see scaled-discovery.ts's own comment on why
// this is bounded rather than unlimited.
export const OVERNIGHT_MAX_PAGES_PER_QUERY = 5;

// ---------------------------------------------------------------------------
// OVERNIGHT_AGGRESSIVE — the async-inventory-pipeline mode: acquisition
// (discovery + extraction + insert) must never be blocked by AI
// enrichment. Orthogonal to OVERNIGHT_MODE above (which is about how LONG
// a run keeps going) — this is about HOW each batch acquires listings.
// Can be combined with OVERNIGHT_MODE or used on its own for a single,
// large, non-continuous batch that still wants maximum acquisition
// throughput.
// ---------------------------------------------------------------------------
export const OVERNIGHT_AGGRESSIVE_CONFIG = {
  // Independent per-platform discovery workers — see
  // scaled-discovery.ts's own SCALED_SOURCES for how this maps onto each
  // platform's own concurrency (not one flat number split across
  // platforms; each platform gets its own pool sized around this).
  discoveryWorkers: 5,
  // How many URLs src/lib/admin-scraper.ts's extractRound processes at
  // once when claiming from scraper_url_queue — 2x the ordinary
  // EXTRACTION_CONCURRENCY (10), the actual throughput lever for
  // "maximize overnight acquisition" once AI enrichment is off the
  // critical path.
  extractionWorkers: 20,
  // "AI enrichment disabled during acquisition" — forces mode: "fast"
  // (already-existing, already skips enrichListingsBatch/
  // scoreImagesOutfitPotentialBatch) regardless of what the admin picked,
  // since this is a hard requirement of aggressive mode, not a
  // preference. Enrichment isn't lost — see enqueueListingsForEnrichment
  // wiring in admin-scraper.ts, which queues every inserted listing for
  // the EXISTING async enrichment-queue.ts pipeline (Part 6) to catch up
  // on later, whenever it's convenient to spend the AI-call budget.
  aiEnrichmentDuringAcquisition: false,
} as const;

export type ScraperMode = "fast" | "quality";

// QUALITY_MODE is the existing pipeline, completely unchanged: full batched
// AI enrichment (classification/image-tagging) + image-outfit-potential
// scoring for every candidate that clears the minimal quality gate (real
// title, 2+ photos) — see admin-scraper.ts's enrichAndScoreBatch. FAST_MODE
// skips that AI-enrichment stage entirely and scores candidates on the
// minimal/free signals alone (see finalizeScoredListing's own `enriched`
// parameter in admin-scraper-filter.ts) — larger batches, far fewer OpenAI
// round trips, lower latency per listing, at the cost of losing
// classification/image-tag/image-score signal on every listing imported
// that way. DEFAULT is QUALITY_MODE: "do not blindly import 50k listings."
export const DEFAULT_SCRAPER_MODE: ScraperMode = "quality";

// ---------------------------------------------------------------------------
// Reliability watchdogs — added after a real Inventory Growth job (target
// 50,000, batch 20/86) was found stuck at status='running' with
// last_heartbeat frozen for 40+ minutes: the process was still alive, but
// the in-flight runAdminScraper() call for that batch attempt had stopped
// advancing with no error ever thrown, so nothing already in place (retry
// count, consecutive-failure count, isPaused check) could ever fire again.
// These two constants bound that failure mode without changing any
// discovery/extraction/scoring/dedup logic.
// ---------------------------------------------------------------------------

// Wall-clock ceiling on ONE batch attempt (one runAdminScraper call) inside
// runLargeScaleAdminScraper's retry loop — not a new stop condition for the
// run as a whole. MAX_BATCH_RETRIES/LARGE_SCALE_MAX_CONSECUTIVE_BATCH_FAILURES
// already decide what happens once an attempt is deemed failed; this only
// makes sure "deemed failed" can actually happen instead of waiting forever.
export const PER_BATCH_MAX_RUNTIME_MS = 10 * 60 * 1000; // 10 minutes

// How stale scraper_jobs.last_heartbeat can get before a large-scale job
// is treated as dead rather than "running." Set well above
// PER_BATCH_MAX_RUNTIME_MS so one legitimately slow-but-alive attempt
// (which keeps emitting its own interim heartbeats — see admin-scraper.ts's
// reportStage) is never mistaken for a hung run; this only trips once the
// whole in-process execution has gone dark for longer than even a
// timed-out attempt plus its retries would explain.
export const STALE_JOB_RECOVERY_THRESHOLD_MS = 20 * 60 * 1000; // 20 minutes
