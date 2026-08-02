"use server";

// Admin-only removal/deprioritization of an already-LIVE listing, from
// Discover/Feed — distinct from src/lib/listingModeration.ts, which is
// scoped to the pending-approval queue (/admin/listings), not listings
// that are already active. Same local requireAdmin() copy-per-file
// convention as that file.
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isCurrentUserAdmin } from "@/lib/admin";

async function requireAdmin(): Promise<{ error?: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user || !(await isCurrentUserAdmin(supabase, user.id))) {
    return { error: "Not authorized." };
  }

  return {};
}

/**
 * Removes a listing — deliberately status-agnostic (no `.eq("status", ...)`
 * guard) so it works the same whether the listing is still pending,
 * already active, or anywhere else in its lifecycle: the one unified
 * "admin deletes this listing" action, used by both ListingCard.tsx's
 * admin menu (on an already-live Discover card) and the /admin/listings
 * moderation dashboard's "Delete" button (which can show pending OR
 * approved listings side by side via its All/Pending/Approved filter —
 * see listingModeration.ts's getListingsForModeration). Sets status =
 * 'removed' rather than deleting the row — this app never deletes
 * listings, it keeps them for analytics (see rejectListing's own comment
 * in listingModeration.ts). Also snapshots the listing into
 * admin_rejections (fields captured now, not re-derived later) so
 * there's training data for the scraper even though the row itself still
 * exists — including image_tags/fit_type/visual_aesthetic (Full Style
 * Learning System's negative-learning signal, see
 * src/lib/rejection-learning.ts), if this listing has them.
 */
export async function removeListing(listingId: string, reason?: string): Promise<{ error?: string }> {
  const authCheck = await requireAdmin();
  if (authCheck.error) return authCheck;

  const supabase = createAdminClient();

  const { data: listing } = await supabase
    .from("listings")
    .select("image_url, title, description, image_tags, fit_type, visual_aesthetic")
    .eq("id", listingId)
    .maybeSingle();

  const { error } = await supabase.from("listings").update({ status: "removed" }).eq("id", listingId);

  if (error) {
    console.error("[admin-listing-removal] Failed to remove listing:", error);
    return { error: error.message };
  }

  const { error: rejectionError } = await supabase.from("admin_rejections").insert({
    listing_id: listingId,
    image_url: listing?.image_url ?? null,
    title: listing?.title ?? null,
    description: listing?.description ?? null,
    tags: listing?.image_tags ?? null,
    fit: listing?.fit_type ?? null,
    aesthetic: listing?.visual_aesthetic ?? null,
    reason: reason?.trim() || null,
  });

  if (rejectionError) {
    // Best-effort — the removal itself already succeeded (the listing is
    // already gone from every feed), so a failed audit-row insert
    // shouldn't be reported back to the admin as if the removal failed.
    console.error("[admin-listing-removal] Failed to record admin_rejections row:", rejectionError);
  }

  return {};
}

/**
 * Manual override for a listing the check-listing-status cron marked
 * 'unavailable' (or that an admin removed via removeListing above) —
 * P0 launch-readiness requirement: that cron is deliberately conservative
 * (requires several consecutive unavailable signals — see that route's own
 * comment) but is still a heuristic, not a certainty, so an admin who has
 * confirmed the listing is actually still live needs a way to undo it
 * without going through SQL. Restores full visibility (status = 'active')
 * and resets this row's own availability bookkeeping so the cron starts
 * counting fresh rather than treating it as already having 3 consecutive
 * hits against it.
 */
export async function restoreListing(listingId: string): Promise<{ error?: string }> {
  const authCheck = await requireAdmin();
  if (authCheck.error) return authCheck;

  const supabase = createAdminClient();

  const { error } = await supabase
    .from("listings")
    .update({
      status: "active",
      removal_reason: null,
      consecutive_unavailable_checks: 0,
    })
    .eq("id", listingId);

  if (error) {
    console.error("[admin-listing-removal] Failed to restore listing:", error);
    return { error: error.message };
  }

  return {};
}

/**
 * Non-destructive alternative to removeListing — the listing stays
 * 'active' and fully visible everywhere else (order history, its own
 * detail page), just deprioritized in Discover/Feed ranking (see
 * listing-scoring.ts/feed-scoring.ts's own low-quality penalty).
 */
export async function markListingLowQuality(listingId: string): Promise<{ error?: string }> {
  const authCheck = await requireAdmin();
  if (authCheck.error) return authCheck;

  const supabase = createAdminClient();

  const { error } = await supabase.from("listings").update({ is_low_quality: true }).eq("id", listingId);

  if (error) {
    console.error("[admin-listing-removal] Failed to mark listing low-quality:", error);
    return { error: error.message };
  }

  return {};
}
