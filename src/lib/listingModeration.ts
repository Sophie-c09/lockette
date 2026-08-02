"use server";

// Data layer + actions for /admin/listings — the moderation dashboard.
// Since the "scraped listings go live automatically" ingestion change
// (src/lib/inventory/listing-flagging.ts), a new import is either 'active'
// immediately or 'flagged' for review — 'pending' is no longer written by
// any insert path (see admin-scraper.ts/bulk-import.ts/import-listing's
// own comments), so 'flagged' is now this dashboard's primary review
// state, the same role 'pending' used to play. 'pending' itself is kept
// as a still-valid status (existing historical rows, and this dashboard's
// own filter) rather than removed outright.
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isCurrentUserAdmin } from "@/lib/admin";
import type { QualityScoreBreakdown } from "@/lib/listing-quality";
import { MAX_SCRAPED_LISTING_IMAGES } from "@/lib/extraction/normalize-images";

export interface ModeratedListing {
  id: string;
  title: string;
  price: number | null;
  brand: string | null;
  image_url: string | null;
  // Full photo gallery, nullable/absent for a listing saved before the
  // images[] migration, same "images array, falling back to the single
  // image_url" pattern used everywhere else this field is read
  // (ListingDetailView.tsx, ListingCard.tsx).
  images: string[] | null;
  product_url: string | null;
  platform: string | null;
  created_at: string;
  // 'flagged'/'active' are the primary review states (see this file's own
  // header comment). 'unavailable' is fetched only via the "unavailable"
  // filter — P0 launch-readiness dead-listing cleanup: check-listing-status
  // (src/app/api/cron/check-listing-status/route.ts) flips a listing here
  // after several consecutive sold/removed signals, and an admin needs
  // somewhere to review and, if it was wrong, restore it (restoreListing,
  // src/lib/adminListingRemoval.ts). Still deliberately narrow — 'sold',
  // 'pending', and 'removed' remain outside this dashboard's scope.
  status: "flagged" | "active" | "unavailable";
  // Why a 'flagged' listing was flagged (src/lib/inventory/listing-flagging.ts)
  // — a comma-joined list of reasons, null for 'active' listings.
  flag_reason: string | null;
  // Why check-listing-status marked an 'unavailable' listing that way (the
  // matched phrase or JSON-LD value) — null otherwise.
  removal_reason: string | null;
  // "Detected aesthetics" on the admin card is just this — already
  // computed by enrichListing (text classification + AI image tagging)
  // before insert, not a separate field.
  aesthetic_tags: string[];
  // AI quality score (src/lib/listing-quality.ts) — null for a listing
  // scored before this column existed, not a real 0.
  quality_score: number | null;
  quality_reason: string | null;
  quality_breakdown: QualityScoreBreakdown | null;
}

