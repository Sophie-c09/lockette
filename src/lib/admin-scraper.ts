// Style-aware admin scraper — ADMIN ONLY, never runs automatically. The
// only thing that gates execution is requireAdmin() inside
// src/app/actions/admin-scraper.ts, the sole caller of runAdminScraper
// below; there is no `enabled` check in this file (see scraper-config.ts's
// own comment on why a shared mutable flag isn't a safe gate).
//
// Reuses the real discovery/extraction/AI-enrichment pipeline
// (marketplace-discovery.ts, listing-extraction.ts, listing-enrichment.ts)
// — the same three steps bulk-import.ts's processBulkImportBatch already
// uses for /admin/import's bulk button — so aesthetic_tags/quality
// fields/brand/size are all populated for real, not skipped. Everything
// lands in the ONE shared `listings` table, status='pending' (never live
// directly), same as every other import path.
//
// Runs as a ROUND-BASED collection loop, not a one-shot pipeline: discover
// a batch, extract+score it, insert survivors, and if the requested count
// still hasn't been reached, discover ANOTHER batch (excluding every URL
// already tried this run) — repeating until enough qualified listings have
// been collected. A one-shot "discover limit*3, extract them all, score
// them all, stop" pipeline was the actual reason a request for e.g. 100
// listings could come back with only a handful: at a real-world pass rate
// as low as ~5% (observed: scraped 129, only 7 passed), a fixed 3x buffer
// massively undershoots what's actually needed, and there was no
// mechanism to go back for more.
//
// Deliberately NOT time-boxed — an earlier version of this loop stopped
// after a fixed ~60s regardless of how far short of the request that
// left it, which defeated the entire point of a round-based "keep going
// until you have enough" design for larger requests (500 at a low pass
// rate could legitimately need several minutes). What stops a run instead
// is entirely logic-based, not clock-based — see MAX_ROUNDS/
// MAX_CONSECUTIVE_LOW_YIELD_ROUNDS/MAX_CONSECUTIVE_HIGH_FAILURE_ROUNDS
// below — so a genuinely-searching-hard run is never cut off early, but a
// run that's actually stuck (nothing new left to find, or every request
// failing outright) still can't spin forever.
//
// Each round runs as explicit STAGES rather than one monolithic
// per-candidate pipeline (extract+enrich+score all in one async function):
// extract all candidates -> minimal quality gate -> batch-enrich/
// batch-score the survivors in small groups. Splitting extraction
// (Playwright/network-bound) from enrichment/scoring (OpenAI-bound) means
// a slow AI call no longer ties up an extraction worker slot, and
// batching the AI calls across several listings at once (classification,
// image tagging, image scoring) cuts the number of OpenAI round trips
// roughly by the batch size instead of paying one round trip per listing
// per signal.
//
// ARCHITECTURE CHANGE (scoring + ranking, not reject/filter): this round
// loop used to hard-reject most candidates against price/style-score/
// image-score/brand/category/banned-word thresholds. It no longer does —
// see admin-scraper-filter.ts's own header comment for the full picture.
// The one thing that can still keep a candidate out is the admission gate
// (src/lib/listing-quality.ts's scoreListingQuality/
// QUALITY_REJECTION_THRESHOLD — the same AI-weighted 0-100 quality score
// Bulk Importer's processBulkImportBatch already uses, not the old blunt
// "title + at least 2 photos" binary check that used to live here);
// everything that clears it gets a `score` attached (src/lib/
// listing-score.ts) and is imported as 'active'/'flagged' regardless of
// how low that score is — Discover ranks by it instead of the scraper
// deciding in advance what's "good enough." Enrichment/image-scoring
// (classification, tagging, outfit-potential) still run and their output
// is still stored — that data remains useful elsewhere — it just no
// longer gates admission. getLearningMemory() is gone from this file for
// the same reason: nothing here reads a LearningMemory anymore (the
// admin_rejections/approved_items-backed boost/reject it drove was part
// of the threshold gate this replaced) — src/lib/learning-memory.ts and
// its rejection-learning.ts/positive-learning.ts helpers are unused now,
// left in place rather than deleted in case a future scoring signal wants
// to reuse that data.
//
// CONTINUOUS INGESTION: runAdminScraper (below) is still exactly one
// bounded batch — discover/extract/score/insert until `options.limit`
// qualified listings are collected, then return. runContinuousAdminScraper
// (further below) is the outer loop that repeats that same batch call
// several times in a row (with a delay between each) so one admin click
// can keep importing well past a single batch's limit, "over time,"
// instead of stopping the moment one batch completes. It does not change
// anything about how a batch itself decides what to keep or how a
// candidate is scored — see that function's own doc comment.
//
// DUPLICATE PREVENTION: the `seenUrls` set below (seeded once from every
// existing product_url) already stops a run from re-discovering a URL
// that's already in the table. filterOutExistingProductUrls, right before
// every insert further down, is a second, independent check against the
// live table at the moment of insertion — the run-start seenUrls snapshot
// can go stale over a long run (especially a multi-hour continuous-
// ingestion run, or two admin sessions scraping at once), so this is what
// actually prevents a duplicate row from landing, not just a duplicate
// re-scrape.
import { createAdminClient } from "@/lib/supabase/admin";
import { discoverListingUrls } from "@/lib/marketplace-discovery";
import {
  discoverListingUrlsAtScale,
  AGGRESSIVE_DISCOVERY_PLATFORMS,
  checkStartupResources,
} from "@/lib/inventory/scaled-discovery";
import { extractListingFromUrl, type ExtractedListing } from "@/lib/listing-extraction";
import { enrichListingsBatch } from "@/lib/listing-enrichment";
import { generateAndSaveListingEmbedding } from "@/lib/listing-embeddings";
import {
  finalizeScoredListing,
  type AdminScraperFilterOptions,
  type StyleFilteredListing,
} from "@/lib/admin-scraper-filter";
// Bulk Importer's proven admission gate (Inventory Growth vs Bulk Importer
// architecture-parity fix) — replaces the old passesMinimalQualityFilters
// blunt binary check (title + at least 2 photos, nothing else considered)
// with the same AI-weighted 0-100 quality score Bulk Importer's
// processBulkImportBatch already uses successfully. See this file's own
// STAGE 2 comment below for the full reasoning.
import { scoreListingQuality, QUALITY_REJECTION_THRESHOLD, type QualityScoreBreakdown } from "@/lib/listing-quality";
import { PipelineFunnel } from "@/lib/pipeline-debug";
import { scoreImagesOutfitPotentialBatch } from "@/lib/image-score";
import { mapWithConcurrency } from "@/lib/concurrency";
import type { ListingsDatabase } from "@/lib/supabase/listings.types";
import { extractMarketplaceId, computeImageHash } from "@/lib/inventory/duplicate-detection";
import { flagListing } from "@/lib/inventory/listing-flagging";
import { enqueueUrls, claimNextUrls, markUrlExtracted, markUrlFailed, getUrlQueueStats } from "@/lib/inventory/url-queue";
import type { UrlQueueRow } from "@/lib/supabase/url-queue.types";
import { runInventoryIndexer } from "@/lib/inventory/inventory-indexer";
import { getAllMarketplaceHealth, type MarketplaceHealth } from "@/lib/inventory/marketplace-health";
import {
  TARGET_INVENTORY_SIZE,
  BATCH_SIZE,
  MAX_BATCHES as LARGE_SCALE_MAX_BATCHES,
  LARGE_SCALE_BATCH_COOLDOWN_MS,
  MAX_BATCH_RETRIES,
  DEFAULT_SCRAPER_MODE,
  OVERNIGHT_MODE,
  OVERNIGHT_MAX_BATCHES,
  OVERNIGHT_MAX_PAGES_PER_QUERY,
  OVERNIGHT_AGGRESSIVE_CONFIG,
  PER_BATCH_MAX_RUNTIME_MS,
  type ScraperMode,
} from "@/lib/scraper-config";
import { forceCloseAllTrackedBrowsers } from "@/lib/browser-concurrency";

// Same "is this a not-yet-migrated column" detection as
// /api/import-listing/route.ts and src/lib/bulk-import.ts — duplicated
// rather than imported since neither of those exports it as a reusable
// function (matches this codebase's existing per-module convention for
// this exact check).
function isMissingColumnError(error: { code?: string; message: string }): boolean {
  return error.code === "PGRST204" || /column .* does not exist/i.test(error.message);
}

// `status` is deliberately NEVER in this list — same reasoning as
// bulk-import.ts's own withoutOptionalFields: dropping it would let
// Postgres fall back to the column's own default, which isn't guaranteed
// to be 'pending' on every database. Every other field here is either
// Hot Item engagement data (source_likes_count/views/comments — see
// hot-score.ts), this scraper's own style/image scoring signals
// (style_score/matched_style/image_score/image_tags/fit_type/
// visual_aesthetic — see admin-scraper-filter.ts), or the new ranking
// `score` (src/lib/listing-score.ts) — all recent schema.sql additions a
// given database may not have applied yet, and selecting/inserting a
// column that doesn't exist fails the *entire* insert, not just that one
// field.
/* eslint-disable @typescript-eslint/no-unused-vars -- destructured only to omit these possibly-not-yet-migrated columns */
function withoutOptionalFields({
  source_likes_count,
  source_views_count,
  source_comments_count,
  style_score,
  matched_style,
  image_score,
  image_tags,
  fit_type,
  visual_aesthetic,
  score,
  // New (see supabase/migrations/20260728063000_add_listing_flagging.sql)
  // — same "possibly not migrated yet" reasoning as every other field
  // here, never `status` itself.
  flag_reason,
  // New (Inventory Growth/Bulk Importer architecture-parity fix) — same
  // "possibly not migrated yet" reasoning; bulk-import.ts's own
  // withoutOptionalFields already omits these same three for the same
  // reason.
  quality_score,
  quality_reason,
  quality_breakdown,
  ...rest
}: StyleFilteredListing & {
  status: "active" | "flagged";
  flag_reason: string | null;
  // Optional here (unlike the fields above) since this function is also
  // called via filterOutDuplicateCandidates's own generic row type, which
  // doesn't carry these three fields in its own signature — they're only
  // ever present on rows built by the round loop's own STAGE 4 above.
  quality_score?: number | null;
  quality_reason?: string | null;
  quality_breakdown?: QualityScoreBreakdown | null;
}) {
  return rest;
}
/* eslint-enable @typescript-eslint/no-unused-vars */

export interface AdminScraperOptions extends AdminScraperFilterOptions {
  allowedSources: string[];
  limit: number;
  // QUALITY_MODE (default, unchanged pipeline) runs the full batched AI
  // enrichment (classification/image-tagging) + image-outfit-potential
  // scoring for every candidate — see enrichAndScoreBatch below. FAST_MODE
  // skips that AI stage entirely; a candidate still gets a real ranking
  // `score` (scoreListingStyle/calculateScore are local, synchronous, no
  // AI calls), it just never gets AI-classified aesthetic_tags/brand/
  // category/image_score. Optional — every EXISTING caller (the
  // Style-Aware Scraper and Continuous Import admin UI cards, which never
  // set this) keeps running QUALITY_MODE exactly as before.
  mode?: ScraperMode;
  // Rows per insert statement — defaults to DB_INSERT_CHUNK_SIZE (25) when
  // omitted, same as every existing caller. The large-scale path passes
  // BATCH_SIZE-aligned 500 here (this feature's own spec: "500 rows per
  // insert, never 50,000 at once") — still going through the exact same
  // chunk-then-per-row-on-failure fallback below, so a bad row in a
  // larger chunk still only costs that one row, not the whole chunk.
  insertChunkSize?: number;
  // Discovery-scaling (src/lib/inventory/scaled-discovery.ts) — set ONLY
  // by runLargeScaleAdminScraper's own batchOptions, never by the
  // Style-Aware Scraper or Continuous Import admin cards (which keep
  // using marketplace-discovery.ts's discoverListingUrls exactly as
  // before, unchanged). When true, each round below crawls the much
  // larger query-generator-backed, paginated, per-platform-parallel
  // discovery pass instead of the old fixed ~50-term rotation — the fix
  // for Inventory Growth's climbing duplicate rate (62% -> 90% -> 93%
  // across batches 1-3 of a real run, root-caused to discovery re-finding
  // already-known listings once the old fixed rotation ran dry).
  useScaledDiscovery?: boolean;
  // How many pages deep one query is allowed to go in scaled discovery —
  // only read when useScaledDiscovery is true.
  maxDiscoveryPagesPerQuery?: number;
  // OVERNIGHT_AGGRESSIVE (scraper-config.ts) — set ONLY by
  // runLargeScaleAdminScraper when the admin picks aggressive/overnight
  // acquisition, never by the Style-Aware Scraper or Continuous Import
  // admin cards. When true: `mode` is forced to "fast" regardless of what
  // was passed (AI enrichment must never block acquisition — see
  // enrichAndScoreBatch), discovery's per-platform concurrency widens to
  // OVERNIGHT_AGGRESSIVE_CONFIG.discoveryWorkers, and extraction switches
  // from the old direct in-memory extractRound to extractRoundViaQueue
  // (scraper_url_queue-backed, extractionWorkers-wide) — see both
  // functions' own comments. Does not touch quality gating or duplicate
  // detection at all — those stay exactly as strict as ever (see this
  // feature's own explicit "do not weaken duplicate detection"
  // requirement).
  aggressiveAcquisition?: boolean;
}

// Fired after every round (and once more after the final insert) with
// cumulative counts so far — purely a progress-reporting hook, never
// consulted for control flow (the round loop's own stop conditions are
// unchanged). Lets a caller persist progress somewhere durable (see
// src/app/api/admin-scraper/run/route.ts) instead of only getting a
// single result at the very end, which is what made this feature safe to
// move out of a synchronous Server Action in the first place.
export interface AdminScraperProgress {
  status: "running";
  scrapedCount: number;
  scoredCount: number;
  passedCount: number;
  insertedCount: number;
  // Extraction failures + insert failures combined — distinct from a
  // normal "extracted fine but didn't match style" rejection, which isn't
  // an error at all. Surfaced in the admin UI (see this task's own spec)
  // so a run that's genuinely failing a lot of requests reads differently
  // from one that's just working through a low pass rate.
  errorCount: number;
  // Dashboard-metrics fix (Inventory Growth/Bulk Importer architecture
  // parity) — real, live running counts instead of the old "stays at this
  // run's last known value until the whole batch completes" approximation
  // runLargeScaleAdminScraper's own interim reporting used to be stuck
  // with, since insert (and therefore dedup/insert-failure counting) now
  // happens every round instead of once at batch-end.
  duplicateCount: number;
  insertFailedCount: number;
  qualityRejectedCount: number;
  // Dashboard requirement "URLs extracted successfully" / "extraction
  // failures by reason" — running totals sourced from each round's own
  // PipelineFunnel.getCounts(), same live-per-round treatment as
  // duplicateCount/insertFailedCount above.
  extractedSuccessfullyCount: number;
  extractionFailuresByReason: Record<string, number>;
  // The most recent candidate URL this run started processing — lets the
  // admin UI show real-time "currently on: ..." visibility instead of just
  // a bare progress bar, and is the single most useful thing to check
  // first if a run ever looks stuck again.
  lastProcessedUrl: string | null;
}

// Maps this feature's lowercase source names onto the real platform
// hostnames discoverListingUrls' own DISCOVERY_SOURCES already crawl.
// Grailed was removed from that list entirely (see marketplace-discovery.ts's
// own comment) — it was never a possible source to begin with, so there's
// nothing to exclude here on top of that.
const SOURCE_HOSTNAME_PATTERNS: Record<string, RegExp> = {
  vinted: /^https:\/\/www\.vinted\.com\//,
  depop: /^https:\/\/www\.depop\.com\//,
  poshmark: /^https:\/\/poshmark\.com\//,
};

function filterUrlsBySource(urls: string[], allowedSources: string[]): string[] {
  const patterns = allowedSources
    .map((source) => SOURCE_HOSTNAME_PATTERNS[source.toLowerCase()])
    .filter((pattern): pattern is RegExp => Boolean(pattern));

  if (patterns.length === 0) return urls;

  return urls.filter((url) => patterns.some((pattern) => pattern.test(url)));
}

