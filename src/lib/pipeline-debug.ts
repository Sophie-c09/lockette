// TEMPORARY diagnostic infrastructure for the continuous inventory
// importer investigation ("Processed 105/50, Found 0, Inserted 0, Errors
// 0"). Purely additive logging/counting — no behavior change, no
// filters loosened, nothing rejected/approved differently than before.
// Remove this file (and its call sites in admin-scraper.ts/
// listing-extraction.ts) once the funnel bottleneck is confirmed fixed.
//
// DEBUG_IMPORT_PIPELINE=true enables the verbose per-candidate structured
// log line + writes every rejected/failed candidate to a JSON file at the
// end of a run; when unset/false, only the per-batch funnel summary
// prints (still useful, much quieter).
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function isDebugImportPipelineEnabled(): boolean {
  return process.env.DEBUG_IMPORT_PIPELINE === "true";
}

export type PipelineStage =
  | "discovery"
  | "extraction"
  | "minimal_quality_filter"
  | "duplicate_check"
  | "ai_enrichment"
  | "insert";

export interface PipelineEvent {
  url: string;
  marketplace: string;
  stage: PipelineStage;
  success: boolean;
  failure_reason?: string;
  // Added for the extraction-throughput work's per-failure tracking
  // requirement ({ url, marketplace, errorType, timestamp }) — failure_reason
  // above already serves as errorType; this was the one missing field.
  // Stamped by record() below, not by callers, so every event gets one
  // consistently.
  timestamp: number;
}

/**
 * One structured line per candidate per stage — only printed when
 * DEBUG_IMPORT_PIPELINE=true (Part 8's own spec: verbose logging is
 * opt-in, not the new default). Always recorded into the funnel counter
 * (see PipelineFunnel below) regardless of the flag, since the per-batch
 * summary is useful even without the verbose per-candidate lines.
 */
export function logPipelineEvent(event: PipelineEvent): void {
  if (isDebugImportPipelineEnabled()) {
    console.log("[pipeline-debug]", JSON.stringify(event));
  }
}

function marketplaceFromUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "unknown";
  }
}

/**
 * Per-round/per-batch funnel counter — the "Do not only show final
 * counters... we need funnel visibility" requirement. One instance per
 * round in admin-scraper.ts, logged via .summarize() at the end of that
 * round.
 */
export class PipelineFunnel {
  private counts: Record<string, number> = {};
  private failedCandidates: PipelineEvent[] = [];

  record(eventWithoutTimestamp: Omit<PipelineEvent, "timestamp">): void {
    const event: PipelineEvent = { ...eventWithoutTimestamp, timestamp: Date.now() };
    logPipelineEvent(event);
    const key = event.success ? `${event.stage}_ok` : `${event.stage}_failed:${event.failure_reason ?? "unknown"}`;
    this.counts[key] = (this.counts[key] ?? 0) + 1;

    if (!event.success && isDebugImportPipelineEnabled()) {
      this.failedCandidates.push(event);
    }
  }

  recordExtraction(url: string, success: boolean, failure_reason?: string): void {
    this.record({ url, marketplace: marketplaceFromUrl(url), stage: "extraction", success, failure_reason });
  }

  recordMinimalQualityFilter(url: string, success: boolean, failure_reason?: string): void {
    this.record({ url, marketplace: marketplaceFromUrl(url), stage: "minimal_quality_filter", success, failure_reason });
  }

  recordDuplicateCheck(url: string, success: boolean, failure_reason?: string): void {
    this.record({ url, marketplace: marketplaceFromUrl(url), stage: "duplicate_check", success, failure_reason });
  }

  recordInsert(url: string, success: boolean, failure_reason?: string): void {
    this.record({ url, marketplace: marketplaceFromUrl(url), stage: "insert", success, failure_reason });
  }

  /**
   * Read-only snapshot of the raw `${stage}_ok` / `${stage}_failed:${reason}`
   * counters — lets a caller (runAdminScraper's dashboard-metrics wiring)
   * derive "extracted successfully" / "extraction failures by reason"
   * straight from data this class already tracks, instead of adding a
   * second, parallel counting mechanism.
   */
  getCounts(): Record<string, number> {
    return { ...this.counts };
  }

  /** Prints the funnel summary (Part 1's own "Scraped: 500 / Extracted: 320 / ..." example shape). */
  summarize(label: string): void {
    console.log(`\n[pipeline-debug] Funnel summary — ${label}:`);
    const keys = Object.keys(this.counts).sort();
    for (const key of keys) {
      console.log(`  ${key}: ${this.counts[key]}`);
    }
    if (keys.length === 0) {
      console.log("  (no candidates processed this round)");
    }

    if (isDebugImportPipelineEnabled() && this.failedCandidates.length > 0) {
      this.saveFailedCandidates(label);
    }
  }

  private saveFailedCandidates(label: string): void {
    try {
      const dir = join(process.cwd(), ".debug-import-pipeline");
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const filename = join(dir, `failed-${label.replace(/[^a-z0-9]/gi, "_")}-${Date.now()}.json`);
      writeFileSync(filename, JSON.stringify(this.failedCandidates, null, 2));
      console.log(`[pipeline-debug] Saved ${this.failedCandidates.length} failed candidate(s) to ${filename}`);
    } catch (error) {
      console.error("[pipeline-debug] Failed to save debug JSON:", error);
    }
  }
}
