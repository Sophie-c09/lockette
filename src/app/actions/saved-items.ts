"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { logStyleFeedback } from "@/lib/style-feedback";

export async function saveItem(itemId: string): Promise<{ error?: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // /match is usable while signed out — quietly no-op instead of erroring
  // so anonymous swiping still feels seamless; nothing to persist yet.
  if (!user) {
    return {};
  }

  const { error } = await supabase
    .from("saved_items")
    .upsert({ user_id: user.id, item_id: itemId }, { onConflict: "user_id,item_id" });

  if (error) {
    return { error: error.message };
  }

  revalidatePath("/profile");
  return {};
}

// Bound directly to a <form action> on /profile (see unsaveItem.bind(null, id)),
// which requires a void-returning action — errors just mean the item stays
// in the list, which is a safe, visible failure mode.
export async function unsaveItem(itemId: string): Promise<void> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return;
  }

  const { error } = await supabase
    .from("saved_items")
    .delete()
    .eq("user_id", user.id)
    .eq("item_id", itemId);

  if (error) {
    return;
  }

  revalidatePath("/profile");
}

// TEMPORARY debug logging — remove once the like-persistence fix below is
// confirmed working in production.
function debugLogLike(payload: {
  userId: string | null;
  listingId: string;
  action: "save" | "unsave";
  success: boolean;
}): void {
  console.log("[likes-debug]", payload);
}

// Same mechanics as saveItem/unsaveItem above, but keyed on a real
// `listings.id` (listing_id column) rather than the mock catalog (item_id) —
// see the listing_id column added onto saved_items in supabase/schema.sql.
//
// Deliberately check-then-insert rather than upsert+onConflict: onConflict
// requires a unique constraint matching the conflict target to actually
// exist on the live database, and that migration (saved_items_user_listing_unique
// in schema.sql) turned out to have never been applied — every previous
// upsert() call was silently failing with Postgres error 42P10 ("no unique
// or exclusion constraint matching the ON CONFLICT specification"), which
// is the reason likes never persisted despite the UI looking like they did.
// This works correctly regardless of whether that constraint exists.
//
// item_id is also still NOT NULL on the live database (that part of the
// migration didn't land either) — real listing UUIDs never collide with
// the mock catalog's short ids ("v1", "c3", etc.), so storing listingId in
// item_id too satisfies the column without needing any further migration.
export async function saveListing(listingId: string): Promise<{ error?: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  console.log("[saveListing] user:", user);

  if (!user) {
    console.warn("[saveListing] No authenticated user — skipping save for listing", listingId);
    debugLogLike({ userId: null, listingId, action: "save", success: false });
    return { error: "Sign in to save listings." };
  }

  const { data: existing, error: checkError } = await supabase
    .from("saved_items")
    .select("id")
    .eq("user_id", user.id)
    .eq("listing_id", listingId)
    .maybeSingle();

  if (checkError) {
    debugLogLike({ userId: user.id, listingId, action: "save", success: false });
    return { error: checkError.message };
  }

  if (!existing) {
    const { data: inserted, error } = await supabase
      .from("saved_items")
      .insert({ user_id: user.id, listing_id: listingId, item_id: listingId })
      .select("id");

    console.log("[saveListing] insert result:", { data: inserted, error });

    // P0 launch-readiness fix — this check-then-insert has a real TOCTOU
    // race (rapid double-click, two open tabs): both calls can pass the
    // `!existing` check above before either insert lands. Postgres code
    // 23505 (unique_violation) means the OTHER call already won that race
    // — see supabase/migrations/20260801000300_add_saved_items_listing_unique_constraint.sql,
    // which (finally) actually applies the unique(user_id, listing_id)
    // constraint this needs to fire at all. Treated as success, not a
    // failure: the listing IS saved, just not by this particular call.
    if (error && error.code !== "23505") {
      debugLogLike({ userId: user.id, listingId, action: "save", success: false });
      return { error: error.message };
    }
  }

  debugLogLike({ userId: user.id, listingId, action: "save", success: true });
  // Part 5 of the recommendation-integration architecture — best-effort,
  // never awaited-and-checked (see logStyleFeedback's own header comment
  // on why a feedback-logging failure must never affect the real save,
  // which has already succeeded above).
  logStyleFeedback(user.id, listingId, "save").catch(() => {});
  revalidatePath("/discover");
  revalidatePath("/match");
  revalidatePath(`/listing/${listingId}`);
  return {};
}

export async function unsaveListing(listingId: string): Promise<{ error?: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    debugLogLike({ userId: null, listingId, action: "unsave", success: false });
    return { error: "Sign in to save listings." };
  }

  const { error } = await supabase
    .from("saved_items")
    .delete()
    .eq("user_id", user.id)
    .eq("listing_id", listingId);

  const success = !error;
  debugLogLike({ userId: user.id, listingId, action: "unsave", success });

  if (error) {
    return { error: error.message };
  }

  revalidatePath("/discover");
  revalidatePath("/match");
  revalidatePath(`/listing/${listingId}`);
  return {};
}

// Void-returning wrapper for direct <form action> binding (e.g. the remove
// button on /likes) — same reasoning as unsaveItem above, just for the real
// listing_id path instead of the mock catalog's item_id.
export async function unsaveListingAction(listingId: string): Promise<void> {
  await unsaveListing(listingId);
}
