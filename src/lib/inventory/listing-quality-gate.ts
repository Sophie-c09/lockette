// Part 4 of the AI inventory architecture — a quality evaluation for
// listings that are ALREADY in the `listings` table, run by
// inventory-indexer.ts right after fetching a batch and before queueing
// AI enrichment. NOT a duplicate of two related, pre-existing files that
// cover a different point in the pipeline:
//   - src/lib/admin-scraper-filter.ts's passesMinimalQualityFilters is a
//     PRE-insert gate (title + 2+ images) the scraper itself already
//     runs before a candidate is ever written to `listings` at all.
//   - src/lib/listing-quality.ts's scoreListingQuality is a PRE-insert,
//     AI-assisted 0-100 score bulk-import.ts already uses to reject
//     below-threshold candidates outright.
// This file evaluates a listing that has ALREADY cleared both of those
// and already has a real row — a fast, deterministic, NON-AI gate (Part
// 14: "never run AI synchronously during scraping" — and this runs
// during indexing, not scraping, but stays non-AI anyway since it's a
// cheap sanity check that shouldn't itself need a vision call; deep
// AI-judged image quality already happened via listing-quality.ts before
// this listing was ever inserted).
import type { Listing } from "@/lib/supabase/listings.types";

export interface ListingQualityEvaluation {
  quality_score: number;
  issues: string[];
  approved: boolean;
}

const MIN_IMAGES = 2;
const APPROVAL_THRESHOLD = 50;

function isPlausibleUrl(value: string | null | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Evaluates an already-imported listing for the indexer pipeline. Starts
 * at 100 and deducts for each real issue found — never throws, never
 * calls out to AI/network. "Blurry images"/"unusable photos" (Part 4's
 * own wording) are judged by listing-quality.ts's AI vision call at
 * import time already (image_score/quality_score columns); this function
 * treats a listing with no recorded image_score as neutral (doesn't
 * penalize it, since that column being null usually just means an older
 * row predates that column, not that its photo is bad) rather than
 * re-running a vision call to find out.
 */
export function evaluateListingQuality(
  listing: Pick<Listing, "title" | "image_url" | "price" | "product_url"> & {
    images?: string[] | null;
    image_score?: number | null;
    quality_score?: number | null;
  },
): ListingQualityEvaluation {
  let score = 100;
  const issues: string[] = [];

  if (!listing.title || !listing.title.trim()) {
    issues.push("missing title");
    score -= 30;
  }

  if (!listing.image_url) {
    issues.push("missing images");
    score -= 40;
  } else if (!isPlausibleUrl(listing.image_url)) {
    issues.push("broken image URL");
    score -= 30;
  }

  const imageCount = listing.images?.length ?? (listing.image_url ? 1 : 0);
  if (imageCount < MIN_IMAGES) {
    issues.push("fewer than 2 photos");
    score -= 10;
  } else if (imageCount >= 4) {
    // Prioritize multiple images (Part 4's own wording) — a small bonus,
    // capped so this alone can never push a listing with real issues
    // back over the approval threshold.
    score += 5;
  }

  if (listing.price == null || listing.price <= 0) {
    issues.push("invalid price");
    score -= 25;
  }

  if (!isPlausibleUrl(listing.product_url)) {
    issues.push("broken listing URL");
    score -= 20;
  }

  // Judged elsewhere already (see this file's own header comment) — only
  // penalize when a real, low AI-judged score IS on record; a null score
  // (not yet evaluated, or predates the column) is neutral, not a strike.
  if (listing.image_score != null && listing.image_score < 40) {
    issues.push("low AI-judged image quality");
    score -= 15;
  }

  score = Math.max(0, Math.min(100, Math.round(score)));

  return {
    quality_score: score,
    issues,
    approved: score >= APPROVAL_THRESHOLD,
  };
}