export type ModerationFilter = "all" | "flagged" | "approved" | "unavailable";

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
 * Fetches listings for the /admin/listings moderation dashboard, filtered
 * to flagged, approved (active), or both — see ModerationFilter. Called by
 * both the page's initial server render and the admin view's own
 * client-side refresh, same "use server" function either way (matching
 * src/lib/purchaseQueue.ts's convention).
 */
export async function getListingsForModeration(
  filter: ModerationFilter = "all",
): Promise<{ items: ModeratedListing[]; error?: string }> {
  const authCheck = await requireAdmin();
  if (authCheck.error) {
    return { items: [], error: authCheck.error };
  }

  const supabase = await createClient();

  // quality_score/quality_reason/quality_breakdown/flag_reason are all
  // newer columns — selecting a missing column fails the *entire* query,
  // so this falls back to the older column set (aesthetic_tags is older
  // and not expected to be missing, but included in the same fallback for
  // simplicity) rather than showing an error over it.
  const FULL_COLUMNS =
    "id, title, price, brand, image_url, images, product_url, platform, status, flag_reason, removal_reason, created_at, aesthetic_tags, quality_score, quality_reason, quality_breakdown";
  const FALLBACK_COLUMNS = "id, title, price, brand, image_url, product_url, platform, status, created_at";

  // status descending puts 'flagged' (f) ahead of 'active' (a) — "Default
  // view: Flagged listings first" for the "all" filter — then oldest
  // first within each status group, same reasoning as this function's own
  // header comment.
  let fullQuery = supabase.from("listings").select(FULL_COLUMNS);
  fullQuery =
    filter === "flagged"
      ? fullQuery.eq("status", "flagged")
      : filter === "approved"
        ? fullQuery.eq("status", "active")
        : filter === "unavailable"
          ? fullQuery.eq("status", "unavailable")
          : fullQuery.in("status", ["flagged", "active"]);
  const full = await fullQuery.order("status", { ascending: false }).order("created_at", { ascending: true });

  let data = full.data;
  let error = full.error;

  if (error) {
    console.error("[listing-moderation] quality-score-aware query failed, falling back:", error);
    let fallbackQuery = supabase.from("listings").select(FALLBACK_COLUMNS);
    fallbackQuery =
      filter === "flagged"
        ? fallbackQuery.eq("status", "flagged")
        : filter === "approved"
          ? fallbackQuery.eq("status", "active")
          : filter === "unavailable"
            ? fallbackQuery.eq("status", "unavailable")
            : fallbackQuery.in("status", ["flagged", "active"]);
    const fallback = await fallbackQuery
      .order("status", { ascending: false })
      .order("created_at", { ascending: true });
    data =
      fallback.data?.map((row) => ({
        ...row,
        images: null,
        flag_reason: null,
        removal_reason: null,
        aesthetic_tags: [],
        quality_score: null,
        quality_reason: null,
        quality_breakdown: null,
      })) ?? null;
    error = fallback.error;
  }

  if (error) {
    console.error("[listing-moderation] Failed to fetch listings:", error);
    return { items: [], error: error.message };
  }

  return { items: (data as ModeratedListing[] | null) ?? [] };
}

/**
 * Approves a flagged listing — a single, no-frills status flip to
 * 'active', clearing flag_reason since it no longer applies. Deliberately
 * no quick-edit fields here: /admin/listings is a fast, one-click review
 * flow (image/title/price only, click anywhere on the card to approve),
 * not a listing editor. listings' only `authenticated`-role write access
 * is the narrow reservation-column grant (see supabase/schema.sql) —
 * status is only ever writable by a service-role client, same reasoning
 * as marking a listing sold in src/lib/orderActions.ts, so this goes
 * through createAdminClient() rather than the session client used for the
 * admin-identity check above.
 */
export async function approveListing(listingId: string): Promise<{ error?: string }> {
  const authCheck = await requireAdmin();
  if (authCheck.error) return authCheck;

  const supabase = createAdminClient();

  const { error } = await supabase
    .from("listings")
    .update({ status: "active", flag_reason: null })
    .eq("id", listingId)
    .eq("status", "flagged");

  if (error) {
    console.error("[listing-moderation] Failed to approve listing:", error);
    return { error: error.message };
  }

  return {};
}

/**
 * Rejects a flagged listing — the swipe-left counterpart to approveListing
 * above, same shape (status flip, guarded to only ever act on a still-
 * flagged row, service-role client since `status` isn't authenticated-role
 * writable). 'rejected' is a distinct, already-valid status from 'removed'
 * (adminListingRemoval.ts's removeListing, used for pulling an already-LIVE
 * listing) — this app never deletes a listing row outright, so a rejected
 * flagged listing stays in the table for analytics, it just leaves this
 * dashboard's scope (getListingsForModeration only ever fetches
 * flagged/active).
 */
export async function rejectListing(listingId: string): Promise<{ error?: string }> {
  const authCheck = await requireAdmin();
  if (authCheck.error) return authCheck;

  const supabase = createAdminClient();

  const { error } = await supabase
    .from("listings")
    .update({ status: "rejected" })
    .eq("id", listingId)
    .eq("status", "flagged");

  if (error) {
    console.error("[listing-moderation] Failed to reject listing:", error);
    return { error: error.message };
  }

  return {};
}

/**
 * Saves an admin's edited photo list for a listing — used by the photo
 * management UI on /admin/listings (delete individual photos, then Save).
 * Deliberately status-agnostic (no `.eq("status", "pending")` guard like
 * approve/reject): editing photos isn't a moderation decision, so this
 * works the same whether the listing is still pending or already active.
 *
 * `image_url` is kept in sync as `images[0]` (or null if every photo was
 * removed) — the same convention supabase/schema.sql's own `images` column
 * comment documents, so every other query that still only reads
 * `image_url` (cart, checkout, etc.) keeps seeing a sensible cover image
 * rather than a stale one a since-deleted photo used to be.
 */
export async function updateListingImages(listingId: string, images: string[]): Promise<{ error?: string }> {
  const authCheck = await requireAdmin();
  if (authCheck.error) return authCheck;

  if (!Array.isArray(images)) {
    return { error: "Invalid photo list." };
  }

  const cleaned = images
    .filter((url): url is string => typeof url === "string" && url.trim().length > 0)
    .slice(0, MAX_SCRAPED_LISTING_IMAGES);

  const supabase = createAdminClient();

  const { error } = await supabase
    .from("listings")
    .update({ images: cleaned, image_url: cleaned[0] ?? null })
    .eq("id", listingId);

  if (error) {
    console.error("[listing-moderation] Failed to update listing photos:", error);
    return { error: error.message };
  }

  return {};
}
