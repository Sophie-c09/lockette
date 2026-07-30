// Shared logic for "dislikes should influence future recommendations, not
// just hide the one listing": extracting style signals from a disliked
// listing (src/app/actions/dislikes.ts, which folds them into
// style_profiles.disliked_styles) and applying those signals as a soft
// filter/penalty — weighted by how OFTEN a style has been disliked and how
// RECENTLY — when scoring future listings (src/lib/discover-feed.ts,
// src/lib/match-feed.ts, src/app/(app)/feed/page.tsx, and the three scoring
// modules those call). No I/O here — pure functions only; every function
// that needs "now" takes it as an explicit argument rather than calling
// Date.now() internally, so this stays fully deterministic/testable.
import { HOMEPAGE_CATEGORIES } from "@/lib/aesthetic-categories";

// style_profiles.disliked_styles is stored as jsonb: a map from normalized
// style signal -> how many times it's been disliked and when it was last
// disliked. Replaces an earlier text[]-of-signals version — a flat list
// couldn't tell "disliked once, ages ago" apart from "disliked five times
// this week," which is exactly the distinction this feature exists to make.
export interface DislikedStyleEntry {
  count: number;
  // ISO 8601 timestamp string (jsonb has no native date type).
  last_seen: string;
}

export type DislikedStyles = Record<string, DislikedStyleEntry>;

