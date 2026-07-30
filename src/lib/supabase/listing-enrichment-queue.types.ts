// Hand-written type for the `listing_enrichment_queue` table
// (supabase/schema.sql, Part 6 of the AI inventory architecture) — same
// one-table-per-file convention as scraper-jobs.types.ts.
export type EnrichmentQueueStatus = "pending" | "processing" | "completed" | "failed";

export interface ListingEnrichmentQueueDatabase {
  public: {
    Tables: {
      listing_enrichment_queue: {
        Row: {
          id: string;
          listing_id: string;
          status: EnrichmentQueueStatus;
          attempts: number;
          error: string | null;
          created_at: string;
          completed_at: string | null;
        };
        Insert: {
          id?: string;
          listing_id: string;
          status?: EnrichmentQueueStatus;
          attempts?: number;
          error?: string | null;
          created_at?: string;
          completed_at?: string | null;
        };
        Update: {
          id?: string;
          listing_id?: string;
          status?: EnrichmentQueueStatus;
          attempts?: number;
          error?: string | null;
          created_at?: string;
          completed_at?: string | null;
        };
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
  };
}

export type EnrichmentQueueRow = ListingEnrichmentQueueDatabase["public"]["Tables"]["listing_enrichment_queue"]["Row"];
