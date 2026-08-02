// Shared reverse-image-search-style matching engine for both "Recreate
// This Outfit" and "Style Me" — both now detect every visible garment/
// accessory with rich structured attributes (src/lib/garment-detection.ts)
// instead of a coarse category + loose "vibe" tag, and both rank
// candidates against those attributes instead of aesthetic-tag overlap
// alone.
//
// "Visual similarity" here means a rich, multi-factor TEXT-attribute
// match (garment type, color, pattern, material, silhouette, resale
// search-query term overlap, aesthetic-tag overlap) — this codebase has
// no image-embedding/pixel-level comparison infrastructure (no pgvector,
// no CLIP embeddings anywhere), so this is the closest practical
// approximation without building that from scratch. Garment type is
// weighted far above every other signal specifically to fix "a black
// skirt should outrank black jeans even though both match the
// aesthetic" — aesthetic-tag overlap alone can't tell a skirt from jeans
// (both are the same "bottoms" bucket); a direct match against the AI's
// own specific garmentType can.
//
// Every candidate is drawn from status='active' listings only (sold/
// unavailable/pending/rejected/removed listings are excluded at the
// query level — this was already true before this upgrade, just
// reconfirmed/centralized here) and is never filtered by platform/
// source — every marketplace already present in the `listings` table is
// searched equally, no artificial "search only our own inventory" cap.
// Concretely: this app has only ever scraped Vinted/Depop/Poshmark (see
// src/lib/marketplace-discovery.ts's own source list) — Mercari and eBay
// listings don't exist in this database because nothing has ever scraped
// those two sites, not because this matching layer excludes them. Adding
// real Mercari/eBay coverage means building all-new scraper/extraction
// integrations for those platforms, which is a discovery-pipeline
// project of its own, out of scope for a matching/ranking upgrade.
import { createClient } from "@/lib/supabase/server";
import { categorizeListing } from "@/lib/bulk-import";
import { scoreListingMatch } from "@/lib/listing-scoring";
import { budgetMaxPrice, type BudgetOption } from "@/lib/budget-options";
import type { DetectedGarment } from "@/lib/garment-detection";
import type { ExtractedListing } from "@/lib/extraction/normalize-listing";
import type { Listing } from "@/lib/supabase/listings.types";

const LISTING_COLUMNS =
  "id, title, description, price, image_url, product_url, platform, brand, category, size, color, aesthetic_tags, created_at";

// How many ranked candidates to keep per item — enough for an initial
// top-3 display plus several rounds of "Shuffle Matches" (top 3, then the
// next 3 highest-ranked unused ones, etc. — src/lib/use-ranked-page.ts)
// without ever running out immediately.
const CANDIDATE_POOL_SIZE = 12;

// categorizeListing only ever reads .category/.title (see bulk-import.ts).
function bucketOf(listing: Pick<Listing, "title" | "category">): ReturnType<typeof categorizeListing> {
  return categorizeListing({ title: listing.title, category: listing.category ?? null } as ExtractedListing);
}

function includesTerm(haystack: string, term: string | null | undefined): boolean {
  if (!term) return false;
  return haystack.includes(term.trim().toLowerCase());
}

/**
 * Scores one candidate listing against one detected garment item. Weights
 * are a judgment call (not derived from anywhere else in the codebase),
 * ordered by how directly each signal proves "this is the same kind of
 * item," not just "similar vibe":
 *   - garmentType (the specific noun — "skirt," "jeans," "blazer") is by
 *     far the strongest signal, since it's the one thing aesthetic-tag
 *     overlap could never distinguish.
 *   - color/pattern/material/silhouette are concrete visual attributes.
 *   - search-query term overlap catches phrasing the above don't.
 *   - aesthetic-tag overlap is kept as a real factor (per this upgrade's
 *     own requirement — "do not rank based only on aesthetic tags," not
 *     "never use them at all") but scaled down since it's no longer the
 *     primary signal.
 */
export function scoreGarmentMatch(
  item: DetectedGarment,
  aestheticTags: string[],
  listing: Pick<Listing, "title" | "description" | "aesthetic_tags">,
): number {
  const haystack = `${listing.title} ${listing.description ?? ""}`.toLowerCase();

  let score = 0;
  if (includesTerm(haystack, item.garmentType)) score += 40;
  if (includesTerm(haystack, item.color)) score += 20;
  if (includesTerm(haystack, item.pattern)) score += 12;
  if (includesTerm(haystack, item.material)) score += 8;
  if (includesTerm(haystack, item.silhouette)) score += 10;
  if (includesTerm(haystack, item.era)) score += 5;

  const matchedQueries = item.searchQueries.filter((query) => includesTerm(haystack, query)).length;
  score += Math.min(matchedQueries * 6, 18);

  score += scoreListingMatch(aestheticTags, listing.aesthetic_tags) * 0.15;

  return score;
}

/**
 * Fetches every ACTIVE listing in the same garment bucket as `item`
 * (across every platform already present in `listings` — see this file's
 * own header comment), scores each one via scoreGarmentMatch, sorts
 * best-first, and returns up to CANDIDATE_POOL_SIZE.
 *
 * Price filtering is applied AFTER ranking, not as a query-time `.lte` —
 * the full active pool for this garment type is always ranked first, and
 * only then narrowed to the selected budget, so a price ceiling can never
 * hide how a candidate actually ranks before it's been ranked at all.
 * Same graceful-degrade as this app's matching has always used: if
 * nothing survives within budget, a real match slightly over budget
 * beats an empty slot.
 */
export async function fetchGarmentCandidates(
  item: DetectedGarment,
  aestheticTags: string[],
  budget: BudgetOption,
): Promise<Listing[]> {
  const supabase = await createClient();

  // P0 launch-readiness fix — `.not("image_url", "is", null)` alone isn't
  // enough (a listing can have image_url = "" rather than null, which
  // that filter wouldn't catch), so the client-side filter below also
  // rejects an empty string. Without this, an imageless/broken-image
  // listing could still be scored and surface in a reverse-image-search
  // bundle with nothing for the user to actually look at.
  const { data, error } = await supabase
    .from("listings")
    .select(LISTING_COLUMNS)
    .eq("status", "active")
    .not("image_url", "is", null);

  if (error || !data) {
    console.error("[garment-matching] Failed to fetch candidates:", error);
    return [];
  }

  const bucketed = (data as Listing[]).filter(
    (listing) => Boolean(listing.image_url?.trim()) && bucketOf(listing) === item.category,
  );

  const scored = bucketed
    .map((listing) => ({ listing, score: scoreGarmentMatch(item, aestheticTags, listing) }))
    .sort((a, b) => b.score - a.score);

  const maxPrice = budgetMaxPrice(budget);
  const withinBudget =
    maxPrice != null ? scored.filter(({ listing }) => listing.price != null && listing.price <= maxPrice) : scored;

  const pool = withinBudget.length > 0 ? withinBudget : scored;

  return pool.slice(0, CANDIDATE_POOL_SIZE).map(({ listing }) => listing);
}