// How many extractListingFromUrl calls run at once — Playwright/network-
// bound work (occasionally a full headless-browser render, see
// listing-extraction.ts), no longer sharing a worker slot with the AI
// enrichment/scoring stage below (see this file's own header comment for
// why that split matters). Bumped slightly over the old combined
// PIPELINE_CONCURRENCY=8 now that a worker frees up the moment extraction
// itself finishes, rather than staying occupied through 3 more sequential
// OpenAI calls per candidate.
// ---------------------------------------------------------------------------
// Extraction throughput/batching/backpressure controls — added after the
// discovery -> extraction handoff fix (scaled-discovery.ts no longer
// truncates what it finds, see that file's own header comment) removed the
// old accidental ceiling of ~150 URLs/round. extractRound used to run ONE
// mapWithConcurrency call over however many URLs a round produced — fine
// at 150, but a single round can now realistically produce thousands, and
// mapWithConcurrency (src/lib/concurrency.ts) pre-allocates a full-length
// results array up front, holding every ExtractedListing (images arrays
// and all) in memory at once. These constants bound that without touching
// extraction/validation/dedup/AI logic itself — only how many URLs are
// handed to the EXISTING concurrency primitive at a time.
// ---------------------------------------------------------------------------

// How many URLs extractRound processes per mapWithConcurrency call (Step
// 2 of the throughput fix) — batches run SEQUENTIALLY, one fully
// completing (and its results folded in) before the next starts, so
// memory only ever holds one batch's worth of in-flight/extracted
// listings, never the whole round.
const EXTRACTION_BATCH_SIZE = Number(process.env.EXTRACTION_BATCH_SIZE) || 100;

// Renamed from EXTRACTION_CONCURRENCY (same constant, same role, now
// env-configurable) — the ONE existing concurrency control for
// extraction; batching above does not introduce a second one.
// mapWithConcurrency is still the only primitive that actually runs
// workers, both here and in runAggressiveRound's own claim loop.
// Exported so the metrics API route can report the same configured
// ceiling as "current extraction workers active" without duplicating
// the env-var default here.
export const MAX_EXTRACTION_CONCURRENCY = Number(process.env.MAX_EXTRACTION_CONCURRENCY) || 10;

// Wraps each individual extractListingFromUrl call (Step 5) — NOT a
// replacement for the timeouts already inside html-extractor.ts
// (FETCH_TIMEOUT_MS=15s) or browser-extractor.ts (NAV_TIMEOUT_MS/
// LAUNCH_TIMEOUT_MS=15s each); those still apply and usually resolve
// first. This is a backstop for the one case those don't cover: a worker
// blocked inside browser-extractor.ts's acquireBrowserSlot() waiting for
// a slot that never frees. Does NOT actually cancel the underlying
// Playwright work (no AbortController threads into extraction) — it frees
// the WORKER SLOT so the batch keeps moving; the abandoned page/browser
// still closes on its own via its own internal timeouts, same disclosed
// tradeoff QUEUE_EXTRACTION_ROUND_MAX_WAIT_MS already makes at the round level.
const EXTRACTION_TIMEOUT_MS = Number(process.env.EXTRACTION_TIMEOUT_MS) || 60_000;

// Step 3 — queue depth gates whether discovery is allowed to keep
// enqueueing, so a fast discovery pass can't pile thousands of rows into
// scraper_url_queue while extraction (bounded by the two constants above)
// works through them at a fixed rate. See waitForQueueCapacity's own
// comment for why this lives here, not inside crawlPlatform/scaled-
// discovery.ts.
const MAX_QUEUE_DEPTH_BEFORE_BACKPRESSURE = Number(process.env.MAX_QUEUE_DEPTH_BEFORE_BACKPRESSURE) || 500;
const QUEUE_BACKPRESSURE_POLL_MS = 1_000;

// How many listings go into one batched enrichment/scoring group — batched
// classification/image-tagging/image-scoring calls (see
// listing-classification.ts/image-tagging.ts/image-score.ts) ask the model
// to return one result per listing in order; too large a batch risks the
// model dropping/reordering an item (each of those batch functions falls
// back to per-item calls if the count ever comes back wrong), so this
// stays modest rather than maximizing round-trip savings at the cost of
// reliability.
const ENRICH_BATCH_SIZE = 5;

// scoreListingQuality (STAGE 2's admission gate, replacing the old
// passesMinimalQualityFilters) is one OpenAI vision call per candidate —
// same concurrency Bulk Importer's own QUALITY_SCORE_CONCURRENCY uses,
// bounded independently of ENRICH_BATCH_CONCURRENCY below since it runs on
// the FULL extracted set (before the gate), not just gate survivors.
const QUALITY_SCORE_CONCURRENCY = 4;

// How many ENRICH_BATCH_SIZE-sized groups are enriched/scored concurrently
// — each group makes up to 3 concurrent OpenAI calls (classify-batch,
// tag-batch, score-batch), so this is deliberately lower than
// MAX_EXTRACTION_CONCURRENCY to avoid piling up too many concurrent OpenAI
// requests at once.
const ENRICH_BATCH_CONCURRENCY = 4;

// How many rows to send per Supabase insert call — one round trip per
// chunk of survivors instead of one round trip per row.
const DB_INSERT_CHUNK_SIZE = 25;

// Embedding generation (src/lib/listing-embeddings.ts) is 2 OpenAI calls
// per listing (vision description + text embedding, see
// src/lib/image-similarity.ts) — kept low for the same "don't pile up
// too many concurrent OpenAI requests" reasoning as ENRICH_BATCH_CONCURRENCY.
const EMBEDDING_CONCURRENCY = 4;

// Per-round discovery sizing — how many NEW candidate URLs to ask
// discovery for, given how many qualified listings are still needed.
// Multiplied up front rather than left at a flat 3x (the old one-shot
// default): at the ~5% real-world pass rate this feature has actually
// observed, a 3x buffer was never going to be enough on its own — sizing
// per round (and looping for more rounds if needed) is what actually closes
// the gap, not a single bigger guess.
const MIN_ROUND_DISCOVERY_TARGET = 30;
const MAX_ROUND_DISCOVERY_TARGET = 150;
const ROUND_DISCOVERY_MULTIPLIER = 8;

// ---------------------------------------------------------------------------
// Safeguards — replace the wall-clock deadline this loop used to have. None
// of these are time-based; all of them are "this run is provably not making
// useful progress anymore," so a legitimately-slow-but-productive run (e.g.
// requesting 500 at a low pass rate) is never cut off, but a genuinely
// stuck one still can't loop forever.
// ---------------------------------------------------------------------------

// Absolute backstop on how many discover/extract/score rounds a single run
// can attempt, regardless of how well it's going — protects against a
// logic bug (or a pathological real-world scenario) causing unbounded
// looping. Generous on purpose: at MAX_ROUND_DISCOVERY_TARGET candidates
// per round and a real pass rate as low as the ~5% this feature has
// observed, closing a 500-listing request could legitimately take dozens
// of rounds.
const MAX_ROUNDS = 200;

// If this many consecutive rounds each contribute ZERO new survivors to
// the collected set, the current filters/sources have realistically been
// exhausted — every fresh URL discovery.ts can still find is one this run
// already tried and rejected, or one no round is turning into a pass.
// Continuing would just burn more requests without ever getting closer to
// the target, so this stops rather than looping until MAX_ROUNDS.
const MAX_CONSECUTIVE_LOW_YIELD_ROUNDS = 4;

// If a batch has run this many rounds without reaching its target, stop
// and insert whatever's been collected so far rather than continuing to
// hunt for the rest. A slow-but-nonzero per-round yield (a few new
// survivors most rounds, never a full zero-streak) never trips
// MAX_CONSECUTIVE_LOW_YIELD_ROUNDS above (that only fires on consecutive
// EXACT-zero rounds) — a live run was found doing exactly this: round 95,
// still hunting, zero inserts the whole time, because insert only runs
// once the round loop exits and nothing had forced that yet. This bounds
// how long "collected" can climb before insert gets a chance to catch up,
// independent of the dedicated title+price dedup fix (see
// filterOutDuplicateCandidates) that addressed the other half of the same
// symptom.
const MAX_ROUNDS_BEFORE_PARTIAL_INSERT = 30;

// If a round's dispatched candidates fail to even EXTRACT (network error,
// blocked request, timeout — not "extracted fine but didn't pass style
// scoring") at a rate this high, for this many consecutive rounds, that's
// a sign the source sites are blocking/rate-limiting this run (or a real
// network outage) — a fundamentally different failure mode than "just not
// stylistically matching," and one where keeping the same aggressive
// discovery pace makes things worse, not better.
const HIGH_FAILURE_RATE_THRESHOLD = 0.9;
const MAX_CONSECUTIVE_HIGH_FAILURE_ROUNDS = 3;
const MIN_CANDIDATES_FOR_FAILURE_RATE_CHECK = 10;

export type AdminScraperStopReason =
  | "target_reached"
  | "no_new_candidates"
  | "max_rounds_reached"
  | "low_yield"
  | "high_failure_rate"
  | "partial_batch_timeout"
  | "error";

export interface AdminScraperResult {
  imported: number;
  // Counts surfaced back to the admin UI so a shortfall (imported <
  // requested limit) comes with a real explanation — "found fewer
  // candidates than requested," "found plenty but most got rejected," and
  // "ran out of new inventory to try" look identical as a bare number but
  // call for different admin action.
  requested: number;
  // Cumulative across every round — how many URLs were actually fetched
  // and extracted (not just discovered as a link on a search page).
  scraped: number;
  // Cumulative — how many candidates cleared the quality gate
  // (scoreListingQuality/QUALITY_REJECTION_THRESHOLD, src/lib/
  // listing-quality.ts — the same AI-weighted admission standard Bulk
  // Importer uses) and were actually batch-enriched + given a ranking
  // score (the ones that spent real AI-call budget). Not the same as
  // `imported` below — a scored candidate can still be lost to dedup or a
  // genuine DB insert error afterward (see `duplicates`/`insertFailed`).
  scored: number;
  // Cumulative — every candidate attempted that did NOT end up imported:
  // failed to even extract (network error/blocked request), or failed the
  // quality gate.
  rejected: number;
  // Caught by filterOutDuplicateCandidates right before insert (product
  // URL / image URL / normalized title, against both the live table and
  // this same batch) — distinct from `rejected` above, which never even
  // reached this stage.
  duplicates: number;
  // Scored, not a duplicate, and still failed the actual Supabase insert —
  // a real infrastructure problem (bad columns, a constraint violation,
  // connectivity), never lumped into `rejected`/`duplicates` above since
  // neither of those is what actually happened here.
  insertFailed: number;
  // Cumulative — extraction attempts that produced real data (a title AND
  // at least one image), i.e. funnel's "extraction_ok". Distinct from
  // `scraped` above: `scraped` counts every attempt that didn't throw,
  // including ones that silently came back empty (extracted_but_empty).
  extractedSuccessfully: number;
  // Cumulative, keyed by the funnel's own failure_reason strings (a
  // thrown error's message, or "extracted_but_empty" for a non-throwing
  // but empty result) — dashboard requirement "extraction failures by
  // reason," sourced directly from PipelineFunnel.getCounts() rather than
  // a second parallel counter.
  extractionFailuresByReason: Record<string, number>;
  // requested - imported — how many more qualified listings would still
  // be needed to fully satisfy the request.
  remainingNeeded: number;
  elapsedMs: number;
  rounds: number;
  // Why the collection loop actually stopped — 'target_reached' is the
  // only "everything worked" outcome; every other value means it stopped
  // short and explains why (see the MAX_ROUNDS/MAX_CONSECUTIVE_* constants
  // above for what each one means).
  stopReason: AdminScraperStopReason;
  error?: string;
  // Discovery-scaling dashboard numbers (src/lib/inventory/
  // scaled-discovery.ts) — only ever non-zero when options.useScaledDiscovery
  // is set (large-scale/Inventory Growth batches); a caller using the old
  // discoverListingUrls path (Style-Aware Scraper, Continuous Import)
  // simply doesn't accumulate these, same "optional, additive" posture as
  // every other large-scale-only field in this file.
  queriesCompleted: number;
  pagesSearched: number;
  uniqueUrlsDiscovered: number;
}

export interface BatchRunSummary {
  batchSize: number;
  started: number;
  completed: number;
  failed: number;
  durationMs: number;
}

/**
 * Generic bounded-batch runner — Step 2 of the extraction throughput fix.
 * Splits `items` into sequential chunks of at most `batchSize`, running
 * each chunk through the EXISTING mapWithConcurrency primitive (never a
 * second concurrency mechanism) before starting the next chunk. This is
 * what actually bounds memory: only one batch's worth of in-flight work
 * and results ever exists at once, regardless of how large `items` is —
 * extractRound below is a thin wrapper around this with the real
 * extraction/timeout/counters/funnel wiring; kept generic and exported
 * here specifically so the batching behavior itself (order, chunk sizing,
 * per-item isolation, concurrency ceiling) has a direct unit test (see
 * tests/admin-scraper-batching.test.ts) that doesn't need Playwright or a
 * live database to run `run` against.
 *
 * One item's rejection never aborts the batch or later batches — each
 * item is wrapped in its own try/catch, `run`'s failures are collected in
 * `failed`, everything else in that batch (and every later batch)
 * continues exactly as if it hadn't happened.
 */
export async function runInBatches<T, R>(
  items: T[],
  batchSize: number,
  concurrency: number,
  run: (item: T) => Promise<R>,
  onBatchComplete?: (summary: BatchRunSummary) => void,
): Promise<{ succeeded: R[]; failed: Array<{ item: T; error: unknown }> }> {
  const succeeded: R[] = [];
  const failed: Array<{ item: T; error: unknown }> = [];

  for (let start = 0; start < items.length; start += batchSize) {
    const batch = items.slice(start, start + batchSize);
    const batchStartedAt = Date.now();
    let completedCount = 0;
    let failedCount = 0;

    await mapWithConcurrency(batch, concurrency, async (item) => {
      try {
        succeeded.push(await run(item));
        completedCount++;
      } catch (error) {
        failedCount++;
        failed.push({ item, error });
      }
    });

    onBatchComplete?.({
      batchSize: batch.length,
      started: batch.length,
      completed: completedCount,
      failed: failedCount,
      durationMs: Date.now() - batchStartedAt,
    });
  }

  return { succeeded, failed };
}

/**
 * Races a single extraction against EXTRACTION_TIMEOUT_MS (Step 5) — see
 * that constant's own comment for why this doesn't (and can't) actually
 * cancel the underlying Playwright work, only frees the calling worker
 * slot so the batch keeps moving.
 */
