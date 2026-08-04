"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { saveListing } from "@/app/actions/saved-items";

// Shared by both the Match super-like gesture and the listing detail page's
// "Add to Cart" button. Deliberately check-then-insert rather than
// upsert+onConflict — this project's saved_items table hit a live-DB
// unique-constraint drift doing that (see saved-items.ts), so a brand-new
// table never repeats that pattern, even though cart_items' unique
// constraint is created in the same migration as the table itself.
export async function addListingToCart(listingId: string): Promise<{ error?: string; added: boolean }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { error: "Sign in to add items to your cart.", added: false };
  }

  const { data: existing, error: checkError } = await supabase
    .from("cart_items")
    .select("id")
    .eq("user_id", user.id)
    .eq("listing_id", listingId)
    .maybeSingle();

  if (checkError) {
    return { error: checkError.message, added: false };
  }

  if (existing) {
    return { added: false };
  }

  const { error: insertError } = await supabase
    .from("cart_items")
    .insert({ user_id: user.id, listing_id: listingId });

  if (insertError) {
    return { error: insertError.message, added: false };
  }

  revalidatePath("/cart");
  return { added: true };
}

export async function removeListingFromCart(listingId: string): Promise<void> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return;

  await supabase.from("cart_items").delete().eq("user_id", user.id).eq("listing_id", listingId);
  revalidatePath("/cart");
}

// Fired by Match's double-tap gesture. A super-like is a like too — it
// reuses the existing, unmodified saveListing path — plus it adds the
// listing to the cart via addListingToCart above.
export async function superLikeListing(listingId: string): Promise<{ error?: string; added: boolean }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { error: "Sign in to add items to your cart.", added: false };
  }

  saveListing(listingId).catch(() => {});
  return addListingToCart(listingId);
}
