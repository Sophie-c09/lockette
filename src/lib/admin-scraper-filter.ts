// Scoring + ranking pipeline for the admin scraper — replaces the old
// hard reject/threshold pipeline (price cap, style-score/image-score
// minimums, banned words, brand mode, category filter, low-rise/bottoms
// check, learning-memory negative reject). Architecture change: nothing
// gets rejected here anymore for being a weak style/price/brand match —
// every candidate that clears the admission gate gets imported as
// 'active'/'flagged' with a numeric relevance score attached
// (src/lib/listing-score.ts) instead. Discover ranks by that score (score
// desc, created_at desc — see discover-feed.ts) rather than the scraper
// deciding in advance what's "good enough."
//
// The admission gate itself lives in src/lib/listing-quality.ts
// (scoreListingQuality/QUALITY_REJECTION_THRESHOLD), not in this file —
// this used to also export passesMinimalQualityFilters/
// minimalQualityFilterFailureReason, a blunt binary check (a real title
// AND at least 2 photos, nothing else considered). That gate rejected a
// listing with 1 great photo and otherwise-complete data exactly the same
// as one with 0 photos and nothing else, which Bulk Importer's own AI-
// weighted quality score never did — removed once admin-scraper.ts
// switched to that same shared gate (Inventory Growth/Bulk Importer
// architecture-parity fix), rather than left in place unused.
//
// What this means for AdminScraperFilterOptions' maxPrice/minStyleScore/
// minImageScore/brandMode/categoryFilter fields below: they're kept on
// the type (and the admin panel's own form controls, and
// scraper-config.ts's defaults) so nothing else has to change shape, but
// none of them are read by this file anymore — they no longer affect
// which candidates get imported. See admin-scraper.ts's own comment on
// this same point.
//
// Style/image classification is still computed and stored (aesthetic
// tags, brand, category, style_score/matched_style, image_score/tags/
// fit/aesthetic) — that data remains useful elsewhere in the app; it's
// just no longer used to gate admission the way it used to.
import { scoreListingStyle } from "./style-score";
import { calculateScore, type ScorableListing } from "./listing-score";
import type { ExtractedListing } from "@/lib/extraction/normalize-listing";

export interface AdminScraperFilterOptions {
  maxPrice: number;
  minStyleScore: number;
  minImageScore: number;
  brandMode: string[] | null;
  categoryFilter: string[] | null;
}

export interface StyleFilteredListing extends ExtractedListing {
  style_score: number;
  matched_style: string | null;
  image_score: number;
  image_tags: string[];
  fit_type: string;
  visual_aesthetic: string[];
  score: number;
}

/**
 * Attaches style_score/matched_style/image_score/image_tags/fit_type/
 * visual_aesthetic (still computed for other consumers — see this file's
 * own header comment) AND the new `score` ranking field
 * (src/lib/listing-score.ts) — never rejects. Callers are expected to
 * have already run the admission gate (src/lib/listing-quality.ts's
 * scoreListingQuality); this function assumes that's true and doesn't
 * re-check it.
 */
export function finalizeScoredListing(
  listing: ExtractedListing,
  imageData: { score: number; tags: string[]; fit: string; aesthetic: string[] },
): StyleFilteredListing {
  const { score: styleScore, style } = scoreListingStyle(listing);

  const scorable: ScorableListing = {
    title: listing.title,
    price: listing.price,
    images: listing.images,
    style,
  };
  const finalScore = calculateScore(scorable);

  console.log("Listing scored:", { title: listing.title, score: finalScore });

  return {
    ...listing,
    style_score: styleScore,
    matched_style: style,
    image_score: imageData.score,
    image_tags: imageData.tags,
    fit_type: imageData.fit,
    visual_aesthetic: imageData.aesthetic,
    score: finalScore,
  };
}