async function extractWithTimeout(url: string, timeoutMs: number): Promise<ExtractedListing> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      extractListingFromUrl(url),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`extraction timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Extracts a whole round's candidate URLs in bounded, sequential batches
 * (runInBatches above) instead of one mapWithConcurrency call over
 * however many URLs the round produced — see EXTRACTION_BATCH_SIZE's own
 * comment for why that stopped being safe once discovery could return
 * thousands. Never throws — a single URL's extraction failure is logged
 * and counted via onExtractionFailed/onScraped, the batch (and round)
 * moves on with whatever did succeed; that was already true of the
 * per-URL try/catch before this change, batching doesn't alter it.
 *
 * ONLY used by the legacy non-scaled-discovery path now (Style-Aware
 * Scraper/Continuous Import, via the plain discoverListingUrls call) —
 * Inventory Growth's own non-aggressive path was switched to
 * runQueueDrivenExtraction (queue unification) and no longer calls this
 * at all. Left in place unchanged for those other callers, which don't
 * use scraper_url_queue and are out of scope for that work.
 */
async function extractRound(
  urls: string[],
  counters: { onScraped: () => void; onExtractionFailed: () => void; onUrlStarted: (url: string) => void },
  funnel: PipelineFunnel,
  concurrency: number = MAX_EXTRACTION_CONCURRENCY,
  batchSize: number = EXTRACTION_BATCH_SIZE,
): Promise<ExtractedListing[]> {
  const { succeeded } = await runInBatches(
    urls,
    batchSize,
    concurrency,
    async (url) => {
      counters.onUrlStarted(url);
      try {
        const extracted = await extractWithTimeout(url, EXTRACTION_TIMEOUT_MS);
        counters.onScraped();
        // extractListingFromUrl never throws past an invalid input URL —
        // a genuinely failed fetch/parse still returns an ExtractedListing
        // with empty fields (title: "", images: []) rather than throwing,
        // so "extraction succeeded" here only means "didn't throw," not
        // "found real data" — that's checked separately at the minimal
        // quality filter stage below. Recorded as a distinct outcome so the
        // funnel can distinguish an exception from a silently-empty result.
        const gotRealData = Boolean(extracted.title) && extracted.images.length > 0;
        funnel.recordExtraction(url, gotRealData, gotRealData ? undefined : "extracted_but_empty");
        return extracted;
      } catch (error) {
        console.error("[admin-scraper] Failed to extract a candidate:", error);
        counters.onExtractionFailed();
        funnel.recordExtraction(url, false, error instanceof Error ? error.message : "unknown_error");
        throw error;
      }
    },
    (summary) => {
      console.log("[FUNNEL][EXTRACTION]", {
        batchSize,
        claimedCount: summary.batchSize,
        started: summary.started,
        succeeded: summary.completed,
        failed: summary.failed,
        durationMs: summary.durationMs,
      });
    },
  );

  return succeeded;
}

// How many times one queued URL is retried (via scraper_url_queue's own
// attempt_count) before it's recorded as permanently 'failed' — same
// "resilient but bounded" role MAX_BATCH_RETRIES already plays for a
// whole batch, just scoped to a single URL here. Shared by BOTH modes now
// (runQueueDrivenExtraction below) — previously aggressive-only, since
// non-aggressive mode never recorded failures onto the queue at all.
const URL_QUEUE_MAX_ATTEMPTS = 3;

// Absolute wall-clock cap on ONE runQueueDrivenExtraction call (below).
// Was aggressive-mode-only (named AGGRESSIVE_ROUND_MAX_WAIT_MS) before
// both modes shared one claim -> extract -> mark -> repeat loop — kept as
// a single constant now that there's a single loop. If discovery hangs
// (as directly observed live — a platform's own crawlPlatform call not
// returning within the whole diagnostic window), this is what stops
// extraction from blocking the pipeline forever rather than a diagnostic
// timeout catching it after the fact.
const QUEUE_EXTRACTION_ROUND_MAX_WAIT_MS = 90_000;
// Once discovery is done producing for this call (aggressive: the
// background discovery promise resolved; non-aggressive: discovery
// already finished synchronously before extraction even starts — see
// that call site's own comment) and the queue has been empty this long,
// there's genuinely nothing left coming — stop polling rather than
// waiting out the full QUEUE_EXTRACTION_ROUND_MAX_WAIT_MS for no reason.
const QUEUE_EXTRACTION_IDLE_CUTOFF_MS = 5_000;

/**
 * Step 3 backpressure — blocks until scraper_url_queue's pending+claimed
 * depth drops below MAX_QUEUE_DEPTH_BEFORE_BACKPRESSURE, polling and
 * logging [FUNNEL][QUEUE] visibility while it waits. Lives here (admin-
 * scraper.ts's own onUrlsFound callback below), not inside crawlPlatform/
 * scaled-discovery.ts — discovery logic itself is unchanged. crawlPlatform
 * already `await`s onUrlsFound before releasing its own per-attempt
 * discovery slot (see scaled-discovery.ts's DISCOVERY_CONCURRENCY gate),
 * so blocking HERE naturally throttles how fast NEW discovery attempts
 * can start, without scaled-discovery.ts knowing anything about queue
 * depth at all — discovery slows down as a consequence of extraction
 * falling behind, not because discovery was taught to check for that
 * itself. Only used by aggressive mode's onUrlsFound (its queue IS the
 * live extraction input); non-aggressive mode's discovery finishes before
 * its own extraction call starts, so there is nothing to backpressure
 * against there — see that call site's own [FUNNEL][QUEUE] log instead.
 */
async function waitForQueueCapacity(context: { discovered: number; queued: number }): Promise<void> {
  let waited = false;
  for (;;) {
    const shouldContinue = await logQueueFunnelAndCheckDepth(context);
    if (shouldContinue) return;
    if (!waited) {
      console.warn(
        `[admin-scraper] scraper_url_queue depth >= ${MAX_QUEUE_DEPTH_BEFORE_BACKPRESSURE} — ` +
          "pausing discovery until extraction catches up.",
      );
      waited = true;
    }
    await new Promise((resolve) => setTimeout(resolve, QUEUE_BACKPRESSURE_POLL_MS));
  }
}

/**
 * Step 7 observability — the ONE place [FUNNEL][QUEUE] is logged, shared
 * by the backpressure check above and the plain post-round log non-
 * aggressive mode uses. `processing`/`completed` are presented as their
 * own fields for readability, but map onto the SAME `claimed`/`extracted`
 * database states getUrlQueueStats already tracks (see url-queue.ts's
 * UrlQueueStatus union — reusing the existing 4 states per this task's
 * Step 4, not inventing a mismatched 5th/6th status column).
 */
async function logQueueFunnelAndCheckDepth(context: { discovered: number; queued: number }): Promise<boolean> {
  const stats = await getUrlQueueStats();
  console.log("[FUNNEL][QUEUE]", {
    discovered: context.discovered,
    queued: context.queued,
    pending: stats.pending,
    claimed: stats.claimed,
    processing: stats.claimed,
    completed: stats.extracted,
    failed: stats.failed,
  });
  return stats.pending + stats.claimed < MAX_QUEUE_DEPTH_BEFORE_BACKPRESSURE;
}

export interface DrainQueueOptions<TItem, TResult> {
  // Stop once this many items have succeeded...
  targetCount: number;
  // ...or once this long has elapsed without reaching it...
  maxWaitMs: number;
  // ...or once claim() comes back empty AND the caller says the producer
  // is done AND it's stayed empty this long (never break on a single
  // empty claim — the producer may just be a beat behind writing its
  // next batch).
  idleCutoffMs: number;
  isProducerDone: () => boolean;
  // Claim size AND per-batch concurrency — same "don't introduce a second
  // concurrency mechanism" posture as runInBatches itself, which this
  // delegates every actual chunk to.
  batchSize: number;
  concurrency: number;
  claim: () => Promise<TItem[]>;
  run: (item: TItem) => Promise<TResult>;
  onSuccess: (item: TItem, result: TResult) => Promise<void> | void;
  onFailure: (item: TItem, error: unknown) => Promise<void> | void;
  onBatchComplete?: (summary: BatchRunSummary & { claimedCount: number }) => void;
  // Test-only override for the empty-claim poll delay (real callers never
  // pass this, defaulting to a real 1s wait) — lets a "keeps polling until
  // the producer catches up" scenario run in milliseconds instead of
  // actual wall-clock seconds.
  pollDelayMs?: number;
}

/**
 * Generic claim -> run -> mark-success/failure -> repeat loop — the
 * mechanism-agnostic core of Step 2's queue unification. Deliberately
 * knows nothing about scraper_url_queue, URLs, or extraction specifically
 * (that binding is runQueueDrivenExtraction below) — `claim`/`run`/
 * `onSuccess`/`onFailure` are injected, which is what makes the loop
 * itself (draining, target/timeout/idle stopping conditions, one item's
 * failure never aborting the batch or later claims) directly unit-
 * testable against an in-memory fake queue (see
 * tests/admin-scraper-queue.test.ts) without Playwright or a live
 * database — the same reasoning runInBatches was already built around.
 */
export async function drainQueue<TItem, TResult>(opts: DrainQueueOptions<TItem, TResult>): Promise<{ results: TResult[] }> {
  const results: TResult[] = [];
  const startedAt = Date.now();
  let lastClaimAt = Date.now();

  while (results.length < opts.targetCount) {
    if (Date.now() - startedAt > opts.maxWaitMs) {
      console.warn(
        `[admin-scraper] drainQueue hit its ${opts.maxWaitMs / 1000}s wait cap — ` +
          `returning ${results.length}/${opts.targetCount} so far.`,
      );
      break;
    }

    const claimed = await opts.claim();

    if (claimed.length === 0) {
      if (opts.isProducerDone() && Date.now() - lastClaimAt > opts.idleCutoffMs) break;
      await new Promise((resolve) => setTimeout(resolve, opts.pollDelayMs ?? 1_000));
      continue;
    }

    lastClaimAt = Date.now();

    const { succeeded } = await runInBatches(
      claimed,
      opts.batchSize,
      opts.concurrency,
      async (item) => {
        try {
          const result = await opts.run(item);
          await opts.onSuccess(item, result);
          return result;
        } catch (error) {
          await opts.onFailure(item, error);
          throw error;
        }
      },
      (summary) => opts.onBatchComplete?.({ ...summary, claimedCount: claimed.length }),
    );

    results.push(...succeeded);
  }

  return { results };
}

interface QueueDrivenExtractionOptions {
  targetCount: number;
  maxWaitMs: number;
  idleCutoffMs: number;
  isDiscoveryDone: () => boolean;
  // Claim size AND per-batch concurrency — preserves each caller's own
  // EXISTING concurrency control (Step 3/4): non-aggressive passes
  // EXTRACTION_BATCH_SIZE/MAX_EXTRACTION_CONCURRENCY, aggressive passes
  // its own pre-existing, deliberately-higher
  // OVERNIGHT_AGGRESSIVE_CONFIG.extractionWorkers for both — this
  // function introduces no concurrency mechanism of its own.
  batchSize: number;
  concurrency: number;
  counters: { onScraped: () => void; onExtractionFailed: () => void; onUrlStarted: (url: string) => void };
  funnel: PipelineFunnel;
}

/**
 * The ONE queue-driven extraction loop (Step 2 of the queue-unification
 * work) — binds drainQueue's generic core to the REAL scraper_url_queue:
 * claim a batch (claimNextUrls), extract it (existing runInBatches/
 * mapWithConcurrency concurrency primitive, existing EXTRACTION_TIMEOUT_MS
 * per URL, inside drainQueue), mark each row's outcome back onto the
 * queue (markUrlExtracted on success, markUrlFailed — existing
 * attempt_count retry — on failure), repeat until targetCount is reached,
 * the queue is drained (empty claim + discovery already done +
 * idleCutoffMs elapsed), or maxWaitMs elapses.
 *
 * Used by BOTH runAggressiveRound and the non-aggressive round loop in
 * runAdminScraper (Inventory Growth only — see each call site's own
 * comment) — this is what makes scraper_url_queue the single source of
 * truth for extraction instead of two separate mechanisms: the only
 * remaining difference between the two modes is how aggressively
 * *discovery* runs (concurrently-with-extraction + backpressure vs.
 * sequential-then-drain), not how extraction itself consumes the queue.
 */
async function runQueueDrivenExtraction(opts: QueueDrivenExtractionOptions): Promise<{ extracted: ExtractedListing[] }> {
  // Extraction-worker tracing — there is no separate worker process to
  // observe starting up (see this function's own header comment: these
  // are concurrent in-process closures, not an independently-triggerable
  // service), so THIS call is the closest real equivalent to "a worker
  // started." Logged once per runQueueDrivenExtraction invocation
  // (aggressive mode: once per round, alongside discovery; non-aggressive:
  // once per round, after discovery completes).
  console.log("[EXTRACTION WORKER] starting", {
    batchSize: opts.batchSize,
    concurrency: opts.concurrency,
    targetCount: opts.targetCount,
    maxWaitMs: opts.maxWaitMs,
    idleCutoffMs: opts.idleCutoffMs,
  });

  const { results } = await drainQueue<UrlQueueRow, ExtractedListing>({
    targetCount: opts.targetCount,
    maxWaitMs: opts.maxWaitMs,
    idleCutoffMs: opts.idleCutoffMs,
    isProducerDone: opts.isDiscoveryDone,
    batchSize: opts.batchSize,
    concurrency: opts.concurrency,
    claim: () => claimNextUrls(opts.batchSize),
    run: async (row) => {
      opts.counters.onUrlStarted(row.url);
      console.log("[EXTRACTION WORKER] attempt", {
        url: row.url,
        platform: row.platform,
        attemptNumber: row.attempt_count + 1,
      });
      const extractedListing = await extractWithTimeout(row.url, EXTRACTION_TIMEOUT_MS);
      opts.counters.onScraped();
      const gotRealData = Boolean(extractedListing.title) && extractedListing.images.length > 0;
      opts.funnel.recordExtraction(row.url, gotRealData, gotRealData ? undefined : "extracted_but_empty");
      return extractedListing;
    },
    onSuccess: (row) => markUrlExtracted(row.id),
    onFailure: (row, error) => {
      console.error("[admin-scraper] Failed to extract a queued candidate:", error);
      opts.counters.onExtractionFailed();
      opts.funnel.recordExtraction(row.url, false, error instanceof Error ? error.message : "unknown_error");
      return markUrlFailed(row, URL_QUEUE_MAX_ATTEMPTS);
    },
    onBatchComplete: (summary) => {
      console.log("[FUNNEL][EXTRACTION]", {
        batchSize: opts.batchSize,
        claimedCount: summary.claimedCount,
        started: summary.started,
        succeeded: summary.completed,
        failed: summary.failed,
        durationMs: summary.durationMs,
      });
    },
  });

  return { extracted: results };
}

interface AggressiveRoundResult {
  extracted: ExtractedListing[];
  // Best-effort, THIS round's own observation window only — see this
  // function's own comment on why the authoritative discovery totals are
  // reported asynchronously via onDiscoveryStats instead.
  enqueuedThisRound: number;
}

/**
 * OVERNIGHT_AGGRESSIVE's real discovery/extraction decoupling — discovery
 * (discoverListingUrlsAtScale) and extraction (runQueueDrivenExtraction)
 * run CONCURRENTLY, not sequentially. Discovery streams each page's URLs
 * into scraper_url_queue via onUrlsFound the moment that page succeeds;
 * the extraction loop starts polling that same queue immediately, without
 * ever awaiting discovery's own completion. A platform stuck timing out
 * (the diagnosed bottleneck — scaled-discovery.ts's crawlPlatform, whole-
 * Promise.all blocking on the slowest platform) no longer holds up
 * extraction from processing whatever OTHER platforms already found.
 *
 * DISCLOSED TRADEOFF: this function does NOT await the discovery call's
 * own completion before returning — if extraction reaches roundTarget (or
 * QUEUE_EXTRACTION_ROUND_MAX_WAIT_MS elapses) while discovery is still
 * mid-crawl, this round returns anyway and discovery keeps running in the
 * background, reporting its final stats via onDiscoveryStats WHENEVER it
 * actually finishes (possibly several rounds later) rather than blocking
 * this round on it. The alternative — waiting for discovery no matter how
 * long it takes — is exactly the behavior being fixed. A consequence: two
 * rounds' discovery calls can briefly overlap (discovery-history's own
 * per-call `processed` snapshot means the same query/page combo could be
 * picked by both before either records it) — harmless in practice since
 * enqueueUrls upserts on the url's own unique index, so a double-crawled
 * URL is just enqueued twice, not imported twice.
 */
async function runAggressiveRound(
  roundTarget: number,
  seenUrls: Set<string>,
  options: AdminScraperOptions,
  counters: { onScraped: () => void; onExtractionFailed: () => void; onUrlStarted: (url: string) => void },
  funnel: PipelineFunnel,
  onDiscoveryStats: (stats: { queriesCompleted: number; pagesSearched: number; uniqueUrlsDiscovered: number }) => void,
): Promise<AggressiveRoundResult> {
  let discoveryDone = false;
  let enqueuedThisRound = 0;

  const discoveryPromise = discoverListingUrlsAtScale(
    roundTarget,
    seenUrls,
    options.maxDiscoveryPagesPerQuery ?? OVERNIGHT_MAX_PAGES_PER_QUERY,
    OVERNIGHT_AGGRESSIVE_CONFIG.discoveryWorkers,
    AGGRESSIVE_DISCOVERY_PLATFORMS,
    async (candidates) => {
      const urls = filterUrlsBySource(
        candidates.map((c) => c.url),
        options.allowedSources,
      );
      if (urls.length === 0) return;
      await waitForQueueCapacity({ discovered: enqueuedThisRound, queued: enqueuedThisRound });
      for (const url of urls) seenUrls.add(url);
      enqueuedThisRound += urls.length;
      await enqueueUrls(
        urls.map((url) => ({
          url,
          platform: extractMarketplaceId(url)?.source ?? "unknown",
          query: "large-scale",
          page: 1,
        })),
      );
    },
  );

  discoveryPromise
    .then((result) => {
      onDiscoveryStats(result);
    })
    .catch((error) => {
      console.error("[admin-scraper] Background discovery producer failed:", error);
    })
    .finally(() => {
      discoveryDone = true;
    });

  const { extracted } = await runQueueDrivenExtraction({
    targetCount: roundTarget,
    maxWaitMs: QUEUE_EXTRACTION_ROUND_MAX_WAIT_MS,
    idleCutoffMs: QUEUE_EXTRACTION_IDLE_CUTOFF_MS,
    isDiscoveryDone: () => discoveryDone,
    // Aggressive mode keeps its OWN pre-existing, deliberately-higher
    // concurrency (20 vs the ordinary 10) — unchanged from before this
    // refactor, not replaced by MAX_EXTRACTION_CONCURRENCY/
    // EXTRACTION_BATCH_SIZE (those remain the non-aggressive path's own
    // controls; see Step 4's own "preserve existing concurrency controls").
    batchSize: OVERNIGHT_AGGRESSIVE_CONFIG.extractionWorkers,
    concurrency: OVERNIGHT_AGGRESSIVE_CONFIG.extractionWorkers,
    counters,
    funnel,
  });

  return { extracted, enqueuedThisRound };
}

interface StreamingScaledRoundResult {
  extracted: ExtractedListing[];
  queuedThisRound: number;
  queriesCompleted: number;
  pagesSearched: number;
  uniqueUrlsDiscovered: number;
}

/**
 * Non-aggressive Inventory Growth's own discovery/extraction overlap fix —
 * same "discovery streams into scraper_url_queue, extraction drains it
 * concurrently" shape as runAggressiveRound above, minus that function's two
 * aggressive-only pieces:
 *   - waitForQueueCapacity backpressure (Step 6 of this fix's own spec) —
 *     non-aggressive discovery is already bounded by roundTarget/
 *     maxPagesPerQuery, so there's nothing here that needs throttling back.
 *   - AGGRESSIVE_DISCOVERY_PLATFORMS / OVERNIGHT_AGGRESSIVE_CONFIG.
 *     discoveryWorkers overrides — every SCALED_SOURCES platform keeps its
 *     own default concurrency, exactly as the old sequential call did.
 *
 * Unlike runAggressiveRound, this function DOES await discovery's own
 * completion before returning (`Promise.all` below, not a fire-and-forget
 * background promise): a non-aggressive round is meant to stay self-
 * contained (bounded discovery -> fully drained queue -> next round), not
 * spill into later rounds the way aggressive mode's disclosed tradeoff
 * allows. That's also why extraction's own `targetCount` is Infinity rather
 * than roundTarget — the only two things that can end this round's
 * extraction are the drainQueue's own maxWaitMs safety cap, or discovery
 * finishing AND the queue staying empty for idleCutoffMs; "reached N
 * successes" would let extraction exit while discovery is still mid-crawl,
 * which is exactly the sequential-boundary behavior being replaced.
 */
async function runNonAggressiveStreamingRound(
  roundTarget: number,
  seenUrls: Set<string>,
  options: AdminScraperOptions,
  extractionCounters: { onScraped: () => void; onExtractionFailed: () => void; onUrlStarted: (url: string) => void },
  funnel: PipelineFunnel,
): Promise<StreamingScaledRoundResult> {
  let discoveryDone = false;
  let queuedThisRound = 0;

  const discoveryPromise = discoverListingUrlsAtScale(
    roundTarget,
    seenUrls,
    options.maxDiscoveryPagesPerQuery ?? OVERNIGHT_MAX_PAGES_PER_QUERY,
    undefined,
    undefined,
    // Streamed straight into scraper_url_queue the moment each page
    // succeeds (same onUrlsFound shape aggressive mode already uses) —
    // extraction below starts draining these without ever waiting for
    // discoverListingUrlsAtScale's own Promise.all across every platform to
    // resolve first.
    async (candidates) => {
      const urls = filterUrlsBySource(
        candidates.map((c) => c.url),
        options.allowedSources,
      );
      if (urls.length === 0) return;
      for (const url of urls) seenUrls.add(url);
      queuedThisRound += urls.length;
      await enqueueUrls(
        urls.map((url) => ({
          url,
          platform: extractMarketplaceId(url)?.source ?? "unknown",
          query: "large-scale",
          page: 1,
        })),
      );
      // Step 7 visibility — logged (not gated on) so [FUNNEL][QUEUE] shows
      // queue depth fluctuating WHILE discovery is still running, without
      // this call ever blocking discovery the way waitForQueueCapacity
      // does for aggressive mode (Step 6: no backpressure here).
      await logQueueFunnelAndCheckDepth({ discovered: queuedThisRound, queued: queuedThisRound });
    },
  ).finally(() => {
    discoveryDone = true;
  });

  const extractionPromise = runQueueDrivenExtraction({
    targetCount: Infinity,
    maxWaitMs: QUEUE_EXTRACTION_ROUND_MAX_WAIT_MS,
    idleCutoffMs: QUEUE_EXTRACTION_IDLE_CUTOFF_MS,
    isDiscoveryDone: () => discoveryDone,
    // Non-aggressive mode keeps its OWN pre-existing concurrency controls —
    // unchanged from before this fix, not aggressive mode's higher
    // OVERNIGHT_AGGRESSIVE_CONFIG.extractionWorkers.
    batchSize: EXTRACTION_BATCH_SIZE,
    concurrency: MAX_EXTRACTION_CONCURRENCY,
    counters: extractionCounters,
    funnel,
  });

  const [discoveryResult, extractionResult] = await Promise.all([discoveryPromise, extractionPromise]);

  return {
    extracted: extractionResult.extracted,
    queuedThisRound,
    queriesCompleted: discoveryResult.queriesCompleted,
    pagesSearched: discoveryResult.pagesSearched,
    uniqueUrlsDiscovered: discoveryResult.uniqueUrlsDiscovered,
  };
}

/**
 * Duplicate prevention that runs immediately before every insert attempt
 * (see this file's own header comment on why this is a separate check
 * from the run-start `seenUrls` dedupe). Batched into one `.in()` lookup
 * per chunk rather than one query per row — same "chunk, don't loop
 * per-row" convention DB_INSERT_CHUNK_SIZE already uses elsewhere in this
 * file. Best-effort: if the existence check itself fails, this logs and
 * lets the chunk through rather than blocking the insert on a lookup
 * error — the same "never let a diagnostic step abort the scrape" stance
 * this file already takes for existingUrlsError above.
 */
async function filterOutExistingProductUrls(
  supabase: ReturnType<typeof createAdminClient<ListingsDatabase>>,
  rows: Array<StyleFilteredListing & { status: "active" | "flagged"; flag_reason: string | null }>,
): Promise<Array<StyleFilteredListing & { status: "active" | "flagged"; flag_reason: string | null }>> {
  const urls = rows.map((row) => row.product_url).filter((url): url is string => Boolean(url));
  if (urls.length === 0) return rows;

  const { data: existing, error } = await supabase.from("listings").select("product_url").in("product_url", urls);

  if (error) {
    console.error("[admin-scraper] Duplicate check failed (continuing without it for this chunk):", error);
    return rows;
  }

  const existingUrls = new Set(
    (existing ?? []).map((row) => row.product_url).filter((url): url is string => Boolean(url)),
  );

  return rows.filter((row) => {
    if (row.product_url && existingUrls.has(row.product_url)) {
      console.log("Skipping duplicate:", row.product_url);
      return false;
    }
    return true;
  });
}

// Same normalization on both sides of every comparison below — lowercase,
// strip anything that isn't a letter/digit/space, collapse whitespace. This
// catches "same listing, tracked with different case/punctuation/spacing"
// (a very common real-world source of near-duplicates across re-scrapes of
// the same item) without needing a fuzzy-matching library or an
// embedding-based similarity search over the whole table — it's an EXACT
// match after normalization, not true fuzzy/Levenshtein similarity, which
// would need its own index to stay cheap at 50,000+ rows. Documented
// limitation, not a silent gap: a title that differs by more than
// case/punctuation/whitespace (e.g. a reseller's own edits between two
// listings of the same physical item) will not be caught by this.
// Exported for src/lib/inventory/duplicate-detection.ts (Part 5) — one
// normalization implementation, reused rather than a second copy that
// could drift from this one.
export function normalizeTitleForDedup(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export interface DedupCounts {
  duplicates: number;
}

/**
 * Richer duplicate check for the large-scale ingestion path (section 5 of
 * this feature's own spec): product URL (filterOutExistingProductUrls'
 * own check, reused here) PLUS image URL and normalized-title exact match
 * against the live table, PLUS within-batch dedup against candidates
 * already accepted earlier in this SAME batch (two different source
 * pages sometimes surface the same physical listing). There is no
 * separate "marketplace ID" field in this codebase's extraction pipeline
 * (ExtractedListing has no such column) — product_url already serves that
 * role in practice, since every source's listing URL embeds its own
 * unique item id.
 *
 * Bounded — one .in() lookup per field per chunk, not a full-table scan —
 * same scaling posture as filterOutExistingProductUrls, which matters a
 * lot more once the table genuinely has 50,000+ rows in it.
 */
// How many surviving candidates get their image bytes fetched+hashed at
// once — network-bound (one fetch per row), so bounded the same way
// MAX_EXTRACTION_CONCURRENCY/EMBEDDING_CONCURRENCY already are elsewhere in
// this file, not a per-row sequential loop.
const IMAGE_HASH_DEDUP_CONCURRENCY = 8;

/**
 * Requirement 5's "image hash duplicate" step, ordered between the cheap
 * URL/image-URL exact checks above and the title check below — catches
 * the SAME photo re-hosted under a genuinely different image URL (a
 * common real pattern across reseller re-posts), which an exact image_url
 * match cannot. Reuses duplicate-detection.ts's computeImageHash (Part 5)
 * rather than a second hashing implementation — see that function's own
 * comment for the honest "byte-identical, not a true perceptual hash"
 * limitation. Best-effort: a candidate whose image fails to fetch/hash is
 * let through rather than rejected (same posture as every other dedup
 * check in this file) — this is a real, disclosed cost of the extra
 * network round trip, not a silent one: only rows that already survived
 * the free URL/image-URL checks above ever pay it.
 */
async function filterOutImageHashDuplicates(
  supabase: ReturnType<typeof createAdminClient<ListingsDatabase>>,
  rows: Array<StyleFilteredListing & { status: "active" | "flagged"; flag_reason: string | null }>,
  counts: DedupCounts,
): Promise<Array<StyleFilteredListing & { status: "active" | "flagged"; flag_reason: string | null }>> {
  const hashes = await mapWithConcurrency(rows, IMAGE_HASH_DEDUP_CONCURRENCY, (row) =>
    computeImageHash(row.image_url ?? null),
  );

  const candidateHashes = Array.from(new Set(hashes.filter((hash): hash is string => Boolean(hash))));

  let existingHashes = new Set<string>();
  if (candidateHashes.length > 0) {
    const { data, error } = await supabase.from("listings").select("image_hash").in("image_hash", candidateHashes);

    if (error) {
      if (isMissingColumnError(error)) {
        console.warn(
          "[admin-scraper] image_hash column not found on this database yet — skipping image-hash dedup " +
            "for this chunk. Run the latest supabase/schema.sql to enable it.",
        );
      } else {
        console.error("[admin-scraper] Image-hash duplicate check failed (continuing without it):", error);
      }
    } else {
      existingHashes = new Set(
        (data ?? []).map((row) => row.image_hash).filter((hash): hash is string => Boolean(hash)),
      );
    }
  }

  const seenHashesInBatch = new Set<string>();

  return rows.filter((row, index) => {
    const hash = hashes[index];
    if (!hash) return true;

    if (existingHashes.has(hash)) {
      console.log("Skipping duplicate (image content hash already in inventory):", row.product_url);
      counts.duplicates++;
      return false;
    }
    if (seenHashesInBatch.has(hash)) {
      console.log("Skipping duplicate (matching image hash earlier in this same batch):", row.product_url);
      counts.duplicates++;
      return false;
    }

    seenHashesInBatch.add(hash);
    return true;
  });
}

async function filterOutDuplicateCandidates(
  supabase: ReturnType<typeof createAdminClient<ListingsDatabase>>,
  rows: Array<StyleFilteredListing & { status: "active" | "flagged"; flag_reason: string | null }>,
  counts: DedupCounts,
): Promise<Array<StyleFilteredListing & { status: "active" | "flagged"; flag_reason: string | null }>> {
  // 1. Product URL — cheapest, exact, unchanged.
  const byUrl = await filterOutExistingProductUrls(supabase, rows);
  counts.duplicates += rows.length - byUrl.length;
  if (byUrl.length === 0) return byUrl;

  // 2. Image URL — cheap, exact, DB-only. Runs before the network-bound
  // image-hash check below so only candidates that survive this free
  // check ever pay a fetch.
  const imageUrls = byUrl.map((row) => row.image_url).filter((url): url is string => Boolean(url));
  const { data: imageMatchData, error: imageMatchError } =
    imageUrls.length > 0
      ? await supabase.from("listings").select("image_url").in("image_url", imageUrls)
      : { data: [] as { image_url: string | null }[], error: null };

  if (imageMatchError) {
    console.error("[admin-scraper] Image-URL duplicate check failed (continuing without it):", imageMatchError);
  }

  const existingImageUrls = new Set(
    (imageMatchData ?? []).map((row) => row.image_url).filter((url): url is string => Boolean(url)),
  );

  const byImageUrl = byUrl.filter((row) => {
    if (row.image_url && existingImageUrls.has(row.image_url)) {
      console.log("Skipping duplicate (image URL already in inventory):", row.product_url);
      counts.duplicates++;
      return false;
    }
    return true;
  });
  if (byImageUrl.length === 0) return byImageUrl;

  // 3. Image content hash (requirement 5) — see filterOutImageHashDuplicates'
  // own comment.
  const byImageHash = await filterOutImageHashDuplicates(supabase, byImageUrl, counts);
  if (byImageHash.length === 0) return byImageHash;

  // 4. Title — exact-normalized title match AND matching price, against
  // the live table, plus within-batch dedup against candidates already
  // accepted earlier in this same batch. title isn't stored
  // pre-normalized, so the DB side catches only EXACT (non-normalized)
  // matches — normalized comparison happens client-side just below
  // against this same result set.
  //
  // Price is now required alongside the title match — NOT a loosening of
  // duplicate prevention, a fix for a real false-positive bug found live:
  // src/lib/extraction/generate-title.ts generates titles as
  // "{itemType} · {brand}" with generic fallbacks ("item · other", "item")
  // when it can't confidently resolve either — live inventory was found to
  // have only 937 distinct titles across ~8,000 rows, with titles like
  // "item · other" shared by 12 completely different product URLs. Title
  // alone was rejecting genuinely distinct listings (different seller,
  // different product_url, different image, already past checks 1-3
  // above) as "duplicates" purely because they'd both fallen back to the
  // same generic generated title — this was the actual cause of valid
  // candidates never reaching insert. Two DIFFERENT items independently
  // sharing both the same generic title AND the exact same price is a
  // much rarer coincidence than sharing a generic title alone, while a
  // genuine re-listing of the SAME physical item (this check's original
  // intent) keeps the same advertised price essentially always — so this
  // still catches real duplicates, just not unrelated items anymore.
  const { data: titleMatchData, error: titleMatchError } = await supabase
    .from("listings")
    .select("title, price")
    .in(
      "title",
      byImageHash.map((row) => row.title),
    );

  if (titleMatchError) {
    console.error("[admin-scraper] Title duplicate check failed (continuing without it):", titleMatchError);
  }

  function titlePriceKey(title: string, price: number | null): string {
    return `${normalizeTitleForDedup(title)}::${price ?? "null"}`;
  }

  const existingTitlePriceKeys = new Set(
    (titleMatchData ?? []).map((row: { title: string; price: number | null }) => titlePriceKey(row.title, row.price)),
  );

  const seenInBatch = new Set<string>();

  return byImageHash.filter((row) => {
    const key = titlePriceKey(row.title, row.price);

    if (existingTitlePriceKeys.has(key)) {
      console.log("Skipping duplicate (matching title + price already in inventory):", row.product_url);
      counts.duplicates++;
      return false;
    }
    if (seenInBatch.has(key)) {
      console.log("Skipping duplicate (matching title + price earlier in this same batch):", row.product_url);
      counts.duplicates++;
      return false;
    }

    seenInBatch.add(key);
    return true;
  });
}

/**
 * Enriches + scores one small batch of already minimally-qualified
 * (title + 2+ images) candidates: one batched classification call, one
 * batched image-tagging call (both via enrichListingsBatch), one batched
 * image-score call, then attaches a ranking `score`
 * (src/lib/listing-score.ts) to every single one of them — nothing gets
 * rejected here, see this file's own header comment for the full
 * architecture change. Never throws: a batch enrichment failure falls
 * back to the group's un-enriched listings rather than losing the whole
 * batch (enrichListingsBatch/scoreImagesOutfitPotentialBatch already fall
 * back to per-item calls internally on their own failures).
 */
// Neutral placeholder passed to finalizeScoredListing for FAST_MODE, where
// the AI image-scoring call (scoreImagesOutfitPotentialBatch) never runs at
// all — `score` still comes out meaningful (scoreListingStyle/calculateScore
// are local/synchronous), it just never factors in an image_score, and
// image_tags/fit_type/visual_aesthetic stay empty/unknown rather than
// AI-derived.
const NO_IMAGE_SCORE = { score: 0, tags: [] as string[], fit: "unknown", aesthetic: [] as string[] };

async function enrichAndScoreBatch(
  batch: ExtractedListing[],
  mode: ScraperMode = DEFAULT_SCRAPER_MODE,
): Promise<StyleFilteredListing[]> {
  // FAST_MODE: "larger batches, fewer AI checks" — skips both AI calls
  // (batched classification/tagging, and image-outfit-potential scoring)
  // entirely rather than just running them faster, so a large-scale run
  // can move through many more candidates per unit of OpenAI-call budget.
  // QUALITY_MODE below is completely unchanged from before this option
  // existed.
  if (mode === "fast") {
    return batch.map((listing) => finalizeScoredListing(listing, NO_IMAGE_SCORE));
  }

  let enrichedBatch: ExtractedListing[];
  try {
    enrichedBatch = await enrichListingsBatch(batch);
  } catch (error) {
    console.error("[admin-scraper] Batch enrichment failed, scoring un-enriched listings instead:", error);
    enrichedBatch = batch;
  }

  const imageResults = await scoreImagesOutfitPotentialBatch(enrichedBatch.map((listing) => listing.image_url!));

  return enrichedBatch.map((listing, index) => finalizeScoredListing(listing, imageResults[index]));
}

/**
 * Runs the style-aware scraper end to end: repeatedly discovers, extracts,
 * enriches, and style-scores candidates — inserting survivors into the
 * shared `listings` table, always `status: 'pending'` — until
 * `options.limit` qualified listings have been collected. Not time-boxed
 * (see this file's own header comment); see the MAX_ROUNDS/
 * MAX_CONSECUTIVE_* constants above for what CAN still stop it short. No
 * `enabled`/auth check here — the caller (runStyleAwareScrape) is the
 * real, only gate, same as every other internal pipeline function in this
 * codebase.
 *
 * Style scoring (style-score.ts's boho_y2k/soft_feminine/y2k_casual
 * archetype matching) still runs against every candidate, but no longer
 * gates admission — it's one input to calculateScore
 * (src/lib/listing-score.ts), which attaches a ranking `score` to every
 * candidate that clears the two minimal quality gates
 * (admin-scraper-filter.ts's passesMinimalQualityFilters: a real title,
 * at least 2 photos). Nothing is ever imported as anything other than
 * 'pending'.
 */
export async function runAdminScraper(
  options: AdminScraperOptions,
  onProgress?: (progress: AdminScraperProgress) => void | Promise<void>,
): Promise<AdminScraperResult> {
  const startedAt = Date.now();
  const elapsed = () => Date.now() - startedAt;
  const elapsedSeconds = () => (elapsed() / 1000).toFixed(1);

  try {
    console.log(`[admin-scraper] Requested: ${options.limit}`);

    const supabase = createAdminClient<ListingsDatabase>();

    const { data: existingRows, error: existingUrlsError } = await supabase.from("listings").select("product_url");

    if (existingUrlsError) {
      // Best-effort — a failed dedupe lookup shouldn't abort the whole
      // scrape, it just means this run risks re-discovering a URL that's
      // already been imported (processBulkImportBatch's own product_url
      // upsert already handles that safely elsewhere in this codebase).
      console.error(
        "[admin-scraper] Failed to fetch existing product_urls (continuing without dedupe):",
        existingUrlsError,
      );
    }

    // Grows across rounds as newly-discovered URLs are tried — so round 2
    // never re-discovers round 1's candidates, whether they passed or
    // failed. This is the actual "skip duplicate URLs" / "skip listings
    // already in Supabase" safeguard — seeded from every existing
    // product_url and never shrinking.
    const seenUrls = new Set(
      (existingRows ?? []).map((row) => row.product_url).filter((url): url is string => Boolean(url)),
    );

    const collected: StyleFilteredListing[] = [];
    let totalScraped = 0;
    let totalExtractionFailed = 0;
    let totalFailedMinimalFilter = 0;
    let totalScored = 0;
    // Real running total of rows actually written to Supabase — insert now
    // happens per-round (see the end of the round loop below), not once
    // after every round has finished, so this is the loop's real stop
    // condition and the number onProgress reports mid-run. Previously the
    // loop ran on `collected.length` (gate-survivors, before dedup/insert
    // even ran) and every onProgress call mid-run hardcoded insertedCount
    // to 0 — which is why "Imported/minute" read 0 for an entire batch
    // even once something eventually got inserted at the very end.
    let totalImported = 0;
    let totalInsertFailed = 0;
    let totalDuplicates = 0;
    // Sourced from each round's own funnel.getCounts() right after
    // funnel.summarize() below — reusing the same counters the funnel
    // already tracks rather than adding a second mechanism.
    let totalExtractedSuccessfully = 0;
    const extractionFailuresByReason: Record<string, number> = {};
    let rounds = 0;
    let consecutiveLowYieldRounds = 0;
    let consecutiveHighFailureRounds = 0;
    let stopReason: AdminScraperStopReason = "target_reached";
    // Discovery-scaling dashboard numbers — only ever incremented below
    // when options.useScaledDiscovery is set; stay at 0 for the old
    // discoverListingUrls path (Style-Aware Scraper/Continuous Import),
    // which never reports them.
    let queriesCompleted = 0;
    let pagesSearched = 0;
    let uniqueUrlsDiscovered = 0;

    // Performance logging (this task's own spec) — summed across every
    // round so the final summary line reports the real total time spent
    // in each stage, not just the last round's. Discovery's own timing
    // isn't separately tracked here since marketplace-discovery.ts already
    // logs per-(term, platform) timing internally; "scraping" below means
    // this file's own extraction stage specifically.
    let totalScrapeMs = 0;
    let totalScoreMs = 0;
    let totalInsertMs = 0;
    let lastProcessedUrl: string | null = null;

    // Reliability: granular stage/heartbeat reporting, gated to large-scale
    // (Inventory Growth) runs only via options.useScaledDiscovery — the
    // same flag admin-scraper.ts already reserves exclusively for
    // runLargeScaleAdminScraper (see that option's own comment) — so
    // Style-Aware Scraper / Continuous Import get no extra onProgress
    // calls and no behavior change. Reuses the existing onProgress hook
    // rather than adding a new one: runLargeScaleAdminScraper's own
    // per-round onProgress wrapper already throttles actual DB writes to
    // once per INTERIM_PROGRESS_MIN_INTERVAL_MS, so calling this at every
    // stage boundary can't hammer the database — it just gives
    // last_heartbeat many more chances to move within a single round
    // instead of only at round-end, which is what let a real run sit
    // frozen for 40+ minutes with nothing to show for it.
    async function reportStage(stage: string): Promise<void> {
      console.log(`[stage] ${stage}`);
      if (!options.useScaledDiscovery || !onProgress) return;
      try {
        await onProgress({
          status: "running",
          scrapedCount: totalScraped,
          scoredCount: totalScored,
          passedCount: collected.length,
          insertedCount: totalImported,
          errorCount: totalExtractionFailed + totalInsertFailed,
          duplicateCount: totalDuplicates,
          insertFailedCount: totalInsertFailed,
          qualityRejectedCount: totalFailedMinimalFilter,
          extractedSuccessfullyCount: totalExtractedSuccessfully,
          extractionFailuresByReason,
          lastProcessedUrl,
        });
      } catch (error) {
        console.error(`[admin-scraper] onProgress callback failed at stage "${stage}":`, error);
      }
    }

    while (totalImported < options.limit) {
      if (rounds >= MAX_ROUNDS) {
        console.warn(`[admin-scraper] Reached MAX_ROUNDS (${MAX_ROUNDS}) — stopping as a runaway-loop safeguard.`);
        stopReason = "max_rounds_reached";
        break;
      }

      rounds++;
      const remainingNeeded = options.limit - totalImported;
      const roundTarget = Math.min(
        MAX_ROUND_DISCOVERY_TARGET,
        Math.max(MIN_ROUND_DISCOVERY_TARGET, remainingNeeded * ROUND_DISCOVERY_MULTIPLIER),
      );

      console.log(
        `[admin-scraper] Round ${rounds} start — elapsed ${elapsedSeconds()}s — ` +
          `scraped ${totalScraped}, scored ${totalScored}, passed ${collected.length}/${options.limit}, ` +
          `remaining needed ${remainingNeeded} — discovering up to ${roundTarget} new candidates`,
      );

      let roundExtractionFailures = 0;

      // TEMPORARY diagnostic funnel for this round (continuous importer
      // "0 found" investigation — see src/lib/pipeline-debug.ts's own
      // header comment). Fresh per round, matching this feature's own
      // "log counts for every batch" requirement.
      const funnel = new PipelineFunnel();
      const extractionCounters = {
        onScraped: () => totalScraped++,
        onExtractionFailed: () => {
          totalExtractionFailed++;
          roundExtractionFailures++;
        },
        onUrlStarted: (url: string) => {
          lastProcessedUrl = url;
        },
      };

      let extracted: ExtractedListing[];
      const scrapeStart = Date.now();
      await reportStage("discovery_start");

      if (options.aggressiveAcquisition) {
        // Discovery redesign — discovery and extraction run CONCURRENTLY
        // inside runAggressiveRound (see its own comment), not
        // sequentially: extraction starts consuming scraper_url_queue the
        // moment the first URL is streamed in, never waiting for a full
        // discovery round to return. This is the direct fix for the
        // diagnosed bottleneck (a hung/timing-out platform blocking the
        // whole pipeline). Discovery totals are reported asynchronously
        // via the callback below — see runAggressiveRound's own comment
        // on why they can lag behind the round that triggered them.
        const roundResult = await runAggressiveRound(
          roundTarget,
          seenUrls,
          options,
          extractionCounters,
          funnel,
          (stats) => {
            queriesCompleted += stats.queriesCompleted;
            pagesSearched += stats.pagesSearched;
            uniqueUrlsDiscovered += stats.uniqueUrlsDiscovered;
          },
        );
        extracted = roundResult.extracted;

        if (roundResult.enqueuedThisRound === 0 && extracted.length === 0) {
          console.warn(
            `[admin-scraper] Aggressive round ${rounds} produced no new candidates within its wait window — ` +
              "continuing (a slow/unhealthy platform this round doesn't mean the run is stuck).",
          );
        }
      } else if (options.useScaledDiscovery) {
        // Non-aggressive streaming fix — discovery and extraction now run
        // CONCURRENTLY here too (runNonAggressiveStreamingRound above),
        // instead of the old discover-everything-THEN-drainQueue sequence.
        // That old sequence meant extraction queue depth sat at 0 and
        // imported/minute stayed 0 for this round's entire discovery
        // phase; streaming means extraction starts consuming
        // scraper_url_queue the moment the first URL is enqueued. See
        // runNonAggressiveStreamingRound's own comment for how this
        // differs from aggressive mode's overlap (no backpressure, and
        // this round still fully awaits discovery before moving on).
        const roundResult = await runNonAggressiveStreamingRound(roundTarget, seenUrls, options, extractionCounters, funnel);
        extracted = roundResult.extracted;
        queriesCompleted += roundResult.queriesCompleted;
        pagesSearched += roundResult.pagesSearched;
        uniqueUrlsDiscovered += roundResult.uniqueUrlsDiscovered;

        if (roundResult.queuedThisRound === 0 && extracted.length === 0) {
          console.warn(`[admin-scraper] Round ${rounds} found no new candidates — stopping (nothing left to try).`);
          stopReason = "no_new_candidates";
          break;
        }
      } else {
        // Legacy path (Style-Aware Scraper/Continuous Import) — no queue
        // involved, sequential discover-then-extract, completely
        // unchanged: this fix is scoped to Inventory Growth
        // (options.useScaledDiscovery) only.
        const discoveredUrls = await discoverListingUrls(roundTarget, seenUrls, "any", [], []);
        const sourceFilteredUrls = filterUrlsBySource(discoveredUrls, options.allowedSources);

        if (sourceFilteredUrls.length === 0) {
          console.warn(`[admin-scraper] Round ${rounds} found no new candidates — stopping (nothing left to try).`);
          stopReason = "no_new_candidates";
          break;
        }

        // Defensive de-dup (discoverListingUrls already guarantees
        // uniqueness both within itself and against seenUrls/excludeUrls
        // — this is a cheap, explicit safety net against ever running the
        // expensive part of the pipeline twice for the same URL, not a
        // load-bearing step).
        const uniqueUrls = Array.from(new Set(sourceFilteredUrls));
        for (const url of uniqueUrls) seenUrls.add(url);

        await reportStage("discovery_complete");
        await reportStage("extraction_start");

        extracted = await extractRound(uniqueUrls, extractionCounters, funnel, MAX_EXTRACTION_CONCURRENCY, EXTRACTION_BATCH_SIZE);
      }
      // Note: both the aggressiveAcquisition branch (runAggressiveRound)
      // and the non-aggressive useScaledDiscovery branch
      // (runNonAggressiveStreamingRound) run discovery and extraction
      // CONCURRENTLY now — they can't be split into separate
      // discovery_complete/extraction_start markers without touching that
      // concurrency, so this single marker covers both. Only the legacy
      // (non-scaled) path above still reports those two stages separately,
      // since it's still genuinely sequential.
      await reportStage("extraction_complete");

      totalScrapeMs += Date.now() - scrapeStart;

      // STAGE 2: AI-weighted quality gate — same admission standard Bulk
      // Importer's processBulkImportBatch already uses successfully
      // (scoreListingQuality/QUALITY_REJECTION_THRESHOLD, src/lib/
      // listing-quality.ts), replacing the old blunt binary check (a real
      // title AND at least 2 photos, nothing else considered). That old
      // gate rejected a listing with 1 great photo, a real price, a real
      // brand, and real aesthetic tags exactly the same as one with 0
      // photos and no data at all — this scores the whole picture (image
      // quality, product appeal, completeness, fashion relevance, price)
      // and only rejects genuinely poor candidates. A fully-blocked
      // extraction (no image, no real title/price/brand — the anti-bot
      // case, not a validation-strictness case) still scores well under
      // the threshold either way; this doesn't paper over blocking, it
      // stops throwing away real, sellable listings alongside it.
      await reportStage("quality_gate_start");
      const qualityByUrl = new Map<string, { score: number; reason: string; breakdown: QualityScoreBreakdown }>();
      await mapWithConcurrency(extracted, QUALITY_SCORE_CONCURRENCY, async (listing) => {
        const { qualityScore, qualityReason, breakdown } = await scoreListingQuality(listing);
        qualityByUrl.set(listing.product_url, { score: qualityScore, reason: qualityReason, breakdown });
        const passed = qualityScore >= QUALITY_REJECTION_THRESHOLD;
        funnel.recordMinimalQualityFilter(listing.product_url, passed, passed ? undefined : `quality_score:${qualityScore}`);
        // Extraction-pipeline tracing (Depop/Vinted/Poshmark 0%-success
        // investigation) — the exact fields the gate just decided on, and
        // the exact reason, always-on (not gated behind
        // DEBUG_IMPORT_PIPELINE — that flag controls pipeline-debug.ts's
        // separate verbose per-stage JSON lines/failed-candidate dump,
        // this is specifically "what did validation see and why did it
        // decide what it decided," which needs to be visible by default).
        console.log("[extraction] parsed fields before validation", {
          url: listing.product_url,
          title: listing.title,
          price: listing.price,
          image_url: listing.image_url,
          imagesCount: listing.images.length,
          qualityScore,
          qualityReason,
          passed,
        });
      });
      const scorable = extracted.filter((listing) => (qualityByUrl.get(listing.product_url)?.score ?? 0) >= QUALITY_REJECTION_THRESHOLD);
      totalFailedMinimalFilter += extracted.length - scorable.length;
      await reportStage("quality_gate_complete");

      // STAGE 3: batch-enrich + batch-score in small groups, several
      // groups concurrently. Nothing rejected here either — every
      // candidate that reaches this stage gets a `score` attached and is
      // kept (see enrichAndScoreBatch/finalizeScoredListing).
      const scoreStart = Date.now();
      const batches: ExtractedListing[][] = [];
      for (let i = 0; i < scorable.length; i += ENRICH_BATCH_SIZE) {
        batches.push(scorable.slice(i, i + ENRICH_BATCH_SIZE));
      }

      console.log(`[admin-scraper] Found listings: ${scorable.length}`);

      // aggressiveAcquisition forces "fast" regardless of options.mode —
      // "AI enrichment disabled during acquisition" is a hard requirement
      // of this mode, not a preference (see AdminScraperOptions' own
      // comment on aggressiveAcquisition).
      const effectiveMode = options.aggressiveAcquisition ? "fast" : options.mode;
      const batchResults = await mapWithConcurrency(batches, ENRICH_BATCH_CONCURRENCY, (batch) =>
        enrichAndScoreBatch(batch, effectiveMode),
      );
      totalScoreMs += Date.now() - scoreStart;
      totalScored += scorable.length;

      const roundSurvivors = batchResults.flat();
      collected.push(...roundSurvivors);

      console.log(`[admin-scraper] After scoring — Scored listings: ${roundSurvivors.length}`);

      // STAGE 4: insert THIS round's survivors immediately — not deferred
      // until every round of the whole batch finishes (the old design).
      // Bulk Importer inserts per ~25-URL chunk for the same reason:
      // "Imported/minute" must reflect real, live progress instead of
      // reading 0 for an entire batch's duration and then jumping once at
      // the very end. "Scraped listings go live automatically unless
      // flagged" — flagListing() is a lightweight, synchronous safety net
      // that runs alongside, never instead of, the quality gate above; a
      // flagged listing still gets inserted (as 'flagged', not dropped) so
      // an admin can review it.
      const roundToInsert = roundSurvivors.map((survivor) => {
        const quality = qualityByUrl.get(survivor.product_url);
        const flag = flagListing({
          title: survivor.title,
          description: survivor.description,
          images: survivor.images,
          price: survivor.price,
          category: survivor.category,
        });

        if (flag.isSafe) {
          console.log("[IMPORT] Auto-live:", survivor.title, survivor.price);
        } else {
          console.log("[IMPORT] Flagged:", flag.reasons);
        }

        return {
          ...survivor,
          status: flag.isSafe ? ("active" as const) : ("flagged" as const),
          flag_reason: flag.isSafe ? null : (flag.reasons ?? []).join(", "),
          quality_score: quality?.score ?? null,
          quality_reason: quality?.reason ?? null,
          quality_breakdown: quality?.breakdown ?? null,
        };
      });

      const insertStart = Date.now();
      const insertFunnel = new PipelineFunnel();
      await reportStage("insert_start");

      const insertChunkSize = options.insertChunkSize ?? DB_INSERT_CHUNK_SIZE;
      for (let i = 0; i < roundToInsert.length; i += insertChunkSize) {
        const rawChunk = roundToInsert.slice(i, i + insertChunkSize);

        // Duplicate prevention — checked fresh, right before this chunk is
        // sent (see this file's own header comment on why this is separate
        // from the run-start seenUrls dedupe above). Product URL + image
        // URL + normalized title, against the live table and this same
        // batch.
        await reportStage("duplicate_detection_start");
        const chunk = await filterOutDuplicateCandidates(supabase, rawChunk, { duplicates: 0 });
        await reportStage("duplicate_detection_complete");
        const chunkUrls = new Set(chunk.map((row) => row.product_url));
        for (const row of rawChunk) {
          const isDuplicate = !chunkUrls.has(row.product_url);
          if (isDuplicate) totalDuplicates++;
          insertFunnel.recordDuplicateCheck(row.product_url, !isDuplicate, isDuplicate ? "duplicate" : undefined);
          if (isDuplicate) {
            console.log("[IMPORT PIPELINE]", {
              title: row.title,
              url: row.product_url,
              status: row.status,
              flagged: row.status === "flagged",
              inserted: false,
              error: "duplicate",
            });
          }
        }
        if (chunk.length === 0) continue;

        for (const row of chunk) {
          console.log("[admin-scraper] Inserting listing:", {
            title: row.title,
            imageCount: row.images.length,
            source: row.product_url,
          });
        }

        let { data, error } = await supabase.from("listings").insert(chunk).select("id");

        if (error && isMissingColumnError(error)) {
          console.warn(
            "[admin-scraper] source_* engagement columns, style/image scoring columns, or quality-score " +
              "columns not found on this database yet — retrying without them. Run the latest " +
              "supabase/schema.sql to enable Hot Item detection and quality/style/image scoring persistence.",
          );
          ({ data, error } = await supabase
            .from("listings")
            .insert(chunk.map((row) => withoutOptionalFields(row)))
            .select("id"));
        }

        if (!error) {
          for (const inserted of data ?? []) {
            console.log(`[admin-scraper] Listing inserted: ${inserted.id}`);
          }
          for (const row of chunk) {
            console.log("[IMPORT PIPELINE]", {
              title: row.title,
              url: row.product_url,
              status: row.status,
              flagged: row.status === "flagged",
              inserted: true,
              error: null,
            });
          }
          const insertedWithImages = (data ?? []).map((inserted, index) => ({
            id: inserted.id,
            imageUrl: chunk[index]?.image_url ?? null,
          }));
          await mapWithConcurrency(insertedWithImages, EMBEDDING_CONCURRENCY, (row) =>
            generateAndSaveListingEmbedding(row.id, row.imageUrl),
          );
          totalImported += data?.length ?? chunk.length;
          for (const row of chunk) insertFunnel.recordInsert(row.product_url, true);
          continue;
        }

        // A multi-row insert is one atomic statement — a SINGLE row
        // violating ANY constraint fails the WHOLE chunk, not just that
        // row (confirmed directly against this database). Falling back to
        // inserting this chunk's rows one at a time (still with the same
        // missing-column retry per row) means only the genuinely bad row
        // is lost, not every good one alongside it.
        console.error(`[admin-scraper] Database insert failed for the chunk — exact Supabase error:`, error);
        console.error(`[admin-scraper] Retrying its ${chunk.length} rows individually...`);

        for (const row of chunk) {
          console.log("[admin-scraper] Inserting listing:", {
            title: row.title,
            imageCount: row.images.length,
            source: row.product_url,
          });
          let single = await supabase.from("listings").insert(row).select("id").single();

          if (single.error && isMissingColumnError(single.error)) {
            single = await supabase.from("listings").insert(withoutOptionalFields(row)).select("id").single();
          }

          if (single.error) {
            console.error(
              `[admin-scraper] Database insert failed for "${row.product_url}" — exact Supabase error:`,
              single.error,
            );
            totalInsertFailed++;
            insertFunnel.recordInsert(row.product_url, false, single.error.message);
            console.log("[IMPORT PIPELINE]", {
              title: row.title,
              url: row.product_url,
              status: row.status,
              flagged: row.status === "flagged",
              inserted: false,
              error: single.error.message,
            });
            continue;
          }

          console.log(`[admin-scraper] Listing inserted: ${single.data.id}`);
          insertFunnel.recordInsert(row.product_url, true);
          console.log("[IMPORT PIPELINE]", {
            title: row.title,
            url: row.product_url,
            status: row.status,
            flagged: row.status === "flagged",
            inserted: true,
            error: null,
          });
          await generateAndSaveListingEmbedding(single.data.id, row.image_url ?? null);
          totalImported++;
        }
      }
      totalInsertMs += Date.now() - insertStart;
      insertFunnel.summarize(`round ${rounds} insert`);
      await reportStage("insert_complete");

      console.log(
        `[admin-scraper] Round ${rounds} done — elapsed ${elapsedSeconds()}s — ` +
          `scraped ${totalScraped} (${roundExtractionFailures} extraction failures this round), ` +
          `${totalFailedMinimalFilter} failed the quality gate, ` +
          `${totalScored} scored, ${totalImported}/${options.limit} imported so far, ` +
          `${options.limit - totalImported} still needed`,
      );

      // TEMPORARY diagnostic funnel summary — see src/lib/pipeline-debug.ts's
      // own header comment. Always printed (a short summary, not the
      // verbose per-candidate lines, which stay gated behind
      // DEBUG_IMPORT_PIPELINE=true) so "where did this round's candidates
      // actually go" is visible without needing the env flag at all.
      funnel.summarize(`round ${rounds}`);

      for (const [key, count] of Object.entries(funnel.getCounts())) {
        if (key === "extraction_ok") {
          totalExtractedSuccessfully += count;
        } else if (key.startsWith("extraction_failed:")) {
          const reason = key.slice("extraction_failed:".length);
          extractionFailuresByReason[reason] = (extractionFailuresByReason[reason] ?? 0) + count;
        }
      }

      if (onProgress) {
        try {
          await onProgress({
            status: "running",
            scrapedCount: totalScraped,
            scoredCount: totalScored,
            passedCount: collected.length,
            insertedCount: totalImported,
            errorCount: totalExtractionFailed + totalInsertFailed,
            duplicateCount: totalDuplicates,
            insertFailedCount: totalInsertFailed,
            qualityRejectedCount: totalFailedMinimalFilter,
            extractedSuccessfullyCount: totalExtractedSuccessfully,
            extractionFailuresByReason,
            lastProcessedUrl,
          });
        } catch (error) {
          // A progress-persistence failure (e.g. the job row's own update
          // call erroring) must never abort the scrape itself — this hook
          // is purely observational.
          console.error("[admin-scraper] onProgress callback failed:", error);
        }
      }

      // Circuit breaker 1: this round contributed nothing new — if that
      // keeps happening, the current filters/sources have realistically
      // been exhausted (every fresh URL discovery can still find is one
      // this run already tried and rejected).
      if (roundSurvivors.length === 0) {
        consecutiveLowYieldRounds++;
        if (consecutiveLowYieldRounds >= MAX_CONSECUTIVE_LOW_YIELD_ROUNDS) {
          console.warn(
            `[admin-scraper] ${consecutiveLowYieldRounds} consecutive rounds with zero new passes — ` +
              "stopping (current filters/sources appear exhausted).",
          );
          stopReason = "low_yield";
          break;
        }
      } else {
        consecutiveLowYieldRounds = 0;
      }

      // Circuit breaker 2: repeated failed requests — most of this
      // round's candidates failed to even extract (not "extracted fine
      // but didn't match style"), which points at the source sites
      // blocking/rate-limiting this run rather than a normal low pass
      // rate. attemptedThisRound (succeeded + failed extractions) replaces
      // the old sourceFilteredUrls.length now that the aggressive path
      // doesn't produce one fixed discovered-batch size up front.
      const attemptedThisRound = extracted.length + roundExtractionFailures;
      if (attemptedThisRound >= MIN_CANDIDATES_FOR_FAILURE_RATE_CHECK) {
        const failureRate = roundExtractionFailures / attemptedThisRound;
        if (failureRate >= HIGH_FAILURE_RATE_THRESHOLD) {
          consecutiveHighFailureRounds++;
          if (consecutiveHighFailureRounds >= MAX_CONSECUTIVE_HIGH_FAILURE_ROUNDS) {
            console.warn(
              `[admin-scraper] ${consecutiveHighFailureRounds} consecutive rounds with a ` +
                `${(failureRate * 100).toFixed(0)}% extraction failure rate — stopping ` +
                "(likely blocked/rate-limited rather than a normal low pass rate).",
            );
            stopReason = "high_failure_rate";
            break;
          }
        } else {
          consecutiveHighFailureRounds = 0;
        }
      }

      // Circuit breaker 3: see MAX_ROUNDS_BEFORE_PARTIAL_INSERT's own
      // comment — a slow-but-nonzero yield never trips breaker 1 above, so
      // without this a batch can run for up to MAX_ROUNDS before insert
      // ever gets a chance to run at all.
      if (collected.length > 0 && rounds >= MAX_ROUNDS_BEFORE_PARTIAL_INSERT) {
        console.warn(
          `[admin-scraper] ${rounds} rounds without reaching the batch target ` +
            `(${collected.length}/${options.limit} collected) — stopping early to insert what's been found ` +
            "so far rather than continuing to hunt.",
        );
        stopReason = "partial_batch_timeout";
        break;
      }
    }

    // "Everything scraped that didn't end up imported" — correct by
    // construction regardless of why (failed the quality gate, or an
    // extraction exception). Insert now happens per-round (see STAGE 4
    // inside the loop above), so this is a pure sum of already-final
    // running counters, not a separate deferred insert pass.
    const totalRejected = totalScraped - totalImported - totalDuplicates + totalExtractionFailed;

    if (totalImported >= options.limit) stopReason = "target_reached";

    console.log(
      `[admin-scraper] Inserted: ${totalImported} (insert failures: ${totalInsertFailed}) — ` +
        `${rounds} round(s), elapsed ${elapsedSeconds()}s, stop reason: ${stopReason}`,
    );

    // Performance logging (this task's own spec) — scraping (extraction)
    // and scoring (batch enrichment + image scoring) are summed across
    // every round; inserting is summed the same way now that it happens
    // per-round too (see STAGE 4 above). listings/minute uses wall-clock
    // elapsed time (not just these three stages) since that's what an
    // admin watching the job actually experiences — discovery/circuit-
    // breaker overhead is real time too, not "free."
    const elapsedMinutes = elapsed() / 60_000;
    const listingsPerMinute = elapsedMinutes > 0 ? totalImported / elapsedMinutes : 0;
    console.log(
      `[admin-scraper] Performance — scraping: ${(totalScrapeMs / 1000).toFixed(1)}s, ` +
        `scoring: ${(totalScoreMs / 1000).toFixed(1)}s, inserting: ${(totalInsertMs / 1000).toFixed(1)}s, ` +
        `${listingsPerMinute.toFixed(1)} listings/minute (${totalImported} in ${elapsedSeconds()}s)`,
    );

    const result: AdminScraperResult = {
      imported: totalImported,
      requested: options.limit,
      scraped: totalScraped,
      scored: totalScored,
      rejected: totalRejected,
      duplicates: totalDuplicates,
      insertFailed: totalInsertFailed,
      extractedSuccessfully: totalExtractedSuccessfully,
      extractionFailuresByReason,
      remainingNeeded: Math.max(0, options.limit - totalImported),
      elapsedMs: elapsed(),
      rounds,
      stopReason,
      queriesCompleted,
      pagesSearched,
      uniqueUrlsDiscovered,
    };

    // Shortfall is not itself an error — running out of real matching
    // inventory is a real, expected outcome, not a bug — but a bare
    // "imported: 12" when 100 were requested reads as broken with no way
    // to tell why. Spelling out where the rest went (and stopReason,
    // above) is what the admin actually needs to decide what to change
    // (broaden sources, or just accept it and re-run later for more —
    // there's no style/price/image-score threshold left to loosen; every
    // candidate that clears the quality gate gets imported regardless of
    // score).
    if (totalImported < options.limit) {
      console.warn(
        `[admin-scraper] Imported ${totalImported}/${options.limit} requested — scraped ${totalScraped}, ` +
          `${totalScored} scored, ${totalFailedMinimalFilter} failed the quality gate, ${totalInsertFailed} insert failures, ` +
          `stop reason: ${stopReason}, rounds: ${rounds}.`,
      );
    }

    return result;
  } catch (error) {
    // Defense in depth beyond the per-candidate try/catch above — this
    // catches anything unexpected in discovery/filtering/the DB round trip
    // itself (e.g. createAdminClient() throwing on a missing env var) so it
    // becomes a readable error instead of an uncaught rejection propagating
    // out through the Server Action boundary.
    console.error("[admin-scraper] runAdminScraper failed:", error);
    return {
      imported: 0,
      requested: options.limit,
      scraped: 0,
      scored: 0,
      rejected: 0,
      duplicates: 0,
      insertFailed: 0,
      extractedSuccessfully: 0,
      extractionFailuresByReason: {},
      remainingNeeded: options.limit,
      elapsedMs: elapsed(),
      rounds: 0,
      stopReason: "error",
      error: error instanceof Error ? error.message : "The scraper failed unexpectedly.",
      queriesCompleted: 0,
      pagesSearched: 0,
      uniqueUrlsDiscovered: 0,
    };
  }
}

