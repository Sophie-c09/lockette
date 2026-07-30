// Part 5 of the AI inventory architecture — richer duplicate detection
// than admin-scraper.ts's own filterOutDuplicateCandidates (product URL +
// image URL + normalized-title EXACT match, run per-scrape-batch). This
// file is for the indexer (inventory-indexer.ts) to re-check ALREADY-
// INDEXED inventory over time — marketplace ID extraction, image content
// hashing, and FUZZY (not just exact) title similarity, each documented
// with its real, honest limitations rather than overclaiming.
import { createHash } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import type { ListingsDatabase } from "@/lib/supabase/listings.types";
import { normalizeTitleForDedup } from "@/lib/admin-scraper";

// ---------------------------------------------------------------------------
// Marketplace ID extraction — each source's listing URL embeds its own
// unique item id; this is what "marketplace ID" means in this codebase's
// extraction pipeline (see admin-scraper.ts's own comment: there is no
// separate marketplace_id column anywhere, product_url already serves
// that role). Patterns are best-effort per known source; an unrecognized
// URL shape returns null rather than a wrong guess.
// ---------------------------------------------------------------------------

const MARKETPLACE_ID_PATTERNS: Array<{ source: string; pattern: RegExp }> = [
  { source: "depop", pattern: /depop\.com\/products\/([a-zA-Z0-9-]+)/ },
  { source: "vinted", pattern: /vinted\.[a-z.]+\/items\/(\d+)/ },
  { source: "poshmark", pattern: /poshmark\.com\/listing\/[^/]*-([a-f0-9]{24})/ },
  { source: "ebay", pattern: /ebay\.com\/itm\/(?:[^/]+\/)?(\d+)/ },
  { source: "etsy", pattern: /etsy\.com\/listing\/(\d+)/ },
];

