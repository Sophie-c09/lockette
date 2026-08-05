// Global Inventory Growth worker-process health — independent of any one
// job's own batch lease/heartbeat (scraper_jobs.last_heartbeat only exists
// while a job has an active lease; it can't answer "is the worker process
// itself even running" while idle between jobs). One row per worker_id in
// the inventory_worker_status table (supabase/migrations/
// 20260805000000_add_inventory_worker_support.sql), upserted on every
// heartbeat. Best-effort throughout, same "a missing table/column must
// never block the real feature" posture as scraper-jobs.ts — a database
// that hasn't run that migration yet just has no worker-health visibility;
// the worker's own job-processing loop is completely unaffected.
import { createAdminClient } from "@/lib/supabase/admin";
import type { WorkerStatusDatabase, WorkerStatusRow } from "@/lib/supabase/worker-status.types";

function isMissingTableOrColumnError(error: { code?: string; message: string }): boolean {
  return (
    error.code === "PGRST204" ||
    error.code === "PGRST205" ||
    /column .* does not exist/i.test(error.message) ||
    /could not find the table/i.test(error.message)
  );
}

export interface WorkerHealthUpdate {
  workerId: string;
  startedAt: string;
  currentJobId: string | null;
  currentStage: string;
  activeBrowserCount: number;
  lastSuccessfulUnitAt?: string | null;
  lastSuccessfulUnit?: string | null;
  lastError?: string | null;
  appVersion: string | null;
}

/** Best-effort upsert — logged but never thrown, so a missing migration or
 * a transient DB error never interrupts the worker's actual job loop. */
export async function upsertWorkerHealth(update: WorkerHealthUpdate): Promise<void> {
  const supabase = createAdminClient<WorkerStatusDatabase>();
  const nowIso = new Date().toISOString();

  const { error } = await supabase.from("inventory_worker_status").upsert(
    {
      worker_id: update.workerId,
      started_at: update.startedAt,
      last_heartbeat: nowIso,
      current_job_id: update.currentJobId,
      current_stage: update.currentStage,
      active_browser_count: update.activeBrowserCount,
      ...(update.lastSuccessfulUnitAt !== undefined ? { last_successful_unit_at: update.lastSuccessfulUnitAt } : {}),
      ...(update.lastSuccessfulUnit !== undefined ? { last_successful_unit: update.lastSuccessfulUnit } : {}),
      ...(update.lastError !== undefined ? { last_error: update.lastError } : {}),
      app_version: update.appVersion,
      updated_at: nowIso,
    },
    { onConflict: "worker_id" },
  );

  if (error && !isMissingTableOrColumnError(error)) {
    console.error("[worker-health] Failed to upsert worker health:", error);
  }
}

// How stale a worker's last_heartbeat can get before the admin dashboard
// should stop calling it "online" — comfortably above
// WORKER_HEARTBEAT_INTERVAL_MS (scraper-config.ts) so one slow tick isn't
// mistaken for a dead process, well below a duration long enough to hide a
// genuinely crashed worker from an admin watching the dashboard.
export const WORKER_STALE_THRESHOLD_MS = 90_000;

export type WorkerHealthClassification = "online" | "stale" | "not_configured";

export interface WorkerHealthSummary {
  classification: WorkerHealthClassification;
  workers: (WorkerStatusRow & { isStale: boolean })[];
}

/** Best-effort read for the admin dashboard (metrics route) — a missing
 * table/migration degrades to "not_configured" rather than an error, since
 * that's operationally true: no worker health has ever been recorded. */
export async function getWorkerHealthSummary(): Promise<WorkerHealthSummary> {
  const supabase = createAdminClient<WorkerStatusDatabase>();
  const { data, error } = await supabase
    .from("inventory_worker_status")
    .select("*")
    .order("last_heartbeat", { ascending: false });

  if (error || !data || data.length === 0) {
    if (error && !isMissingTableOrColumnError(error)) {
      console.error("[worker-health] Failed to read worker health:", error);
    }
    return { classification: "not_configured", workers: [] };
  }

  const now = Date.now();
  const workers = data.map((row) => ({
    ...row,
    isStale: now - new Date(row.last_heartbeat).getTime() > WORKER_STALE_THRESHOLD_MS,
  }));

  const anyOnline = workers.some((w) => !w.isStale);
  return { classification: anyOnline ? "online" : "stale", workers };
}