// ---------------------------------------------------------------------------
// Continuous ingestion — repeats the single bounded batch above so one
// admin click keeps importing well past `options.limit`, "over time,"
// instead of stopping the moment one batch completes. See this file's own
// header comment for how this relates to runAdminScraper.
// ---------------------------------------------------------------------------

// Literal spec: "for (let round = 0; round < 20; round++)" — a generous
// but finite cap on how many batches one continuous run will attempt, so
// "continuous" still can't loop forever on its own even if every other
// safeguard below somehow failed to trip.
const CONTINUOUS_MAX_BATCHES = 20;

// Delay between batches — gives the source sites a breather between
// rounds of discovery/extraction rather than hammering them back-to-back
// forever, same spirit as this file's own HIGH_FAILURE_RATE_THRESHOLD
// circuit breaker.
const CONTINUOUS_ROUND_DELAY_MS = 5000;

// If this many consecutive BATCHES (not rounds within a batch — those are
// runAdminScraper's own MAX_CONSECUTIVE_HIGH_FAILURE_ROUNDS) come back
// with stopReason "error" (an uncaught exception, not just a low pass
// rate), something is structurally broken (bad credentials, the DB
// unreachable) rather than "still searching" — stop instead of retrying
// the same failure another 17 times.
const CONTINUOUS_MAX_CONSECUTIVE_FAILURES = 3;

