// Hand-written type for the `scraper_jobs` table (supabase/schema.sql) —
// same "one table per file, shaped like `supabase gen types typescript`
// output" convention as listings.types.ts, not merged into that file
// since this table is unrelated to `listings` itself.
//
// `updated_at`/`last_heartbeat` are optional/nullable on purpose: this
// codebase's own supabase/schema.sql doesn't define them, but a live
// database's actual `scraper_jobs` table was found to have them anyway
// (created by something other than this schema.sql, at some point before
// this file was last touched) — see src/lib/scraper-jobs.ts's own header
// comment for the full "stuck at status=running forever" bug this
// mismatch caused. Every write in scraper-jobs.ts treats both columns as
// best-effort (falls back to omitting them if a given database doesn't
// have them), so the type reflects that same "may or may not be there."
// 'pending'/'paused' (added for runLargeScaleAdminScraper — see
// supabase/schema.sql's own comment on scraper_jobs_status_check) sit
// alongside the original 'queued'/'running'/'completed'/'failed'.
// 'canceled' (final Inventory Growth stabilization pass — see
// cancelScraperJob in scraper-jobs.ts) requires
// supabase/migrations/20260806000000_add_scraper_jobs_canceled_status.sql;
// on a database that hasn't run it yet, cancelScraperJob itself falls
// back to 'failed' with a CANCELED_BY_ADMIN_PREFIX-tagged error_message —
// this type reflects the DESIRED end state, not a guarantee every
// database already accepts it.
export type ScraperJobStatus = "pending" | "queued" | "running" | "paused" | "completed" | "failed" | "canceled";

// checkpoint's shape for a large-scale ingestion job: seenUrls is enough
// for a resumed run not to immediately re-discover/re-try candidates a
// paused run already tried; options is a snapshot of that run's own
// LargeScaleAdminScraperOptions (src/lib/admin-scraper.ts) so resuming
// doesn't need those passed in again by hand.
export interface LargeScaleScraperCheckpoint {
  seenUrls?: string[];
  options?: Record<string, unknown>;
  // Diagnostic-only counter — never gates job failure (see batch-unit.ts's
  // own header comment on the time-based stall model that replaced it).
  consecutiveZeroProgressBatches?: number;
  // Time-based stall detection (final Inventory Growth stabilization
  // pass) — ISO timestamp of the most recent trusted productive event,
  // and a coarse, truthful current-stage label for the admin UI.
  lastProductiveProgressAt?: string;
  currentStage?: string;
}

