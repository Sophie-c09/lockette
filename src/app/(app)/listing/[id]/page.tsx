import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { isReservedByAnotherUser, releaseExpiredReservations } from "@/lib/reservations";
import { ListingDetailView } from "@/components/listing/ListingDetailView";
import type { Listing } from "@/lib/supabase/listings.types";

export default async function ListingDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  // Plain untyped client, matching the /discover convention — this page
  // also queries saved_items, which the hand-written ListingsDatabase type
  // doesn't cover.
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Best-effort — clears out stale reservations so a listing isn't shown
  // as reserved past its 15-minute window.
  await releaseExpiredReservations();

  // source_likes_count/source_views_count/source_comments_count (Hot Item
  // detection, see src/lib/hot-score.ts) are NOT selected here — none of
  // the three columns exist on the live `listings` table (verified
  // directly against the database's PostgREST schema; they're declared in
  // supabase/schema.sql but that migration hasn't been applied live).
  // Omitting them is enough on its own: isExternallyHot's own Pick<> type
  // already treats them as optional and a missing value the same as zero
  // engagement, so Hot Item detection just never fires rather than
  // breaking the page. reserved_by_order_id/reservation_expires_at DO
  // exist live, so a single query covers everything this page needs.
  const LISTING_COLUMNS =
    "id, title, description, price, image_url, images, product_url, platform, brand, size, aesthetic_tags, created_at, reserved_by_order_id, reservation_expires_at, status";

  const { data: listingData, error } = await supabase
    .from("listings")
    .select(LISTING_COLUMNS)
    .eq("id", id)
    .maybeSingle();

  // A genuine query/database error is NOT the same as "this listing
  // doesn't exist" — treating both the same way (as this page previously
  // did) makes a real backend problem invisible, since it always renders
  // as a generic "doesn't exist or may have been removed" 404 either way.
  if (error) {
    console.error("[listing-query-error]", error);
    return (
      <div className="flex min-h-[calc(100vh-137px)] items-center justify-center px-6 text-center">
        <p className="text-sm text-ink-soft">
          Something went wrong loading this listing. Please try again.
        </p>
      </div>
    );
  }

  if (!listingData) {
    notFound();
  }

  const listing: Listing = listingData;

  let isSaved = false;
  let isInCart = false;
  if (user) {
    const [{ data: savedRow }, { data: cartRow }] = await Promise.all([
      supabase.from("saved_items").select("id").eq("user_id", user.id).eq("listing_id", id).maybeSingle(),
      supabase.from("cart_items").select("id").eq("user_id", user.id).eq("listing_id", id).maybeSingle(),
    ]);
    isSaved = Boolean(savedRow);
    isInCart = Boolean(cartRow);
  }

  const reservedByAnotherUser = await isReservedByAnotherUser(
    supabase,
    {
      reserved_by_order_id: listingData.reserved_by_order_id ?? null,
      reservation_expires_at: listingData.reservation_expires_at ?? null,
    },
    user?.id ?? null,
  );

  const isSold = Boolean(listing.status) && listing.status !== "active";

  return (
    <ListingDetailView
      listing={listing}
      initialSaved={isSaved}
      initialInCart={isInCart}
      reservedByAnotherUser={reservedByAnotherUser}
      isSold={isSold}
    />
  );
}
