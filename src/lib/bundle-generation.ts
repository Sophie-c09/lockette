// AI-Powered Outfit Creation — the orchestration that actually turns an
// inspiration photo into a shoppable, priced, dated bundle. Ties together
// every piece built for this feature without duplicating any of them:
//   1. analyzeBundleInspiration (style-bundle-analysis.ts) — the photo(s)
//      are the primary signal, text/budget/categories are secondary.
//   2. searchMarketplaceItems (marketplace-search.ts) — UNCHANGED, one
//      call per detected item, same abstraction Recreate This Look uses.
//   3. rankBundleCandidates (bundle-ranking.ts) — the weighted composite
//      (visual/garment/style/color/budget) over the existing scoring
//      engines, not a new one.
//   4. calculateBundlePricing / estimateBundleDelivery / buildOutfitPreviewLayout
//      — pricing, shipping, and collage layout for the chosen items.
// This is a NEW, additive path — the existing manual admin curation flow
// (src/lib/styleRequestAdmin.ts's createBundleForRequest, still fully
// intact) is untouched; this is an alternative way to arrive at the same
// styled_bundles/styled_bundle_items rows, not a replacement for it.
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { getSignedStyleRequestImageUrls } from "@/lib/style-request-photo";
import { analyzeBundleInspiration, type BundleDetectedItem, type StyleBundleAnalysis } from "@/lib/style-bundle-analysis";
import { searchMarketplaceItems } from "@/lib/marketplace-search";
import { generateImageEmbedding } from "@/lib/image-similarity";
import { rankBundleCandidates, type BundleRankableCandidate } from "@/lib/bundle-ranking";
import { calculateVisualMatch } from "@/lib/ai/style-match-score";
import { calculateBundlePricing } from "@/lib/bundle-pricing";
import { estimateBundleDelivery } from "@/lib/shipping-estimator";
import { buildOutfitPreviewLayout } from "@/lib/outfit-preview";
import type { MarketplaceSource } from "@/lib/marketplaces/types";
import type { GarmentCategory } from "@/lib/garment-detection";
import type { Listing } from "@/lib/supabase/listings.types";

const FULL_LISTING_COLUMNS =
  "id, title, description, price, image_url, product_url, platform, brand, category, size, color, aesthetic_tags, image_embedding, created_at";

// Inventory Intelligence integration (Part 2) — visual_analysis/
// visual_embedding/inventory_quality_score feed findBestMatchForItem's
// new finalist-reranking step below. Selected only once this database is
// confirmed to have these columns (probed lazily, cached for the process
// lifetime — same pattern discover-feed.ts uses for the same reason):
// appending them to FULL_LISTING_COLUMNS unconditionally would fail the
// ENTIRE query — and therefore bundle generation itself — on a database
// where supabase/schema.sql's Part 8 migration hasn't been run yet, which
// would be a far worse regression than just not having the new signal.
const INTELLIGENCE_LISTING_COLUMNS = "visual_analysis, visual_embedding, inventory_quality_score";
let bundleIntelligenceColumnsAvailable: boolean | null = null;

async function checkBundleIntelligenceColumnsAvailable(supabase: AnySupabaseClient): Promise<boolean> {
  if (bundleIntelligenceColumnsAvailable != null) return bundleIntelligenceColumnsAvailable;
  const { error } = await supabase.from("listings").select(INTELLIGENCE_LISTING_COLUMNS).limit(1);
  bundleIntelligenceColumnsAvailable = !error;
  return bundleIntelligenceColumnsAvailable;
}

interface ListingRankableCandidate extends BundleRankableCandidate {
  listing: Listing;
}

// Bounded, not "embed the whole candidate pool" — generating an embedding
// is 2 OpenAI calls (see src/lib/image-similarity.ts's own header
// comment on the vision-description-then-embed technique); doing this
// for every candidate on every bundle generation would be slow and
// costly for marginal benefit once the top handful are covered. Matches
// the same "bounded concurrency for a bounded slice" reasoning already
// used for embedding new imports (src/lib/bulk-import.ts's
// EMBEDDING_CONCURRENCY).
const CANDIDATES_TO_EMBED_PER_ITEM = 5;

