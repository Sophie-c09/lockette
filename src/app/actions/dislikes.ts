"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { extractDislikedStyleSignals, mergeDislikedStyleSignals, type DislikedStyles } from "@/lib/disliked-styles";
import { logStyleFeedback } from "@/lib/style-feedback";

// Persists a Match "X"/Skip swipe (src/components/match/MatchView.tsx) —
// previously this only removed the card from that session's in-memory
// queue, so a disliked listing could resurface on the very next refresh or
// on Discover/Feed. Check-then-insert rather than upsert+onConflict, same
// defensive convention cart.ts/saved-items.ts already use for this
// codebase's newer tables: a real live-DB drift once made an onConflict
// target silently fail (see saved-items.ts's own comment for the story),
// so this works correctly regardless of whether disliked_items' unique
// constraint actually made it onto the live database yet.
//
// Beyond hiding this one listing, also folds its style signals (aesthetic
// tags + keyword phrases pulled from its title — src/lib/disliked-styles.ts)
// into style_profiles.disliked_styles, so future Discover/Feed/Match loads
// down-rank or exclude similar listings too, not just this exact one.
//
// Signed-out swipes are a silent no-op, same as a plain swipe-right like
// (saveListing) — anonymous browsing shouldn't error, it just has nothing
// to persist yet.
export async function dislikeListing(listingId: string): Promise<{ error?: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return {};
  }

  const { data: existing, error: checkError } = await supabase
    .from("disliked_items")
    .select("id")
    .eq("user_id", user.id)
    .eq("listing_id", listingId)
    .maybeSingle();

  if (checkError) {
    return { error: checkError.message };
  }

  if (!existing) {
    const { error } = await supabase
      .from("disliked_items")
      .insert({ user_id: user.id, listing_id: listingId });

    if (error) {
      return { error: error.message };
    }
  }

  const { data: listingRow, error: listingError } = await supabase
    .from("listings")
    .select("aesthetic_tags, title")
    .eq("id", listingId)
    .maybeSingle();

  // A failed/missing listing lookup shouldn't undo the per-listing dislike
  // above (which already succeeded) — it just means this particular
  // dislike doesn't get to teach the style profile anything this time.
  if (!listingError && listingRow) {
    const newSignals = extractDislikedStyleSignals({
      aesthetic_tags: listingRow.aesthetic_tags ?? [],
      title: listingRow.title ?? "",
    });

    if (newSignals.length > 0) {
      const { data: styleProfile } = await supabase
        .from("style_profiles")
        .select("disliked_styles")
        .eq("user_id", user.id)
        .maybeSingle();

      const existingDislikedStyles: DislikedStyles = styleProfile?.disliked_styles ?? {};
      const nowIso = new Date().toISOString();
      const mergedDislikedStyles = mergeDislikedStyleSignals(existingDislikedStyles, newSignals, nowIso);

      // Upsert (not update), same reasoning as saveOnboarding
      // (src/app/actions/onboarding.ts): a plain update matches zero rows
      // and silently no-ops if this user's style_profiles row somehow
      // doesn't exist yet. onConflict-scoped to user_id only touches the
      // two columns passed here — style_tags/favorite_brands/etc. are left
      // untouched on an existing row.
      const { error: upsertError } = await supabase.from("style_profiles").upsert(
        { user_id: user.id, disliked_styles: mergedDislikedStyles, updated_at: nowIso },
        { onConflict: "user_id" },
      );

      if (upsertError) {
        console.error("[dislikeListing] Failed to update disliked_styles:", upsertError);
      }
    }
  }

  // Part 5 of the recommendation-integration architecture — best-effort,
  // never awaited-and-checked (see logStyleFeedback's own header comment).
  logStyleFeedback(user.id, listingId, "skip").catch(() => {});

  revalidatePath("/discover");
  revalidatePath("/match");
  return {};
}