// The canonical shape a style signal is stored/compared in: lowercase, no
// leading "#". Kept as its own function (not imported from
// feed-scoring.ts/match-scoring.ts, which each have their own similarly-named
// but independent normalize() for their own tag comparisons) since this is
// the one true shape disliked_styles' keys need to agree on, regardless of
// which scoring module ends up consuming them.
export function normalizeStyleSignal(raw: string): string {
  return raw.trim().toLowerCase().replace(/^#/, "");
}

// Vocabulary used to recognize a "style phrase" inside a listing's raw
// title — reuses HOMEPAGE_CATEGORIES (src/lib/aesthetic-categories.ts)
// rather than inventing a second list: its fallback_terms were already
// verified live against real listings data (see that file's own header
// comment), and together with each category's label they're the same six
// aesthetics aesthetic_tags/style_tags are built from everywhere else in
// this app. This is also where "low rise" (a fallback_term under Y2K) and
// "grunge" (a fallback_term under Indie Sleaze) come from — the exact two
// keywords this feature's own spec uses as its worked example.
const TITLE_KEYWORD_VOCABULARY: string[] = [
  ...HOMEPAGE_CATEGORIES.flatMap((category) => category.fallback_terms),
  ...HOMEPAGE_CATEGORIES.map((category) => category.label.toLowerCase()),
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Style phrases found in a listing's title, matched against
 * TITLE_KEYWORD_VOCABULARY at word/phrase boundaries — mirrors
 * src/lib/extraction/infer-aesthetic-tags.ts's own keyword-scan pattern
 * (`\b<phrase>\b` against a lowercased haystack). "Secondary" signal, per
 * this feature's spec — see extractDislikedStyleSignals below, which
 * combines this with the listing's actual aesthetic_tags (primary).
 */
export function extractTitleKeywords(title: string): string[] {
  const haystack = title.toLowerCase();
  const found: string[] = [];

  for (const phrase of TITLE_KEYWORD_VOCABULARY) {
    const pattern = new RegExp(`\\b${escapeRegExp(phrase.toLowerCase())}\\b`);
    if (pattern.test(haystack)) found.push(phrase.toLowerCase());
  }

  return found;
}

/**
 * Every style signal a disliked listing carries: its own aesthetic_tags
 * (primary, normalized) plus any known style phrase found in its title
 * (secondary) — deduplicated. Each entry returned here is one occurrence
 * to fold into style_profiles.disliked_styles via mergeDislikedStyleSignals
 * below (count +1, last_seen bumped to now).
 *
 * Example (from this feature's own spec): a listing tagged/titled around
 * "low rise jeans grunge" -> ["low rise", "grunge"] (aesthetic_tags
 * contributing "grunge", the title contributing "low rise" via the Y2K
 * category's fallback_terms).
 */
export function extractDislikedStyleSignals(listing: { aesthetic_tags: string[]; title: string }): string[] {
  const fromTags = listing.aesthetic_tags.map(normalizeStyleSignal);
  const fromTitle = extractTitleKeywords(listing.title);
  return [...new Set([...fromTags, ...fromTitle])].filter(Boolean);
}

/**
 * Folds newly-extracted signals from one more disliked listing into the
 * user's existing disliked_styles map: each signal's count +1, last_seen
 * bumped to `nowIso`. Signals not present yet start at count: 1. Existing
 * entries for signals NOT touched this time are left completely alone
 * (their own count/last_seen only ever change when that exact signal shows
 * up again) — this is what lets frequency and recency track each style
 * independently instead of every dislike bumping every past signal.
 */
export function mergeDislikedStyleSignals(
  existing: DislikedStyles,
  newSignals: string[],
  nowIso: string,
): DislikedStyles {
  const merged: DislikedStyles = { ...existing };

  for (const rawSignal of newSignals) {
    const key = normalizeStyleSignal(rawSignal);
    if (!key) continue;

    const prior = merged[key];
    merged[key] = { count: (prior?.count ?? 0) + 1, last_seen: nowIso };
  }

  return merged;
}

// ---------------------------------------------------------------------------
// Scoring — how a listing's aesthetic_tags interact with the user's
// disliked_styles map. Two tiers by frequency (count), each halved once the
// signal is stale (last_seen more than DISLIKE_DECAY_DAYS ago) — so the
// feed adapts to recent dislikes but never gets permanently locked out of a
// style the user disliked once, long ago (see assessListingAgainstDislikedStyles).
// ---------------------------------------------------------------------------

const SINGLE_DISLIKE_PENALTY = 10; // count === 1
const REPEATED_DISLIKE_PENALTY = 20; // count 2-3
// count >= 4: fresh, this is a hard exclusion (see assessListingAgainstDislikedStyles);
// once stale, it decays into "just" this large-but-finite penalty instead of
// staying an absolute block — the numeric value only ever matters in that
// decayed case, since a fresh match short-circuits to excluded: true before
// this number is used for anything.
const HEAVY_DISLIKE_PENALTY = 100;
const HEAVY_DISLIKE_COUNT_THRESHOLD = 4;

export const DISLIKE_DECAY_DAYS = 14;
export const DISLIKE_DECAY_FACTOR = 0.5;

const DISLIKE_DECAY_MS = DISLIKE_DECAY_DAYS * 24 * 60 * 60 * 1000;

function isStale(lastSeenIso: string, nowMs: number): boolean {
  const lastSeenMs = Date.parse(lastSeenIso);
  if (!Number.isFinite(lastSeenMs)) return false; // malformed/missing timestamp -> treat as fresh, never decay something we can't date
  return nowMs - lastSeenMs > DISLIKE_DECAY_MS;
}

function basePenaltyForCount(count: number): number {
  if (count <= 0) return 0;
  if (count === 1) return SINGLE_DISLIKE_PENALTY;
  if (count < HEAVY_DISLIKE_COUNT_THRESHOLD) return REPEATED_DISLIKE_PENALTY;
  return HEAVY_DISLIKE_PENALTY;
}

interface TagAssessment {
  excluded: boolean;
  penalty: number;
}

function assessTag(entry: DislikedStyleEntry, nowMs: number): TagAssessment {
  const stale = isStale(entry.last_seen, nowMs);
  const base = basePenaltyForCount(entry.count);

  if (entry.count >= HEAVY_DISLIKE_COUNT_THRESHOLD && !stale) {
    // Fresh + disliked 4+ times: excluded outright (section 3 — "exclude").
    return { excluded: true, penalty: base };
  }

  return { excluded: false, penalty: stale ? base * DISLIKE_DECAY_FACTOR : base };
}

export interface DislikeAssessment {
  // True if any matching tag was disliked 4+ times AND that dislike is
  // still recent (<= DISLIKE_DECAY_DAYS old) — callers should drop this
  // listing entirely, not just down-rank it.
  excluded: boolean;
  // Summed across every matching tag that didn't itself trigger a hard
  // exclusion — a listing matching two disliked tags is penalized for
  // both, not just whichever is worse.
  penalty: number;
}

/**
 * The set of style keys currently hard-excluded (disliked 4+ times,
 * recently) — the same condition assessTag/assessListingAgainstDislikedStyles
 * check per-listing, exposed standalone so callers can reason about *which
 * styles* are excluded, not just whether one particular listing is.
 *
 * Exists for match-feed.ts's own topTags derivation: a user can like many
 * items of a style (saved_items) while also disliking 4+ *specific*
 * listings that happen to share that same style tag (disliked_items) —
 * those are independent signals and can legitimately disagree. Without
 * this, getTopTags could return a style that's simultaneously this user's
 * most-liked tag AND hard-excluded, which would let a heavily-disliked
 * style win a ranking slot in match-scoring.ts's sortByTagAffinity and
 * get treated as a positive signal — excluding these keys from the
 * topTags candidate pool up front avoids that. Note: sortByTagAffinity
 * itself never excludes listings (ranking only) — this function is about
 * which TAGS count as positive ranking signal, not which listings are
 * eligible for /match's swipe queue at all (that's liked/disliked-by-id
 * only, see match-feed.ts's own unseenListings filter).
 */
export function getHardExcludedStyleKeys(dislikedStyles: DislikedStyles, nowMs: number): Set<string> {
  const excluded = new Set<string>();
  for (const [key, entry] of Object.entries(dislikedStyles)) {
    if (entry.count >= HEAVY_DISLIKE_COUNT_THRESHOLD && !isStale(entry.last_seen, nowMs)) {
      excluded.add(key);
    }
  }
  return excluded;
}

/**
 * Assesses a listing's aesthetic_tags against the user's disliked_styles
 * map: excluded (drop this listing entirely) if any shared tag has been
 * disliked 4+ times recently; otherwise a summed point penalty from
 * whichever tags overlap, each scaled by that specific signal's own
 * frequency and recency. A listing with no overlapping tags at all always
 * comes back { excluded: false, penalty: 0 }.
 */
export function assessListingAgainstDislikedStyles(
  listingTags: string[],
  dislikedStyles: DislikedStyles,
  nowMs: number,
): DislikeAssessment {
  const seen = new Set<string>();
  let excluded = false;
  let penalty = 0;

  for (const rawTag of listingTags) {
    const key = normalizeStyleSignal(rawTag);
    if (!key || seen.has(key)) continue;
    seen.add(key);

    const entry = dislikedStyles[key];
    if (!entry) continue;

    const assessment = assessTag(entry, nowMs);
    if (assessment.excluded) excluded = true;
    penalty += assessment.penalty;
  }

  return { excluded, penalty };
}
