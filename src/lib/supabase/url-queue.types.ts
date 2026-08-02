// Hand-written type for the `scraper_url_queue` table (supabase/schema.sql,
// OVERNIGHT_AGGRESSIVE's asynchronous inventory pipeline) — same
// one-table-per-file convention as scraper-jobs.types.ts/
// listing-enrichment-queue.types.ts.
export type UrlQueueStatus = "pending" | "claimed" | "extracted" | "failed";

export interface UrlQueueDatabase {
  public: {
    Tables: {
      scraper_url_queue: {
        Row: {
          id: string;
          url: string;
          platform: string;
          query: string;
          page: number;
          status: UrlQueueStatus;
          attempt_count: number;
          created_at: string;
          processed_at: string | null;
          // P0 launch-readiness fix — the stale-claim reclaim used to
          // compare against `created_at` (enqueue time, not claim time),
          // so a row claimed shortly before it would have gone "stale"
          // anyway was immediately eligible for a second worker to
          // reclaim. This is stamped fresh at the actual moment of claim
          // (see claimNextUrls in url-queue.ts) — null until first claimed.
          claimed_at: string | null;
        };
        Insert: {
          id?: string;
          url: string;
          platform: string;
          query: string;
          page?: number;
          status?: UrlQueueStatus;
          attempt_count?: number;
          created_at?: string;
          processed_at?: string | null;
          claimed_at?: string | null;
        };
        Update: {
          id?: string;
          url?: string;
          platform?: string;
          query?: string;
          page?: number;
          status?: UrlQueueStatus;
          attempt_count?: number;
          created_at?: string;
          processed_at?: string | null;
          claimed_at?: string | null;
        };
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
  };
}

export type UrlQueueRow = UrlQueueDatabase["public"]["Tables"]["scraper_url_queue"]["Row"];