// If this many consecutive batches import ZERO listings — for any reason
// (no new candidates, low yield, high failure rate, or hit max rounds
// before finding anything) — the current sources/filters have
// realistically run dry for now; stop rather than burning the rest of
// CONTINUOUS_MAX_BATCHES on empty batches.
const CONTINUOUS_MAX_CONSECUTIVE_EMPTY_BATCHES = 3;

export interface ContinuousAdminScraperOptions extends AdminScraperOptions {
  // Overrides CONTINUOUS_MAX_BATCHES above — optional, defaults to it.
  maxBatches?: number;
}

export type ContinuousStopReason =
  | "max_batches_reached"
  | "consecutive_failures"
  | "no_new_listings";

export interface ContinuousAdminScraperResult {
  totalImported: number;
  // Every individual batch's own result, in order — lets a caller inspect
  // exactly how each round went (imported/stopReason/error) rather than
  // only the aggregate.
  batches: AdminScraperResult[];
  batchesRun: number;
  stopReason: ContinuousStopReason;
  elapsedMs: number;
}

/**
 * Repeats runAdminScraper — the single bounded batch defined above — up
 * to `options.maxBatches` (default CONTINUOUS_MAX_BATCHES) times, waiting
 * CONTINUOUS_ROUND_DELAY_MS between each, so one admin click can keep
 * importing far more than one batch's own `options.limit` over an
 * extended period. `options.limit` is passed to EVERY batch unchanged —
 * each round asks for that many qualified listings again, not a shrinking
 * remainder of one grand total (this file's own spec: "respect
 * requested_count PER ROUND, not total").
 *
 * Does not change what a batch itself does: no scoring-logic change, no
 * listing merging — every listing inserted by every batch is still its
 * own independent row, same as a single runAdminScraper call. This
 * function only decides whether/when to run another batch.
 *
 * onProgress, if provided, is called with a RUNNING TOTAL across every
 * batch so far (each batch's own onProgress reports counts scoped to
 * just that batch, starting back at 0) — otherwise a caller watching
 * progress would see the numbers reset every ~20-100s as each new batch
 * starts.
 */
