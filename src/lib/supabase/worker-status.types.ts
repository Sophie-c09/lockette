// Hand-written type for the `inventory_worker_status` table — same "one
// table per file" convention as scraper-jobs.types.ts. See
// supabase/migrations/20260805000000_add_inventory_worker_support.sql for
// the table's own rationale (global worker-process health, independent of
// any one job's batch lease).
export interface WorkerStatusDatabase {
  public: {
    Tables: {
      inventory_worker_status: {
        Row: {
          worker_id: string;
          started_at: string;
          last_heartbeat: string;
          current_job_id: string | null;
          current_stage: string | null;
          active_browser_count: number;
          last_successful_unit_at: string | null;
          last_successful_unit: string | null;
          last_error: string | null;
          app_version: string | null;
          updated_at: string;
        };
        Insert: {
          worker_id: string;
          started_at?: string;
          last_heartbeat?: string;
          current_job_id?: string | null;
          current_stage?: string | null;
          active_browser_count?: number;
          last_successful_unit_at?: string | null;
          last_successful_unit?: string | null;
          last_error?: string | null;
          app_version?: string | null;
          updated_at?: string;
        };
        Update: {
          worker_id?: string;
          started_at?: string;
          last_heartbeat?: string;
          current_job_id?: string | null;
          current_stage?: string | null;
          active_browser_count?: number;
          last_successful_unit_at?: string | null;
          last_successful_unit?: string | null;
          last_error?: string | null;
          app_version?: string | null;
          updated_at?: string;
        };
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
  };
}

export type WorkerStatusRow = WorkerStatusDatabase["public"]["Tables"]["inventory_worker_status"]["Row"];
