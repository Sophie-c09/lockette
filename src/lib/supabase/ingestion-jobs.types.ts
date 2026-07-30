// Hand-written types for the `ingestion_jobs` table (supabase/schema.sql)
// — same "scoped to one table, shaped like real codegen output"
// convention as src/lib/supabase/listings.types.ts.
export interface IngestionJobsDatabase {
  public: {
    Tables: {
      ingestion_jobs: {
        Row: {
          id: string;
          source: string;
          started_at: string;
          completed_at: string | null;
          listings_found: number | null;
          listings_imported: number | null;
          errors: string[] | null;
        };
        Insert: {
          id?: string;
          source: string;
          started_at?: string;
          completed_at?: string | null;
          listings_found?: number | null;
          listings_imported?: number | null;
          errors?: string[] | null;
        };
        Update: {
          id?: string;
          source?: string;
          started_at?: string;
          completed_at?: string | null;
          listings_found?: number | null;
          listings_imported?: number | null;
          errors?: string[] | null;
        };
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
  };
}

export type IngestionJobRow = IngestionJobsDatabase["public"]["Tables"]["ingestion_jobs"]["Row"];
export type IngestionJobInsert = IngestionJobsDatabase["public"]["Tables"]["ingestion_jobs"]["Insert"];
export type IngestionJobUpdate = IngestionJobsDatabase["public"]["Tables"]["ingestion_jobs"]["Update"];