export interface ScraperJobsDatabase {
  public: {
    Tables: {
      scraper_jobs: {
        Row: {
          id: string;
          status: ScraperJobStatus;
          requested_count: number;
          scraped_count: number;
          scored_count: number;
          passed_count: number;
          inserted_count: number;
          error_message: string | null;
          created_at: string;
          completed_at: string | null;
          updated_at?: string | null;
          last_heartbeat?: string | null;
          error_count?: number;
          last_url?: string | null;
          // Large-scale continuous ingestion fields — all optional/best-effort
          // for the same reason updated_at/last_heartbeat already are (a
          // database that hasn't run the latest supabase/schema.sql yet
          // won't have them): target_count (the overall inventory goal),
          // current_round (which batch number this run is on),
          // total_batches (this run's own planned ceiling),
          // valid_count/duplicate_count/rejected_count (finer-grained than
          // scored_count/inserted_count alone), checkpoint (this run's
          // seenUrls, enough to resume without re-discovering the same
          // candidates), mode ('fast' | 'quality').
          target_count?: number | null;
          current_round?: number | null;
          total_batches?: number | null;
          valid_count?: number;
          duplicate_count?: number;
          rejected_count?: number;
          insert_failed_count?: number;
          extracted_successfully_count?: number;
          extraction_failures_by_reason?: Record<string, number> | null;
          checkpoint?: LargeScaleScraperCheckpoint | null;
          mode?: string | null;
          // Discovery-scaling dashboard numbers (src/lib/inventory/
          // scaled-discovery.ts) — same optional/best-effort posture as
          // every other large-scale-only field above.
          queries_completed?: number;
          pages_searched?: number;
          unique_urls_discovered?: number;
          // P0 launch-readiness fix — per-batch lease so two concurrent
          // process-batch calls for the SAME job can't both run
          // runLargeScaleAdminScraper at once (see claimBatchLease in
          // scraper-jobs.ts). Cleared back to null once a batch attempt
          // finishes; a lease past batch_lease_expires_at is reclaimable,
          // same "stale claims recover" posture as scraper_url_queue.
          batch_lease_id?: string | null;
          batch_lease_expires_at?: string | null;
          // Render-worker migration — purely observational, see
          // supabase/migrations/20260805000000_add_inventory_worker_support.sql.
          // WHICH worker process currently holds batch_lease_id; the lease
          // mutex itself is unaffected by this column's presence/absence.
          batch_worker_id?: string | null;
        };
        Insert: {
          id?: string;
          status?: ScraperJobStatus;
          requested_count: number;
          scraped_count?: number;
          scored_count?: number;
          passed_count?: number;
          inserted_count?: number;
          error_message?: string | null;
          created_at?: string;
          completed_at?: string | null;
          updated_at?: string | null;
          last_heartbeat?: string | null;
          error_count?: number;
          last_url?: string | null;
          target_count?: number | null;
          current_round?: number | null;
          total_batches?: number | null;
          valid_count?: number;
          duplicate_count?: number;
          rejected_count?: number;
          insert_failed_count?: number;
          extracted_successfully_count?: number;
          extraction_failures_by_reason?: Record<string, number> | null;
          checkpoint?: LargeScaleScraperCheckpoint | null;
          mode?: string | null;
          // Discovery-scaling dashboard numbers (src/lib/inventory/
          // scaled-discovery.ts) — same optional/best-effort posture as
          // every other large-scale-only field above.
          queries_completed?: number;
          pages_searched?: number;
          unique_urls_discovered?: number;
          // P0 launch-readiness fix — per-batch lease so two concurrent
          // process-batch calls for the SAME job can't both run
          // runLargeScaleAdminScraper at once (see claimBatchLease in
          // scraper-jobs.ts). Cleared back to null once a batch attempt
          // finishes; a lease past batch_lease_expires_at is reclaimable,
          // same "stale claims recover" posture as scraper_url_queue.
          batch_lease_id?: string | null;
          batch_lease_expires_at?: string | null;
          batch_worker_id?: string | null;
        };
        Update: {
          id?: string;
          status?: ScraperJobStatus;
          requested_count?: number;
          scraped_count?: number;
          scored_count?: number;
          passed_count?: number;
          inserted_count?: number;
          error_message?: string | null;
          created_at?: string;
          completed_at?: string | null;
          updated_at?: string | null;
          last_heartbeat?: string | null;
          error_count?: number;
          last_url?: string | null;
          target_count?: number | null;
          current_round?: number | null;
          total_batches?: number | null;
          valid_count?: number;
          duplicate_count?: number;
          rejected_count?: number;
          insert_failed_count?: number;
          extracted_successfully_count?: number;
          extraction_failures_by_reason?: Record<string, number> | null;
          checkpoint?: LargeScaleScraperCheckpoint | null;
          mode?: string | null;
          // Discovery-scaling dashboard numbers (src/lib/inventory/
          // scaled-discovery.ts) — same optional/best-effort posture as
          // every other large-scale-only field above.
          queries_completed?: number;
          pages_searched?: number;
          unique_urls_discovered?: number;
          // P0 launch-readiness fix — per-batch lease so two concurrent
          // process-batch calls for the SAME job can't both run
          // runLargeScaleAdminScraper at once (see claimBatchLease in
          // scraper-jobs.ts). Cleared back to null once a batch attempt
          // finishes; a lease past batch_lease_expires_at is reclaimable,
          // same "stale claims recover" posture as scraper_url_queue.
          batch_lease_id?: string | null;
          batch_lease_expires_at?: string | null;
          batch_worker_id?: string | null;
        };
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
  };
}

export type ScraperJobRow = ScraperJobsDatabase["public"]["Tables"]["scraper_jobs"]["Row"];
