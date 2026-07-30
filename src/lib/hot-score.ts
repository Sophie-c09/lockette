// "Hot Item" detection — urgency signal based on engagement on the
// ORIGINAL marketplace listing (Depop/Vinted/etc.), not Lockette's own
// activity (saves, cart adds, etc. — a separate "internal" hot-item signal
// can coexist alongside this one later without conflicting, since this
// only ever reads source_* columns).
//
// A listing with no engagement data at all (source_likes_count/
// source_views_count/source_comments_count all null — the common case,
// see src/lib/extraction/html-extractor.ts) scores 0 and is simply never
// "hot." No fallback to internal engagement is implemented here — showing
// no badge is the simpler, honest choice when there's nothing external to
// point to.
import type { Listing } from "@/lib/supabase/listings.types";

type EngagementFields = Pick<Listing, "source_likes_count" | "source_views_count" | "source_comments_count">;

// Tune here — likes are weighted highest (an explicit, deliberate action),
// comments next, views lowest (passive, easiest to rack up).
const HOT_SCORE_THRESHOLD = 100;

export function calculateExternalHotScore(listing: EngagementFields): number {
  return (
    (listing.source_likes_count || 0) * 3 +
    (listing.source_comments_count || 0) * 2 +
    (listing.source_views_count || 0) * 1
  );
}

export function isExternallyHot(listing: EngagementFields): boolean {
  return calculateExternalHotScore(listing) > HOT_SCORE_THRESHOLD;
}