export function extractMarketplaceId(url: string | null): { source: string; externalId: string } | null {
  if (!url) return null;
  for (const { source, pattern } of MARKETPLACE_ID_PATTERNS) {
    const match = url.match(pattern);
    if (match?.[1]) return { source, externalId: match[1] };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Image "fingerprinting" — HONEST LIMITATION: this is a SHA-256 hash of
// the fetched image's raw bytes, not a true perceptual hash (pHash/
// average-hash over decoded pixels). It catches the exact same image file
// re-hosted under a different URL (a common real pattern — a reseller's
// photo scraped from two source pages, or reposted verbatim) but will NOT
// catch a re-compressed, re-cropped, resized, or watermarked copy of
// visually the same photo. A true perceptual hash needs an image-decoding
// library (sharp/jimp) this project doesn't currently depend on — adding
// one is the natural upgrade path if byte-identical hashing turns out to
// miss too many real duplicates in practice.
// ---------------------------------------------------------------------------

export async function computeImageHash(imageUrl: string | null): Promise<string | null> {
  if (!imageUrl) return null;
  try {
    const response = await fetch(imageUrl, { signal: AbortSignal.timeout(8_000) });
    if (!response.ok) return null;
    const bytes = new Uint8Array(await response.arrayBuffer());
    return createHash("sha256").update(bytes).digest("hex");
  } catch (error) {
    console.error("[duplicate-detection] Failed to hash image:", imageUrl, error);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Fuzzy title matching — token-set Jaccard similarity (shared tokens /
// total distinct tokens) after the same normalization admin-scraper.ts
// already uses. Catches "Vintage Levi 501 Jeans" vs "Levis Vintage 501
// Denim" (shared: vintage, levi(s)-stem, 501 — high overlap) via shared
// vocabulary alone. HONEST LIMITATION: this is a lexical/token-overlap
// heuristic, not semantic understanding — it won't recognize "jeans" and
// "denim" as the same concept unless enough OTHER tokens already overlap
// to carry the similarity score past the threshold; true synonym-aware
// matching would need an embedding-based comparison (its own AI call per
// pair), which Part 14 explicitly rules out running synchronously here.
// ---------------------------------------------------------------------------

function tokenize(title: string): Set<string> {
  return new Set(normalizeTitleForDedup(title).split(" ").filter((token) => token.length > 1));
}

export function titleSimilarity(a: string, b: string): number {
  const tokensA = tokenize(a);
  const tokensB = tokenize(b);
  if (tokensA.size === 0 || tokensB.size === 0) return 0;

  let shared = 0;
  for (const token of tokensA) {
    if (tokensB.has(token)) shared++;
  }

  const union = new Set([...tokensA, ...tokensB]).size;
  return union === 0 ? 0 : shared / union;
}

const FUZZY_TITLE_MATCH_THRESHOLD = 0.5;

export interface DuplicateCandidate {
  title: string;
  product_url: string | null;
  image_url: string | null;
}

export interface DuplicateCheckResult {
  isDuplicate: boolean;
  matchedListingId?: string;
  confidence: number;
}

/**
 * Checks one candidate against the live `listings` table. Bounded, not a
 * full-table scan (Part 14): the marketplace-ID and image-hash checks are
 * exact-match `.eq()` lookups (index-backed via listings_image_hash_idx,
 * schema.sql), and the fuzzy-title check only compares against a small
 * candidate set narrowed by the title's own most distinctive token (via
 * `ilike`), not every row in the table.
 */
export async function checkForDuplicate(
  candidate: DuplicateCandidate,
  excludeListingId?: string,
): Promise<DuplicateCheckResult> {
  const supabase = createAdminClient<ListingsDatabase>();

  // 1. Product URL — exact, highest confidence.
  if (candidate.product_url) {
    const { data } = await supabase
      .from("listings")
      .select("id")
      .eq("product_url", candidate.product_url)
      .neq("id", excludeListingId ?? "")
      .limit(1)
      .maybeSingle();
    if (data) return { isDuplicate: true, matchedListingId: data.id, confidence: 1 };
  }

  // 2. Marketplace ID extracted from the URL — a different product_url
  // string (e.g. with/without tracking params) can still embed the same
  // underlying item id.
  const marketplaceId = extractMarketplaceId(candidate.product_url);
  if (marketplaceId) {
    const { data } = await supabase
      .from("listings")
      .select("id, product_url")
      .ilike("product_url", `%${marketplaceId.externalId}%`)
      .neq("id", excludeListingId ?? "")
      .limit(5);

    const match = (data ?? []).find((row) => extractMarketplaceId(row.product_url)?.externalId === marketplaceId.externalId);
    if (match) return { isDuplicate: true, matchedListingId: match.id, confidence: 0.95 };
  }

  // 3. Image hash — same underlying photo, different listing entirely.
  const imageHash = await computeImageHash(candidate.image_url);
  if (imageHash) {
    const { data } = await supabase
      .from("listings")
      .select("id")
      .eq("image_hash", imageHash)
      .neq("id", excludeListingId ?? "")
      .limit(1)
      .maybeSingle();
    if (data) return { isDuplicate: true, matchedListingId: data.id, confidence: 0.9 };
  }

  // 4. Fuzzy title — narrowed by the longest token to keep this bounded.
  const tokens = Array.from(tokenize(candidate.title)).sort((a, b) => b.length - a.length);
  const anchorToken = tokens[0];
  if (anchorToken) {
    const { data } = await supabase
      .from("listings")
      .select("id, title")
      .ilike("title", `%${anchorToken}%`)
      .neq("id", excludeListingId ?? "")
      .limit(20);

    let best: { id: string; similarity: number } | null = null;
    for (const row of data ?? []) {
      const similarity = titleSimilarity(candidate.title, row.title);
      if (similarity >= FUZZY_TITLE_MATCH_THRESHOLD && (!best || similarity > best.similarity)) {
        best = { id: row.id, similarity };
      }
    }
    if (best) return { isDuplicate: true, matchedListingId: best.id, confidence: best.similarity };
  }

  return { isDuplicate: false, confidence: 0 };
}