export async function runContinuousAdminScraper(
  options: ContinuousAdminScraperOptions,
  onProgress?: (progress: AdminScraperProgress) => void | Promise<void>,
): Promise<ContinuousAdminScraperResult> {
  const startedAt = Date.now();
  const maxBatches = options.maxBatches ?? CONTINUOUS_MAX_BATCHES;

  const batches: AdminScraperResult[] = [];
  const cumulative = { scraped: 0, scored: 0, passed: 0, inserted: 0, error: 0 };
  let consecutiveFailures = 0;
  let consecutiveEmptyBatches = 0;
  let stopReason: ContinuousStopReason = "max_batches_reached";

  for (let round = 0; round < maxBatches; round++) {
    console.log(`[admin-scraper] Starting round ${round + 1}`);

    const batchBaseline = { ...cumulative };
    let lastBatchProgress: AdminScraperProgress = {
      status: "running",
      scrapedCount: 0,
      scoredCount: 0,
      passedCount: 0,
      insertedCount: 0,
      errorCount: 0,
      duplicateCount: 0,
      insertFailedCount: 0,
      qualityRejectedCount: 0,
      extractedSuccessfullyCount: 0,
      extractionFailuresByReason: {},
      lastProcessedUrl: null,
    };

    const result = await runAdminScraper(options, async (progress) => {
      lastBatchProgress = progress;
      if (!onProgress) return;
      await onProgress({
        status: "running",
        scrapedCount: batchBaseline.scraped + progress.scrapedCount,
        scoredCount: batchBaseline.scored + progress.scoredCount,
        passedCount: batchBaseline.passed + progress.passedCount,
        insertedCount: batchBaseline.inserted + progress.insertedCount,
        errorCount: batchBaseline.error + progress.errorCount,
        duplicateCount: progress.duplicateCount,
        insertFailedCount: progress.insertFailedCount,
        qualityRejectedCount: progress.qualityRejectedCount,
        extractedSuccessfullyCount: progress.extractedSuccessfullyCount,
        extractionFailuresByReason: progress.extractionFailuresByReason,
        lastProcessedUrl: progress.lastProcessedUrl,
      });
    });

    batches.push(result);
    cumulative.scraped = batchBaseline.scraped + lastBatchProgress.scrapedCount;
    cumulative.scored = batchBaseline.scored + lastBatchProgress.scoredCount;
    cumulative.passed = batchBaseline.passed + lastBatchProgress.passedCount;
    cumulative.inserted = batchBaseline.inserted + lastBatchProgress.insertedCount;
    cumulative.error = batchBaseline.error + lastBatchProgress.errorCount;

    console.log(`[admin-scraper] Round complete: inserted ${result.imported} listings`);

    // Stop safely 1: too many consecutive batches failing outright.
    if (result.stopReason === "error") {
      consecutiveFailures++;
      if (consecutiveFailures >= CONTINUOUS_MAX_CONSECUTIVE_FAILURES) {
        console.warn(
          `[admin-scraper] ${consecutiveFailures} consecutive failed rounds — stopping continuous ingestion.`,
        );
        stopReason = "consecutive_failures";
        break;
      }
    } else {
      consecutiveFailures = 0;
    }

    // Stop safely 2: too many consecutive batches with no new listings.
    if (result.imported === 0) {
      consecutiveEmptyBatches++;
      if (consecutiveEmptyBatches >= CONTINUOUS_MAX_CONSECUTIVE_EMPTY_BATCHES) {
        console.warn(
          `[admin-scraper] ${consecutiveEmptyBatches} consecutive rounds with no new listings — ` +
            "stopping continuous ingestion.",
        );
        stopReason = "no_new_listings";
        break;
      }
    } else {
      consecutiveEmptyBatches = 0;
    }

    if (round < maxBatches - 1) {
      await new Promise((resolve) => setTimeout(resolve, CONTINUOUS_ROUND_DELAY_MS));
    }
  }

  console.log(
    `[admin-scraper] Continuous ingestion done — ${batches.length} round(s), ` +
      `${cumulative.inserted} total imported, stop reason: ${stopReason}`,
  );

  return {
    totalImported: cumulative.inserted,
    batches,
    batchesRun: batches.length,
    stopReason,
    elapsedMs: Date.now() - startedAt,
  };
}