// Weighted budget allocation — replaces an even split across detected
// items. Each value is the midpoint of this feature's own requested
// range (tops 20-30%, bottoms 30-40%, shoes 30-40%, accessories 10-20%);
// dresses/outerwear/bags aren't in that spec, so they're mapped to the
// closest analogous role rather than left unweighted (dresses functions
// as BOTH a top and bottom in one garment, so it gets bottoms/shoes'
// weight; outerwear is a layering piece like a top; bags function like
// an accessory) — every category has a real, positive weight, so no
// detected item can ever land on a zero allocation.
const CATEGORY_BUDGET_WEIGHT: Record<GarmentCategory, number> = {
  tops: 25,
  outerwear: 25,
  bottoms: 35,
  dresses: 35,
  shoes: 35,
  accessories: 15,
  bags: 15,
};

/**
 * Splits a total budget across detected items by their category's own
 * weight rather than evenly — a $150 budget for [tops, bottoms, shoes]
 * (weights 25/35/35, total 95) gives tops ~$39.50, bottoms/shoes
 * ~$55.25 each, summing back to exactly $150 (rounding aside), never to
 * more. Two items sharing a category each get that category's own
 * weight independently (not split further between them) — simple, and
 * every weight table entry is positive, so no item's allocation is ever
 * zero. Returns an array of nulls (no ceiling at all) when no budget was
 * given, same as the even-split version this replaces.
 */
function allocateBudgetPerItem(items: BundleDetectedItem[], totalBudget: number | null): (number | null)[] {
  if (totalBudget == null || items.length === 0) {
    return items.map(() => null);
  }

  const weights = items.map((item) => CATEGORY_BUDGET_WEIGHT[item.category]);
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);

  return weights.map((weight) => Math.round((weight / totalWeight) * totalBudget * 100) / 100);
}

// Vibe-based fallback (see generateBundleForRequest/runBundleGenerationAsync
// below) — when the vision model comes back with zero discrete
// detected_items (a genuinely aesthetic/mood-board-style inspiration
// photo, or one where nothing was identifiable with confidence), this
// builds a small synthetic capsule from the analysis's whole-image
// signal (dominantColors/silhouettes/aesthetic) instead of failing the
// request outright. Deliberately a SMALL, fixed spread of categories —
// not all seven GARMENT_CATEGORIES — so a vibe-only bundle still reads
// as a curated capsule (top + bottoms + shoes) rather than firing one
// search per category that exists just because it exists.
const VIBE_FALLBACK_SLOTS: { category: GarmentCategory; label: string }[] = [
  { category: "tops", label: "top" },
  { category: "bottoms", label: "bottoms" },
  { category: "shoes", label: "shoes" },
];

function buildVibeFallbackItems(analysis: StyleBundleAnalysis): BundleDetectedItem[] {
  const color = analysis.dominantColors[0] ?? null;
  const silhouette = analysis.silhouettes[0] ?? null;

  return VIBE_FALLBACK_SLOTS.map(({ category, label }) => ({
    category,
    garmentType: [silhouette, label].filter(Boolean).join(" ") || label,
    color,
    material: null,
    silhouette,
    pattern: null,
    era: null,
    styleTags: analysis.aesthetic,
  }));
}

