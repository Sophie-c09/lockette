import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { CartView, type CartListing } from "@/components/cart/CartView";

export const metadata: Metadata = {
  title: "Your cart — Lockette",
};

export default async function CartPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  // Two-step fetch, no FK join — same reasoning as /likes: cart_items only,
  // then the matching listings by id.
  const { data: cartRows } = await supabase
    .from("cart_items")
    .select("listing_id, created_at")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false });

  const orderedListingIds = (cartRows ?? [])
    .map((row) => row.listing_id)
    .filter((id): id is string => Boolean(id));

  let initialCartListings: CartListing[] = [];

  if (orderedListingIds.length > 0) {
    // shipping_cost intentionally not selected — see match-feed.ts's
    // comment for why (the column isn't on the live DB yet); CartListing/
    // CartView already treat it as optional. status may not exist yet
    // either — same missing-column failure mode, so this falls back to
    // the pre-status column set rather than failing the whole cart query.
    const withStatus = await supabase
      .from("listings")
      .select("id, title, price, image_url, brand, platform, product_url, status")
      .in("id", orderedListingIds);

    let listingsData = withStatus.data;
    let error = withStatus.error;

    if (error) {
      console.error("[cart-query-error] status-aware query failed, falling back:", error);
      const fallback = await supabase
        .from("listings")
        .select("id, title, price, image_url, brand, platform, product_url")
        .in("id", orderedListingIds);
      listingsData = fallback.data?.map((row) => ({ ...row, status: undefined })) ?? null;
      error = fallback.error;
    }

    if (error) {
      console.error("[cart-query-error]", error);
    }

    const listingById = new Map((listingsData ?? []).map((listing) => [listing.id, listing as CartListing]));
    initialCartListings = orderedListingIds
      .map((id) => listingById.get(id))
      .filter((listing): listing is CartListing => Boolean(listing));
  }

  return <CartView initialCartListings={initialCartListings} />;
}