// ---------------------------------------------------------------------------
// Large-scale continuous ingestion — "build and maintain a 50,000+ listing
// inventory over time" (src/lib/scraper-config.ts's TARGET_INVENTORY_SIZE).
// Distinct from runContinuousAdminScraper above (which the existing
// Continuous Import admin UI card still uses, completely unchanged): that
// function stops after a fixed number of batches; this one's real stop
// condition is "the live `listings` table's own total count reached the
// target" — maxBatches here plays the same safety-ceiling role MAX_ROUNDS
// already plays inside one runAdminScraper batch, not the primary reason
// to stop.
//
// RESILIENCE: a batch that comes back with stopReason 'error' is retried
// up to MAX_BATCH_RETRIES times (with a cooldown between attempts) before
// being recorded as a failed batch and moving on to the NEXT one — a
// single bad batch never kills the whole run. Only
// LARGE_SCALE_MAX_CONSECUTIVE_BATCH_FAILURES fully-failed batches in a row
// (every retry exhausted, every time) stops the run outright, same
// "structurally broken, not just still searching" reasoning
// runContinuousAdminScraper's own CONTINUOUS_MAX_CONSECUTIVE_FAILURES uses.
//
// PAUSE: stays completely out of scraper_jobs — this file has no DB-job-
// table coupling anywhere else, so pause support is a plain `isPaused()`
// hook the caller implements (see src/app/api/admin-scraper/run/route.ts),
// checked before every batch. There is no way to interrupt a batch already
// in flight; pause takes effect at the next batch boundary. "Resume"
// doesn't reach into this same paused execution (there's nothing left to
// reach into once the request that started it has returned) — it starts a
// NEW run against the same job row, seeded from `options.seenUrls` so it
// doesn't immediately re-discover/re-try candidates the paused run already
// tried.
// ---------------------------------------------------------------------------

export interface LargeScaleAdminScraperOptions extends AdminScraperFilterOptions {
  allowedSources: string[];
  targetInventorySize?: number;
  batchSize?: number;
  maxBatches?: number;
  mode?: ScraperMode;
  // Seeded from a previous, paused run's own checkpoint — see this
  // section's own header comment on how "resume" actually works.
  seenUrls?: string[];
  // OVERNIGHT_MODE (scraper-config.ts) — a run-CONTINUATION setting, not
  // an AI-depth one (that's `mode` above). When true: maxBatches defaults
  // to OVERNIGHT_MAX_BATCHES instead of LARGE_SCALE_MAX_BATCHES (a much
  // higher safety ceiling, not "no limit" — see that constant's own
  // comment), and discovery-scaling's maxDiscoveryPagesPerQuery widens.
  // Every existing stop condition (target reached, paused, too many
  // consecutive batch failures) is completely unchanged — overnight mode
  // only changes how long the run is ALLOWED to keep going, never how it
  // decides to stop early.
  runMode?: typeof OVERNIGHT_MODE;
  maxDiscoveryPagesPerQuery?: number;
  // OVERNIGHT_AGGRESSIVE (scraper-config.ts) — orthogonal to runMode (that's
  // about how LONG a run keeps going; this is about HOW each batch
  // acquires listings). Threaded straight into every batch's
  // AdminScraperOptions.aggressiveAcquisition — see that field's own
  // comment for exactly what it changes.
  aggressiveAcquisition?: boolean;
}

export type LargeScaleStopReason = "target_reached" | "max_batches_reached" | "consecutive_failures" | "paused";

export interface LargeScaleAdminScraperResult {
  totalImported: number;
  // "Valid" == actually written to Supabase — the same set totalImported
  // counts (kept as its own field because the dashboard's own spec asks
  // for it by that name). Deliberately NOT "cleared the quality gate"
  // (AdminScraperResult.scored): a candidate can score well and still be
  // lost to a duplicate or a genuine DB insert error afterward, and this
  // field must not claim that as "valid" when it never actually landed.
  totalValid: number;
  totalDuplicates: number;
  totalInsertFailed: number;
  totalRejected: number;
  totalScraped: number;
  // Cumulative across every batch — see AdminScraperResult.extractedSuccessfully.
  totalExtractedSuccessfully: number;
  // Cumulative across every batch, merged by reason — see
  // AdminScraperResult.extractionFailuresByReason.
  extractionFailuresByReason: Record<string, number>;
  batchesRun: number;
  stopReason: LargeScaleStopReason;
  elapsedMs: number;
  seenUrls: string[];
  // Discovery-scaling dashboard numbers, cumulative across every batch of
  // this run — see AdminScraperResult's own comment on these same fields.
  totalQueriesCompleted: number;
  totalPagesSearched: number;
  totalUniqueUrlsDiscovered: number;
}

export interface LargeScaleProgress {
  currentBatch: number;
  totalBatches: number;
  currentInventoryCount: number;
  targetInventorySize: number;
  // How many candidates have actually been fetched/extracted so far —
  // absent from this interface until now because progress was only ever
  // reported once a whole batch finished, at which point "scraped" wasn't
  // needed for anything the dashboard showed. Interim reporting (below)
  // needs it so "is this thing actually moving" has a real number to point
  // to within the first round of a long batch, not just at the very end.
  scrapedCount: number;
  insertedCount: number;
  validCount: number;
  duplicateCount: number;
  // New (dashboard requirements: "Database insert failures") — a
  // duplicate is a correctly-skipped candidate, not a failure; this is
  // specifically rows that scored well, weren't duplicates, and still
  // failed the actual Supabase insert (a real infrastructure problem worth
  // its own number, not lumped into rejectedCount below).
  insertFailedCount: number;
  // Dashboard requirement "URLs extracted successfully" / "extraction
  // failures by reason" — see AdminScraperResult's own comments on these
  // same two fields; accumulated the same way insertFailedCount is.
  extractedSuccessfullyCount: number;
  extractionFailuresByReason: Record<string, number>;
  rejectedCount: number;
  failedBatchCount: number;
  // Discovery-scaling dashboard numbers (src/lib/inventory/
  // scaled-discovery.ts), cumulative across the whole run so far.
  queriesCompleted: number;
  pagesSearched: number;
  uniqueUrlsDiscovered: number;
  // Discovery redesign requirement 6 — new throughput/health dashboard
  // fields. All computed live, not persisted anywhere new until
  // scraper-jobs.ts's own tiered payload picks them up (see that file).
  urlsDiscoveredPerMinute: number;
  // Configured worker CEILING (AGGRESSIVE_DISCOVERY_PLATFORMS.length *
  // OVERNIGHT_AGGRESSIVE_CONFIG.discoveryWorkers when aggressive, else 0)
  // — not a live thread count (mapWithConcurrency doesn't expose one) —
  // named accordingly to avoid implying more precision than this has.
  activeDiscoveryWorkers: number;
  // scraper_url_queue's own pending-row count — how much discovered work
  // extraction hasn't caught up to yet.
  extractionQueueDepth: number;
  // Configured extraction-worker CEILING (dashboard requirement: "Current
  // workers active") — same "not a live thread count, named accordingly"
  // caveat as activeDiscoveryWorkers above: mapWithConcurrency doesn't
  // expose how many closures are actually in flight right now, only the
  // bound they're capped at.
  activeExtractionWorkers: number;
  // Per-platform circuit-breaker read (src/lib/inventory/marketplace-health.ts).
  marketplaceHealth: MarketplaceHealth[];
}

const LARGE_SCALE_MAX_CONSECUTIVE_BATCH_FAILURES = 3;

// Minimum time between INTERIM progress writes within a single batch (see
// the attempt loop below) — batch-boundary writes (batch succeeded/failed)
// are separate and always go through regardless of this. Keeps a batch
// with many fast rounds from hammering scraper_jobs with a write every few
// seconds, while still being frequent enough that "activity within the
// first few minutes" (this feature's own requirement) is easily met.
const INTERIM_PROGRESS_MIN_INTERVAL_MS = 15_000;

// "AI enrichment must happen AFTER insertion through a background queue"
// — the Part 3/6 inventory-indexer/enrichment-queue pipeline already
// exists and already finds every un-enriched listing itself
// (indexNewListings queries for visual_analysis IS NULL, so it doesn't
// need to be told which listings were just inserted); it just had nothing
// triggering it automatically during a large-scale run. Fired here,
// fire-and-forget, after every successful batch — never awaited, so it
// can never block acquisition. Module-level guard (not a job-scoped one)
// since only ONE large-scale run is ever active at a time (see
// getActiveLargeScaleJob's own concurrency guard) — prevents overlapping
// indexer rounds from piling up if batches complete faster than a round
// of indexing does.
let indexerRunInFlight = false;

function triggerBackgroundEnrichment(): void {
  if (indexerRunInFlight) return;
  indexerRunInFlight = true;

  runInventoryIndexer({})
    .then((result) => {
      console.log("[admin-scraper] Background inventory-indexing round complete:", result);
    })
    .catch((error) => {
      console.error("[admin-scraper] Background inventory-indexing round failed:", error);
    })
    .finally(() => {
      indexerRunInFlight = false;
    });
}

async function getListingsInventoryCount(supabase: ReturnType<typeof createAdminClient<ListingsDatabase>>): Promise<number> {
  const { count, error } = await supabase.from("listings").select("id", { count: "exact", head: true });
  if (error) {
    console.error("[admin-scraper] Failed to read current inventory count (treating as 0 for this check):", error);
    return 0;
  }
  return count ?? 0;
}

// Reliability watchdog — races ONE batch attempt against
// PER_BATCH_MAX_RUNTIME_MS so a hung attempt (no error, no progress, just
// never resolving — the exact failure mode found live: batch 20/86 frozen
// for 40+ minutes with status still 'running') gets treated as a failed
// attempt instead of blocking this loop forever. This does NOT cancel the
// underlying runAdminScraper() call — there's no AbortController threaded
// through discovery/extraction to make that safe, and adding one would be
// a real change to the scraper itself, not a reliability wrapper around
// it. The abandoned call is simply left running in the background and its
// eventual result (if any) is discarded; existing retry/consecutive-
// failure handling takes it from here exactly as if runAdminScraper had
// itself returned stopReason: "error".
function withBatchWatchdog(
  work: Promise<AdminScraperResult>,
  context: { batch: number; attempt: number; requested: number },
): Promise<AdminScraperResult> {
  let timer: ReturnType<typeof setTimeout>;
  const watchdog = new Promise<AdminScraperResult>((resolve) => {
    timer = setTimeout(() => {
      console.error(
        `[watchdog] Batch ${context.batch} attempt ${context.attempt} exceeded ` +
          `${PER_BATCH_MAX_RUNTIME_MS}ms with no result — marking this attempt failed so retry/next-batch ` +
          "logic can continue. The underlying scrape call is left running in the background (it cannot be " +
          "cancelled) and its eventual result, if any, is discarded.",
      );
      // Fire-and-forget (not awaited) — forcing this attempt's browsers
      // closed must not delay resolve() below, which is what actually lets
      // the retry loop proceed; see forceCloseAllTrackedBrowsers's own
      // comment on why this prevents orphaned Chromium processes from a
      // batch abandoned by this exact watchdog.
      forceCloseAllTrackedBrowsers(
        `batch ${context.batch} attempt ${context.attempt} exceeded ${PER_BATCH_MAX_RUNTIME_MS}ms`,
      ).catch((error) => {
        console.error("[watchdog] Forced browser cleanup itself failed:", error);
      });
      resolve({
        imported: 0,
        requested: context.requested,
        scraped: 0,
        scored: 0,
        rejected: 0,
        duplicates: 0,
        insertFailed: 0,
        extractedSuccessfully: 0,
        extractionFailuresByReason: {},
        remainingNeeded: context.requested,
        elapsedMs: PER_BATCH_MAX_RUNTIME_MS,
        rounds: 0,
        stopReason: "error",
        error: `Batch watchdog: exceeded ${PER_BATCH_MAX_RUNTIME_MS}ms without completing.`,
        queriesCompleted: 0,
        pagesSearched: 0,
        uniqueUrlsDiscovered: 0,
      });
    }, PER_BATCH_MAX_RUNTIME_MS);
  });

  return Promise.race([work.finally(() => clearTimeout(timer)), watchdog]);
}

