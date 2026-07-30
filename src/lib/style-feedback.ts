// Part 5 of the recommendation-integration architecture — logs a raw
// behavioral signal every time a user likes/saves/skips/purchases a
// listing. Additive to saved_items/disliked_items (this app's real,
// current like/dislike state — unchanged, still what Discover/Match
// actually read) — user_style_feedback is a full history over time,
// for future ranking-from-behavior work to train on (see this table's
// own header comment, supabase/schema.sql).
import { createAdminClient } from "@/lib/supabase/admin";

export type StyleFeedbackAction = "like" | "save" | "skip" | "purchase";

/**
 * Best-effort, never throws — a feedback-logging failure must never fail
 * the real action it's attached to (saving an item, disliking a listing,
 * completing a purchase all already succeeded by the time this is
 * called).
 */
export async function logStyleFeedback(userId: string, listingId: string | null, action: StyleFeedbackAction): Promise<void> {
  try {
    const supabase = createAdminClient();
    const { error } = await supabase.from("user_style_feedback").insert({ user_id: userId, listing_id: listingId, action });

    if (error) {
      console.error("[style-feedback] Failed to log feedback:", { userId, listingId, action, error });
    }
  } catch (error) {
    console.error("[style-feedback] Unexpected error logging feedback:", { userId, listingId, action, error });
  }
}