function foldItemDescription(item: BundleDetectedItem): string {
  return [item.garmentType, item.color, item.material, item.silhouette, item.pattern, item.era, ...item.styleTags]
    .filter((part): part is string => Boolean(part))
    .join(" ");
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- accepts either the request-scoped client or createAdminClient() (see this function's two callers), matching createClient's own generic default (src/lib/supabase/server.ts)
type AnySupabaseClient = any;

/**
 * One detected item -> its single best real listing match: search
 * (marketplace-search.ts, unchanged) -> fetch full Listing rows for
 * whichever came back tagged "reworn" -> embed a bounded top slice that
 * isn't already embedded -> rank (bundle-ranking.ts) -> take the top
 * result. Shared by generateBundleForRequest's synchronous, all-at-once
 * path (still used by the admin preview flow,
 * src/lib/styleRequestAdmin.ts) and runBundleGenerationAsync's
 * progressive path below — one implementation of "find a match," not
 * two copies that could drift.
 */
async function findBestMatchForItem(
  supabase: AnySupabaseClient,
  item: BundleDetectedItem,
  style: string,
  queryImageEmbedding: number[] | null,
  budgetCeiling: number | null,
): Promise<Listing | null> {
  const results = await searchMarketplaceItems({
    category: item.category,
    description: foldItemDescription(item),
    color: item.color ?? "",
    style,
    priceLimit: budgetCeiling,
  });

  const rewornIds = results.filter((result) => result.platform === "reworn").map((result) => result.id);
  if (rewornIds.length === 0) return null;

  const hasIntelligenceColumns = await checkBundleIntelligenceColumnsAvailable(supabase);
  const listingColumns = hasIntelligenceColumns ? `${FULL_LISTING_COLUMNS}, ${INTELLIGENCE_LISTING_COLUMNS}` : FULL_LISTING_COLUMNS;

  const { data: fullListings } = await supabase.from("listings").select(listingColumns).in("id", rewornIds);
  const listingById = new Map(((fullListings ?? []) as Listing[]).map((listing) => [listing.id, listing]));
  const candidates = rewornIds.map((id) => listingById.get(id)).filter((listing): listing is Listing => Boolean(listing));

  if (candidates.length === 0) return null;

  // Embed only the top slice (see CANDIDATES_TO_EMBED_PER_ITEM's own
  // comment) that don't already have a cached embedding — never
  // re-embeds a listing that was already backfilled/embedded on import.
  const toEmbed = candidates.filter((listing) => !listing.image_embedding).slice(0, CANDIDATES_TO_EMBED_PER_ITEM);
  const embeddings = await Promise.all(
    toEmbed.map((listing) => (listing.image_url ? generateImageEmbedding(listing.image_url) : Promise.resolve(null))),
  );
  const freshEmbeddingById = new Map(toEmbed.map((listing, index) => [listing.id, embeddings[index]]));

  const rankable: ListingRankableCandidate[] = candidates.map((listing) => ({
    listing,
    category: item.category,
    price: listing.price,
    searchableText: [listing.title, listing.description, listing.color, listing.brand].filter(Boolean).join(" "),
    imageEmbedding: listing.image_embedding ?? freshEmbeddingById.get(listing.id) ?? null,
  }));

  const ranked = rankBundleCandidates(item, style, rankable, queryImageEmbedding, budgetCeiling);

  // Inventory Intelligence integration (Part 2) — re-rank the top few
  // finalists using each candidate's visual_analysis/inventory_quality_score
  // when present, rather than always taking rankBundleCandidates' own #1
  // outright. This SUPPLEMENTS the existing weighted-composite ranking
  // (still what selects the shortlist in the first place) rather than
  // replacing it: a candidate the AI pipeline hasn't analyzed yet simply
  // isn't reconsidered here, so this is a safe no-op — identical to
  // today's behavior — until the indexer (src/lib/inventory/inventory-indexer.ts)
  // has actually processed a meaningful slice of inventory.
  const FINALIST_COUNT = 3;
  const finalists = ranked.slice(0, FINALIST_COUNT);
  let best = finalists[0] ?? null;
  let bestBonus = -Infinity;

  for (const candidate of finalists) {
    const listing = candidate.listing;
    if (!listing.visual_analysis) continue;

    const match = calculateVisualMatch(
      { ...listing.visual_analysis, price: listing.price, imageEmbedding: listing.visual_embedding ?? null },
      { aesthetics: style ? [style] : [], queryImageEmbedding },
    );
    const bonus = match.score + (listing.inventory_quality_score ?? 0) * 0.1;

    if (bonus > bestBonus) {
      bestBonus = bonus;
      best = candidate;
    }
  }

  return best?.listing ?? null;
}

export interface GeneratedBundleItem {
  listing: Listing;
  category: BundleDetectedItem["category"];
  replacementGroup: string;
  position: number;
}

export interface GeneratedBundle {
  analysis: StyleBundleAnalysis;
  items: GeneratedBundleItem[];
  pricing: ReturnType<typeof calculateBundlePricing>;
  delivery: ReturnType<typeof estimateBundleDelivery>;
  previewImage: string | null;
}

/**
 * Runs the full AI generation pipeline for one style_requests row and
 * returns the assembled (not yet persisted) bundle — see
 * saveGeneratedBundle below for the actual insert. Returns an error
 * string (never throws) for any real failure — a missing inspiration
 * photo, a failed vision analysis, or zero shoppable matches found for
 * every detected item.
 */
export async function generateBundleForRequest(
  requestId: string,
): Promise<{ bundle?: GeneratedBundle; error?: string }> {
  const supabase = await createClient();

  const { data: request, error: requestError } = await supabase
    .from("style_requests")
    .select("user_id, inspo_text, inspo_images, budget, categories")
    .eq("id", requestId)
    .maybeSingle();

  if (requestError || !request) {
    return { error: "Style request not found." };
  }

  const imageUrls = await getSignedStyleRequestImageUrls(supabase, request.inspo_images ?? []);
  if (imageUrls.length === 0) {
    return { error: "This request has no inspiration photos to analyze." };
  }

  const analysis = await analyzeBundleInspiration({
    imageUrls,
    inspoText: request.inspo_text,
    categories: request.categories ?? [],
    budget: request.budget,
  });

  // Only a genuine processing failure (bad/missing API key, network
  // error, rate limit, malformed response — see analyzeBundleInspiration's
  // own try/catch) is a hard error. The photo being hard to parse into
  // discrete garments is NOT the same failure and must not be reported
  // as one — see the vibe-based fallback just below.
  if (!analysis) {
    return { error: "We couldn't process the inspiration photo(s). Please try again." };
  }

  // Vibe-based fallback — the vision call succeeded but found no
  // confident, discrete garments (a mood-board/aesthetic-focused photo).
  // Rather than failing the whole request, build a small capsule from
  // the analysis's whole-image color/silhouette/aesthetic signal instead
  // of its (empty) per-item list.
  const detectedItems = analysis.detectedItems.length > 0 ? analysis.detectedItems : buildVibeFallbackItems(analysis);

  // One embedding for the WHOLE inspiration photo (the first image, which
  // is the primary reference) — reused as the query embedding for every
  // detected item's visual-similarity scoring, same "one photo per
  // recreation" simplification src/app/actions/outfit-recreations.ts
  // already makes for Recreate This Look.
  const queryImageEmbedding = await generateImageEmbedding(imageUrls[0]);

  const style = analysis.aesthetic.join(" ");
  const perItemBudgets = allocateBudgetPerItem(detectedItems, request.budget);

  const generatedItems: GeneratedBundleItem[] = [];

  for (const [index, item] of detectedItems.entries()) {
    const listing = await findBestMatchForItem(supabase, item, style, queryImageEmbedding, perItemBudgets[index]);
    if (!listing) continue;

    generatedItems.push({
      listing,
      category: item.category,
      replacementGroup: item.category,
      position: generatedItems.length,
    });
  }

  if (generatedItems.length === 0) {
    return { error: "Couldn't find enough matching items for this outfit yet. Try again in a bit, or submit a new style request with a different photo." };
  }

  const pricing = calculateBundlePricing(generatedItems.map((entry) => entry.listing.price ?? 0));

  const sellerPlatforms = generatedItems.map(
    (entry) => (entry.listing.platform?.toLowerCase() ?? "reworn") as MarketplaceSource,
  );
  const delivery = estimateBundleDelivery(sellerPlatforms, generatedItems.length, new Date());

  const layout = buildOutfitPreviewLayout(
    generatedItems.map((entry) => ({
      listingId: entry.listing.id,
      category: entry.category,
      garmentType: entry.category,
      title: entry.listing.title,
      imageUrl: entry.listing.image_url,
      price: entry.listing.price,
      position: entry.position,
    })),
  );
  const previewImage = layout.tiles.find((tile) => tile.imageUrl)?.imageUrl ?? null;

  return {
    bundle: { analysis, items: generatedItems, pricing, delivery, previewImage },
  };
}

/**
 * Persists a GeneratedBundle: one styled_bundles row (with the new
 * pricing/delivery/preview columns) + one styled_bundle_items row per
 * item (with position/category/replacement_group), then marks the
 * request completed — same shape as styleRequestAdmin.ts's own
 * createBundleForRequest, reused here rather than duplicated logic for
 * "what does completing a request look like."
 */
export async function saveGeneratedBundle(
  requestId: string,
  userId: string,
  title: string,
  bundle: GeneratedBundle,
): Promise<{ error?: string; bundleId?: string }> {
  const adminSupabase = createAdminClient();

  const { data: bundleRow, error: bundleError } = await adminSupabase
    .from("styled_bundles")
    .insert({
      request_id: requestId,
      title,
      description: bundle.analysis.outfitDescription,
      preview_image: bundle.previewImage,
      item_subtotal: bundle.pricing.itemSubtotal,
      mavelle_fee: bundle.pricing.mavelleFee,
      total_price: bundle.pricing.totalPrice,
      estimated_delivery_start: bundle.delivery.start.toISOString().slice(0, 10),
      estimated_delivery_end: bundle.delivery.end.toISOString().slice(0, 10),
      status: "ready",
    })
    .select("id")
    .single();

  if (bundleError || !bundleRow) {
    return { error: bundleError?.message ?? "Couldn't save the generated bundle." };
  }

  const { error: itemsError } = await adminSupabase.from("styled_bundle_items").insert(
    bundle.items.map((entry) => ({
      bundle_id: bundleRow.id,
      listing_id: entry.listing.id,
      position: entry.position,
      category: entry.category,
      replacement_group: entry.replacementGroup,
    })),
  );

  if (itemsError) {
    await adminSupabase.from("styled_bundles").delete().eq("id", bundleRow.id);
    return { error: itemsError.message };
  }

  await adminSupabase.from("style_requests").update({ status: "completed" }).eq("id", requestId).eq("user_id", userId);

  return { bundleId: bundleRow.id };
}

// ---------------------------------------------------------------------------
// Asynchronous generation — the user-facing path submitStyleRequest now
// uses (src/app/actions/style-requests.ts): create an empty, visible
// bundle row FIRST so the user can be redirected to /bundle/{id}
// immediately, then run the actual (slow) pipeline afterward, writing
// each item as soon as it's found rather than all-at-once at the end.
// generateBundleForRequest/saveGeneratedBundle above are UNCHANGED and
// still used by the admin preview flow (src/lib/styleRequestAdmin.ts) —
// this is a second, independent way to arrive at the same
// styled_bundles/styled_bundle_items shape, not a replacement.
//
// HOW THIS ACTUALLY RUNS: runBundleGenerationAsync is called WITHOUT
// being directly awaited (see submitStyleRequest's own comment) —
// deliberately, so the request can redirect immediately instead of
// blocking on the full pipeline. This app IS deployed on Vercel
// serverless Functions, which freeze/tear down compute the instant a
// response is sent — a real, confirmed production bug this caused
// ("Style Bundle" getting stuck at status='generating' forever, since
// the fire-and-forget call was killed mid-flight right after redirect()
// sent its response). Fixed by wrapping the call in `after()` (Next.js's
// built-in equivalent to a serverless waitUntil) at the call site in
// style-requests.ts — that's what actually keeps this function running
// to completion past the response, not anything in this file itself.
// ---------------------------------------------------------------------------

/**
 * Step 1 of the async flow: just enough of a styled_bundles row to
 * redirect to and poll — status 'generating', no items, no pricing yet.
 */
export async function createGeneratingBundle(requestId: string): Promise<{ bundleId?: string; error?: string }> {
  const adminSupabase = createAdminClient();

  const { data: bundleRow, error } = await adminSupabase
    .from("styled_bundles")
    .insert({
      request_id: requestId,
      title: "Your Lockette Bundle",
      status: "generating",
      generation_step: "starting",
      generation_progress: 5,
      attempt_count: 1,
      last_attempt_at: new Date().toISOString(),
    })
    .select("id")
    .single();

  if (error || !bundleRow) {
    return { error: error?.message ?? "Couldn't start bundle generation." };
  }

  return { bundleId: bundleRow.id };
}

/**
 * Step 2: the actual pipeline, run detached from the request that
 * triggered it (see this section's own header comment). Every detected
 * item is searched/embedded/ranked CONCURRENTLY (Promise.allSettled, not
 * a sequential loop) and its styled_bundle_items row is inserted the
 * moment it's found — genuinely progressive, not "wait for everything
 * then reveal it all at once." Pricing/delivery/preview and the final
 * status flip to 'ready' only happen once every item has settled.
 * Failure at any stage (no photos, failed analysis, zero matches) sets
 * status = 'error' with a real reason in generation_error instead of
 * leaving the bundle stuck on 'generating' forever. Never throws — this
 * runs with no caller left to catch anything.
 */
export async function runBundleGenerationAsync(requestId: string, bundleId: string, userId: string): Promise<void> {
  const adminSupabase = createAdminClient();

  async function fail(reason: string): Promise<void> {
    console.error(`[bundle-generation] Async generation failed for bundle ${bundleId}:`, reason);
    await adminSupabase
      .from("styled_bundles")
      .update({ status: "error", generation_step: "failed", generation_error: reason })
      .eq("id", bundleId);
  }

  try {
    const { data: request, error: requestError } = await adminSupabase
      .from("style_requests")
      .select("inspo_text, inspo_images, budget, categories")
      .eq("id", requestId)
      .maybeSingle();

    if (requestError || !request) {
      await fail("Style request not found.");
      return;
    }

    // Progress tracking — request fetched, about to run vision analysis.
    await adminSupabase
      .from("styled_bundles")
      .update({ generation_step: "analyzing_inspiration", generation_progress: 20 })
      .eq("id", bundleId);

    const imageUrls = await getSignedStyleRequestImageUrls(adminSupabase, request.inspo_images ?? []);
    if (imageUrls.length === 0) {
      await fail("This request has no inspiration photos to analyze.");
      return;
    }

    const analysis = await analyzeBundleInspiration({
      imageUrls,
      inspoText: request.inspo_text,
      categories: request.categories ?? [],
      budget: request.budget,
    });

    // Only a genuine processing failure is a hard error — see
    // generateBundleForRequest's identical comment above this same check.
    if (!analysis) {
      await fail("We couldn't process the inspiration photo(s). Please try again.");
      return;
    }

    // Vibe-based fallback when nothing confident was detected — see
    // generateBundleForRequest's identical comment for the full rationale.
    const detectedItems = analysis.detectedItems.length > 0 ? analysis.detectedItems : buildVibeFallbackItems(analysis);

    // Real outfit description as soon as it's known — the bundle page
    // polling for updates can show this well before any item arrives.
    // Also marks progress: vision analysis done, about to search/rank items.
    await adminSupabase
      .from("styled_bundles")
      .update({
        description: analysis.outfitDescription,
        generation_step: "searching_items",
        generation_progress: 40,
      })
      .eq("id", bundleId);

    const queryImageEmbedding = await generateImageEmbedding(imageUrls[0]);
    const style = analysis.aesthetic.join(" ");
    const perItemBudgets = allocateBudgetPerItem(detectedItems, request.budget);

    const settled = await Promise.allSettled(
      detectedItems.map(async (item, index) => {
        const listing = await findBestMatchForItem(adminSupabase, item, style, queryImageEmbedding, perItemBudgets[index]);
        if (!listing) return null;

        // Inserted immediately, one item at a time — this is what makes
        // polling see items appear progressively instead of all at once.
        await adminSupabase.from("styled_bundle_items").insert({
          bundle_id: bundleId,
          listing_id: listing.id,
          position: index,
          category: item.category,
          replacement_group: item.category,
        });

        return { listing, category: item.category };
      }),
    );

    const foundItems = settled
      .filter(
        (result): result is PromiseFulfilledResult<{ listing: Listing; category: GarmentCategory } | null> =>
          result.status === "fulfilled",
      )
      .map((result) => result.value)
      .filter((value): value is { listing: Listing; category: GarmentCategory } => value !== null);

    if (foundItems.length === 0) {
      await fail("Couldn't find enough matching items for this outfit yet. Try again in a bit, or submit a new style request with a different photo.");
      return;
    }

    // Progress tracking — every detected item has been searched AND
    // ranked (findBestMatchForItem does both together per item, this
    // codebase doesn't have them as separate global phases), about to
    // compute pricing/delivery/layout.
    await adminSupabase
      .from("styled_bundles")
      .update({ generation_step: "ranking_matches", generation_progress: 60 })
      .eq("id", bundleId);

    const pricing = calculateBundlePricing(foundItems.map((entry) => entry.listing.price ?? 0));
    const sellerPlatforms = foundItems.map((entry) => (entry.listing.platform?.toLowerCase() ?? "reworn") as MarketplaceSource);
    const delivery = estimateBundleDelivery(sellerPlatforms, foundItems.length, new Date());
    const layout = buildOutfitPreviewLayout(
      foundItems.map((entry, index) => ({
        listingId: entry.listing.id,
        category: entry.category,
        garmentType: entry.category,
        title: entry.listing.title,
        imageUrl: entry.listing.image_url,
        price: entry.listing.price,
        position: index,
      })),
    );
    const previewImage = layout.tiles.find((tile) => tile.imageUrl)?.imageUrl ?? null;

    // Progress tracking — pricing/delivery/layout computed, about to
    // persist the final, ready bundle.
    await adminSupabase
      .from("styled_bundles")
      .update({ generation_step: "building_preview", generation_progress: 80 })
      .eq("id", bundleId);

    await adminSupabase
      .from("styled_bundles")
      .update({
        preview_image: previewImage,
        item_subtotal: pricing.itemSubtotal,
        mavelle_fee: pricing.mavelleFee,
        total_price: pricing.totalPrice,
        estimated_delivery_start: delivery.start.toISOString().slice(0, 10),
        estimated_delivery_end: delivery.end.toISOString().slice(0, 10),
        status: "ready",
        generation_step: "complete",
        generation_progress: 100,
      })
      .eq("id", bundleId);

    await adminSupabase.from("style_requests").update({ status: "completed" }).eq("id", requestId).eq("user_id", userId);
  } catch (error) {
    await fail(error instanceof Error ? error.message : String(error));
  }
}
