// Part 12 of the AI inventory architecture — lifecycle states beyond
// what already exists. Distinct from src/app/api/cron/check-listing-status/route.ts
// (unchanged, still the only thing that confirms "is this still for sale
// on the ORIGINAL site" and marks 'unavailable') — this file is about
// STALENESS within Lockette's own inventory-intelligence layer: a listing
// this pipeline hasn't re-verified in a long time, independent of
// whether the source-site check has run. Uses last_verified_at (Part 8,
// stamped by inventory-indexer.ts's processEnrichmentBatch), not
// last_checked_at (that cron's own column) — the two track different
// things and neither replaces the other.
import { createAdminClient } from "@/lib/supabase/admin";
import type { ListingsDatabase } from "@/lib/supabase/listings.types";

// A listing not re-verified by the indexer in this long is "stale" —
// eligible to be marked 'expired' rather than kept 'active' indefinitely
// on the strength of a verification that's no longer recent. Same
// horizon as inventory-quality-score.ts's own FRESHNESS_HORIZON_DAYS, so
// a listing that would already score 0 on freshness is also the one this
// marks 'expired'.
const STALE_THRESHOLD_DAYS = 60;
const BATCH_SIZE = 500; // bounded — Part 14: never scan/update the whole table in one query

export interface StaleListingSweepResult {
  checked: number;
  markedExpired: number;
}

/**
 * Bounded, one page at a time — a caller (admin dashboard action, or a
 * scheduled job) can call this repeatedly to work through the full
 * backlog without ever loading more than BATCH_SIZE rows at once.
 */
export async function markStaleListingsExpired(): Promise<StaleListingSweepResult> {
  const supabase = createAdminClient<ListingsDatabase>();
  const cutoff = new Date(Date.now() - STALE_THRESHOLD_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const { data: stale, error } = await supabase
    .from("listings")
    .select("id")
    .eq("status", "active")
    .or(`last_verified_at.is.null,last_verified_at.lt.${cutoff}`)
    .lt("created_at", cutoff) // never expire a listing purely for being new and not yet indexed
    .limit(BATCH_SIZE);

  if (error) {
    console.error("[listing-lifecycle] Failed to fetch stale candidates:", error);
    return { checked: 0, markedExpired: 0 };
  }
  if (!stale || stale.length === 0) {
    return { checked: 0, markedExpired: 0 };
  }

  const ids = stale.map((row) => row.id);
  const { error: updateError } = await supabase.from("listings").update({ status: "expired" }).in("id", ids);

  if (updateError) {
    console.error("[listing-lifecycle] Failed to mark listings expired:", updateError);
    return { checked: stale.length, markedExpired: 0 };
  }

  console.log(`[listing-lifecycle] Marked ${ids.length} stale listing(s) expired (checked ${stale.length})`);
  return { checked: stale.length, markedExpired: ids.length };
}

export interface LifecycleCounts {
  // Kept for historical rows (no insert path writes 'pending' anymore —
  // see src/lib/inventory/listing-flagging.ts); will read 0 once the
  // one-time pending->active backfill has run.
  pending: number;
  flagged: number;
  active: number;
  expired: number;
  removed: number;
}

export async function getLifecycleCounts(): Promise<LifecycleCounts> {
  const supabase = createAdminClient<ListingsDatabase>();
  const [pending, flagged, active, expired, removed] = await Promise.all([
    supabase.from("listings").select("id", { count: "exact", head: true }).eq("status", "pending"),
    supabase.from("listings").select("id", { count: "exact", head: true }).eq("status", "flagged"),
    supabase.from("listings").select("id", { count: "exact", head: true }).eq("status", "active"),
    supabase.from("listings").select("id", { count: "exact", head: true }).eq("status", "expired"),
    supabase.from("listings").select("id", { count: "exact", head: true }).eq("status", "removed"),
  ]);

  return {
    pending: pending.count ?? 0,
    flagged: flagged.count ?? 0,
    active: active.count ?? 0,
    expired: expired.count ?? 0,
    removed: removed.count ?? 0,
  };
}
