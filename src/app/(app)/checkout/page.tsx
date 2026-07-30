import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { CheckoutView, type CheckoutItem } from "@/components/checkout/CheckoutView";

export const metadata: Metadata = {
  title: "Checkout — Lockette",
};

// listing_id present -> single-item checkout (Buy Now); absent -> checks
// out the user's whole cart (Buy All). shipping_cost deliberately not
// selected — same reasoning as listing/[id]/page.tsx and match-feed.ts:
// that column isn't on the live DB yet, and selecting a missing column
// fails the entire query. Items just show as free shipping until it is.
const LISTING_COLUMNS = "id, title, price, image_url, brand, platform";

export default async function CheckoutPage({
  searchParams,
}: {
  searchParams: Promise<{ listingId?: string }>;
}) {
  const { listingId } = await searchParams;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  let items: CheckoutItem[] = [];

  if (listingId) {
    const { data: listing, error } = await supabase
      .from("listings")
      .select(LISTING_COLUMNS)
      .eq("id", listingId)
      .maybeSingle();

    if (error) {
      console.error("[checkout] Failed to fetch listing:", error);
    }

    if (listing) {
      items = [
        {
          id: listing.id,
          title: listing.title,
          price: listing.price ?? 0,
          imageUrl: listing.image_url,
          brand: listing.brand,
          platform: listing.platform,
        },
      ];
    }
  } else {
    const { data: cartRows, error: cartError } = await supabase
      .from("cart_items")
      .select("listing_id")
      .eq("user_id", user.id);

    if (cartError) {
      console.error("[checkout] Failed to fetch cart_items:", cartError);
    }

    const cartListingIds = (cartRows ?? [])
      .map((row) => row.listing_id)
      .filter((id): id is string => Boolean(id));

    if (cartListingIds.length > 0) {
      const { data: listingsData, error: listingsError } = await supabase
        .from("listings")
        .select(LISTING_COLUMNS)
        .in("id", cartListingIds);

      if (listingsError) {
        console.error("[checkout] Failed to fetch listings:", listingsError);
      }

      items = (listingsData ?? []).map((listing) => ({
        id: listing.id,
        title: listing.title,
        price: listing.price ?? 0,
        imageUrl: listing.image_url,
        brand: listing.brand,
        platform: listing.platform,
      }));
    }
  }

  return <CheckoutView items={items} listingId={listingId ?? null} />;
}