// Merges two "reason -> count" maps (extraction failures by reason) —
// used both for interim reporting (this run's own accumulated total plus
// whatever the in-flight batch has seen so far) and for rolling one
// batch's final counts into the run-wide total once it completes.
function mergeCounts(a: Record<string, number>, b: Record<string, number>): Record<string, number> {
  const merged = { ...a };
  for (const [key, count] of Object.entries(b)) {
    merged[key] = (merged[key] ?? 0) + count;
  }
  return merged;
}

export async function runLargeScaleAdminScraper(
  options: LargeScaleAdminScraperOptions,
  hooks: {
    onProgress?: (progress: LargeScaleProgress) => void | Promise<void>;
    // Checked before every batch — see this section's own header comment.
    // No hook = never paused (matches every existing caller's behavior).
    isPaused?: () => Promise<boolean>;
  } = {},
): Promise<LargeScaleAdminScraperResult> {
  // TEMPORARY diagnostic — "Inventory Growth never reaches batch 1" investigation.
  console.log("[diag] 4b. runLargeScaleAdminScraper() started", { options });
  // Resource-exhaustion incident fix — warns (never blocks) when the
  // machine already looks overloaded before a single browser is launched,
  // so an admin watching the logs has a chance to notice before the first
  // batch reproduces the same 130s+ page.goto() timeouts that caused every
  // marketplace to look "down" when the real cause was local load.
  checkStartupResources();
  const startedAt = Date.now();
  const isOvernight = options.runMode === OVERNIGHT_MODE;
  const targetInventorySize = options.targetInventorySize ?? TARGET_INVENTORY_SIZE;
  const batchSize = options.batchSize ?? BATCH_SIZE;
  // OVERNIGHT_MODE requirement: "does not stop after fixed batches" — a
  // much higher safety ceiling than the ordinary LARGE_SCALE_MAX_BATCHES,
  // not literally unbounded (see OVERNIGHT_MAX_BATCHES's own comment).
  // Every real stop condition below (target reached, paused, too many
  // consecutive failures) is completely unaffected by this.
  const maxBatches = options.maxBatches ?? (isOvernight ? OVERNIGHT_MAX_BATCHES : LARGE_SCALE_MAX_BATCHES);
  const mode = options.mode ?? DEFAULT_SCRAPER_MODE;
  const maxDiscoveryPagesPerQuery = options.maxDiscoveryPagesPerQuery ?? OVERNIGHT_MAX_PAGES_PER_QUERY;

  const supabase = createAdminClient<ListingsDatabase>();
  const seenUrls = new Set(options.seenUrls ?? []);

  let totalImported = 0;
  let totalValid = 0;
  let totalDuplicates = 0;
  let totalInsertFailed = 0;
  let totalRejected = 0;
  let totalScraped = 0;
  let totalExtractedSuccessfully = 0;
  const extractionFailuresByReason: Record<string, number> = {};
  let batchesRun = 0;
  let consecutiveBatchFailures = 0;
  let stopReason: LargeScaleStopReason = "max_batches_reached";
  // Discovery-scaling dashboard numbers, cumulative across every batch.
  let totalQueriesCompleted = 0;
  let totalPagesSearched = 0;
  let totalUniqueUrlsDiscovered = 0;

  // Interim progress reporting (within a single long batch) — throttled so
  // a batch with many fast rounds doesn't hammer the DB with writes; the
  // FIRST call is always let through (lastInterimWriteAt starts at 0), so
  // the dashboard gets its first real signal as soon as round 1 finishes,
  // not only once the whole (possibly very long) batch completes.
  let lastInterimWriteAt = 0;

  // Discovery redesign requirement 6 — best-effort dashboard metrics,
  // recomputed fresh at every onProgress call rather than tracked
  // incrementally (all three inputs are already cheap: a count against
  // `uniqueUrlsDiscovered`'s own running total, one DB count query, and an
  // in-memory read).
  async function computeDashboardMetrics(): Promise<{
    urlsDiscoveredPerMinute: number;
    activeDiscoveryWorkers: number;
    extractionQueueDepth: number;
    activeExtractionWorkers: number;
    marketplaceHealth: MarketplaceHealth[];
  }> {
    const elapsedMinutes = Math.max((Date.now() - startedAt) / 60_000, 1 / 60);
    const queueStats = await getUrlQueueStats().catch(() => ({ pending: 0, claimed: 0, extracted: 0, failed: 0 }));

    return {
      urlsDiscoveredPerMinute: totalUniqueUrlsDiscovered / elapsedMinutes,
      activeDiscoveryWorkers: options.aggressiveAcquisition
        ? AGGRESSIVE_DISCOVERY_PLATFORMS.length * OVERNIGHT_AGGRESSIVE_CONFIG.discoveryWorkers
        : 0,
      extractionQueueDepth: queueStats.pending,
      // Configured concurrency ceiling for whichever mode this run is
      // actually using — same two constants runQueueDrivenExtraction's own
      // callers (runAggressiveRound/runNonAggressiveStreamingRound) pass
      // as batchSize/concurrency.
      activeExtractionWorkers: options.aggressiveAcquisition
        ? OVERNIGHT_AGGRESSIVE_CONFIG.extractionWorkers
        : MAX_EXTRACTION_CONCURRENCY,
      marketplaceHealth: getAllMarketplaceHealth(),
    };
  }

  for (let batch = 1; batch <= maxBatches; batch++) {
    // TEMPORARY diagnostic — "Inventory Growth never reaches batch 1" investigation.
    console.log(`[diag] 5. batch loop iteration begins — batch ${batch}/${maxBatches}`);
    const inventoryNow = await getListingsInventoryCount(supabase);
    if (inventoryNow >= targetInventorySize) {
      console.log(`[admin-scraper] Large-scale target reached — inventory ${inventoryNow}/${targetInventorySize}.`);
      stopReason = "target_reached";
      break;
    }

    if (hooks.isPaused && (await hooks.isPaused())) {
      console.log(`[admin-scraper] Large-scale run paused before batch ${batch} — stopping cleanly.`);
      stopReason = "paused";
      break;
    }

    batchesRun = batch;
    const thisBatchLimit = Math.min(batchSize, targetInventorySize - inventoryNow);

    const batchOptions: AdminScraperOptions = {
      maxPrice: options.maxPrice,
      minStyleScore: options.minStyleScore,
      minImageScore: options.minImageScore,
      allowedSources: options.allowedSources,
      brandMode: options.brandMode,
      categoryFilter: options.categoryFilter,
      limit: thisBatchLimit,
      mode,
      // "Never insert 50,000 rows at once — 500 rows per insert" (this
      // feature's own spec): batchSize IS that insert chunk size here,
      // still going through the same chunk-then-per-row-on-failure
      // fallback every other caller's smaller DB_INSERT_CHUNK_SIZE does.
      insertChunkSize: batchSize,
      // Every large-scale batch uses discovery-scaling (query-generator +
      // discovery-history + parallel per-platform crawl) — the actual fix
      // for the climbing duplicate rate, not something reserved only for
      // overnightMode: a same-day multi-batch run hits the exact same
      // "fixed term rotation ran dry" problem well before an overnight
      // run's much larger batch count would.
      useScaledDiscovery: true,
      maxDiscoveryPagesPerQuery,
      aggressiveAcquisition: options.aggressiveAcquisition,
    };

    let result: AdminScraperResult | null = null;
    let lastError: string | undefined;

    for (let attempt = 1; attempt <= MAX_BATCH_RETRIES; attempt++) {
      console.log(
        `[admin-scraper] Large-scale batch ${batch}/${maxBatches}, attempt ${attempt}/${MAX_BATCH_RETRIES} — ` +
          `inventory ${inventoryNow}/${targetInventorySize}, asking for ${thisBatchLimit}`,
      );

      const attemptResult = await withBatchWatchdog(
        runAdminScraper(batchOptions, (progress) => {
          if (progress.lastProcessedUrl) seenUrls.add(progress.lastProcessedUrl);

          // Interim progress — runAdminScraper's own onProgress already fires
          // after every round AND after the insert phase (see its own header
          // comment); forwarding those into hooks.onProgress here is what
          // makes a long batch's progress visible WHILE it's still running,
          // instead of only once the whole batch returns. Approximate by
          // design (duplicate_count in particular can't be known mid-batch —
          // filterOutDuplicateCandidates only runs during the insert phase —
          // so it stays at this run's last known value until this attempt's
          // batch fully completes and the authoritative post-batch write
          // below runs); good enough for "is this thing actually moving,"
          // which is all an interim update needs to answer.
          if (hooks.onProgress) {
            const now = Date.now();
            if (now - lastInterimWriteAt >= INTERIM_PROGRESS_MIN_INTERVAL_MS) {
              lastInterimWriteAt = now;
              // Dashboard-metrics fix (Inventory Growth/Bulk Importer
              // architecture parity) — "Valid" now means the same thing
              // Bulk Importer's own dashboard would mean by it: rows
              // actually written to Supabase, not "passed the quality gate
              // before dedup/insert even ran" (the old progress.scoredCount
              // mapping — which meant a run that scored fine but then lost
              // everything to a duplicate or a DB error still showed as
              // fully "Valid"). duplicateCount/qualityRejectedCount are now
              // genuinely live too (progress.* is real per-round data since
              // insert happens every round — see runAdminScraper's own
              // STAGE 4), not "this run's last known value" the way they
              // used to be before insert was deferred to batch-end.
              const rejectedSoFar = totalRejected + progress.qualityRejectedCount;
              computeDashboardMetrics()
                .then((metrics) =>
                  hooks.onProgress!({
                    currentBatch: batch,
                    totalBatches: maxBatches,
                    currentInventoryCount: inventoryNow,
                    targetInventorySize,
                    scrapedCount: totalScraped + progress.scrapedCount,
                    insertedCount: totalImported + progress.insertedCount,
                    validCount: totalValid + progress.insertedCount,
                    duplicateCount: totalDuplicates + progress.duplicateCount,
                    insertFailedCount: progress.insertFailedCount,
                    extractedSuccessfullyCount: totalExtractedSuccessfully + progress.extractedSuccessfullyCount,
                    extractionFailuresByReason: mergeCounts(extractionFailuresByReason, progress.extractionFailuresByReason),
                    rejectedCount: rejectedSoFar,
                    failedBatchCount: consecutiveBatchFailures,
                    queriesCompleted: totalQueriesCompleted,
                    pagesSearched: totalPagesSearched,
                    uniqueUrlsDiscovered: totalUniqueUrlsDiscovered,
                    ...metrics,
                  }),
                )
                .catch((error) => {
                  console.error("[admin-scraper] Large-scale interim onProgress callback failed:", error);
                });
            }
          }
        }),
        { batch, attempt, requested: thisBatchLimit },
      );

      if (attemptResult.stopReason !== "error") {
        result = attemptResult;
        break;
      }

      lastError = attemptResult.error;
      console.error(`[admin-scraper] Large-scale batch ${batch} attempt ${attempt} failed:`, lastError);

      if (attempt < MAX_BATCH_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, LARGE_SCALE_BATCH_COOLDOWN_MS));
      }
    }

    if (!result) {
      // Every retry exhausted for THIS batch — log it, count it, and move
      // on to the NEXT batch rather than aborting the whole run (this
      // feature's own explicit resilience requirement).
      consecutiveBatchFailures++;
      console.error(
        `[admin-scraper] Batch ${batch} failed after ${MAX_BATCH_RETRIES} attempts — moving on. Last error: ${lastError}`,
      );

      if (hooks.onProgress) {
        lastInterimWriteAt = Date.now();
        try {
          await hooks.onProgress({
            currentBatch: batch,
            totalBatches: maxBatches,
            currentInventoryCount: inventoryNow,
            targetInventorySize,
            scrapedCount: totalScraped,
            insertedCount: totalImported,
            validCount: totalValid,
            duplicateCount: totalDuplicates,
            insertFailedCount: totalInsertFailed,
            extractedSuccessfullyCount: totalExtractedSuccessfully,
            extractionFailuresByReason,
            rejectedCount: totalRejected,
            failedBatchCount: consecutiveBatchFailures,
            queriesCompleted: totalQueriesCompleted,
            pagesSearched: totalPagesSearched,
            uniqueUrlsDiscovered: totalUniqueUrlsDiscovered,
            ...(await computeDashboardMetrics()),
          });
        } catch (error) {
          console.error("[admin-scraper] Large-scale onProgress callback failed:", error);
        }
      }

      if (consecutiveBatchFailures >= LARGE_SCALE_MAX_CONSECUTIVE_BATCH_FAILURES) {
        console.error(
          `[admin-scraper] ${consecutiveBatchFailures} consecutive fully-failed batches — stopping large-scale run.`,
        );
        stopReason = "consecutive_failures";
        break;
      }

      if (batch < maxBatches) {
        await new Promise((resolve) => setTimeout(resolve, LARGE_SCALE_BATCH_COOLDOWN_MS));
      }
      continue;
    }

    consecutiveBatchFailures = 0;
    totalImported += result.imported;
    // Dashboard-metrics fix (Inventory Growth/Bulk Importer architecture
    // parity) — "Valid" is real inserted rows, not "cleared the quality
    // gate before dedup/insert even ran" (result.scored). A run that
    // scored fine but lost everything to a duplicate or a DB error used to
    // still read as fully "Valid" under the old mapping.
    totalValid += result.imported;
    totalDuplicates += result.duplicates;
    totalInsertFailed += result.insertFailed;
    totalRejected += result.rejected;
    totalScraped += result.scraped;
    totalExtractedSuccessfully += result.extractedSuccessfully;
    for (const [key, count] of Object.entries(result.extractionFailuresByReason)) {
      extractionFailuresByReason[key] = (extractionFailuresByReason[key] ?? 0) + count;
    }
    totalQueriesCompleted += result.queriesCompleted;
    totalPagesSearched += result.pagesSearched;
    totalUniqueUrlsDiscovered += result.uniqueUrlsDiscovered;

    if (result.imported > 0) triggerBackgroundEnrichment();

    console.log(
      `[admin-scraper] Large-scale batch ${batch}/${maxBatches} done — imported ${result.imported}, ` +
        `duplicates ${result.duplicates}, rejected ${result.rejected} — running totals: ` +
        `imported ${totalImported}, inventory ~${inventoryNow + result.imported}/${targetInventorySize}`,
    );

    if (hooks.onProgress) {
      // This is the authoritative, end-of-batch write — always goes
      // through (not throttled), same as before. lastInterimWriteAt is
      // bumped too so an interim write doesn't immediately re-fire right
      // after this one for the next batch's first round.
      lastInterimWriteAt = Date.now();
      try {
        await hooks.onProgress({
          currentBatch: batch,
          totalBatches: maxBatches,
          currentInventoryCount: inventoryNow + result.imported,
          targetInventorySize,
          scrapedCount: totalScraped,
          insertedCount: totalImported,
          validCount: totalValid,
          duplicateCount: totalDuplicates,
          insertFailedCount: totalInsertFailed,
          extractedSuccessfullyCount: totalExtractedSuccessfully,
          extractionFailuresByReason,
          rejectedCount: totalRejected,
          failedBatchCount: 0,
          queriesCompleted: totalQueriesCompleted,
          pagesSearched: totalPagesSearched,
          uniqueUrlsDiscovered: totalUniqueUrlsDiscovered,
          ...(await computeDashboardMetrics()),
        });
      } catch (error) {
        console.error("[admin-scraper] Large-scale onProgress callback failed:", error);
      }
    }

    if (batch < maxBatches) {
      await new Promise((resolve) => setTimeout(resolve, LARGE_SCALE_BATCH_COOLDOWN_MS));
    }
  }

  console.log(
    `[admin-scraper] Large-scale ingestion done — ${batchesRun} batch(es), ${totalImported} imported this run, ` +
      `stop reason: ${stopReason}`,
  );

  return {
    totalImported,
    totalValid,
    totalDuplicates,
    totalInsertFailed,
    totalRejected,
    totalScraped,
    totalExtractedSuccessfully,
    extractionFailuresByReason,
    batchesRun,
    stopReason,
    elapsedMs: Date.now() - startedAt,
    seenUrls: Array.from(seenUrls),
    totalQueriesCompleted,
    totalPagesSearched,
    totalUniqueUrlsDiscovered,
  };
}
