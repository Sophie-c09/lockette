// Shared per-item garment detection shape for both AI-vision outfit
// features — "Recreate This Outfit" (src/lib/outfit-classification.ts,
// one photo) and "Style Me" (src/lib/style-me-classification.ts, several
// aggregated photos). Both used to output only a coarse category list
// (e.g. "top"/"bottom"/"layer" — no accessories/bags/shoes vocabulary at
// all for Recreate This Outfit) plus a loose "vibe" signal, which is why
// results used to favor generic aesthetic matches (any pair of jeans)
// over the actual garment the photo showed (a specific skirt), and
// silently dropped whole categories of item (bags, accessories,
// outerwear) the old vocabulary couldn't even name — or the vision
// prompt didn't insist on looking for. Every detected item now carries
// enough structured, concrete detail (specific garment type, color,
// pattern, material, silhouette, era, notable visual details,
// ready-to-use resale search queries) for src/lib/garment-matching.ts to
// rank real listings against the actual item, not just the outfit's
// overall aesthetic. `bags` is split out from `accessories` as its own
// category (src/lib/bulk-import.ts's CategoryBucket does the same) so a
// detected purse/backpack is matched against real bag listings
// specifically, not lumped in with jewelry/belts/scarves.
export const GARMENT_CATEGORIES = [
  "tops",
  "dresses",
  "bottoms",
  "outerwear",
  "shoes",
  "bags",
  "accessories",
] as const;

export type GarmentCategory = (typeof GARMENT_CATEGORIES)[number];

export interface DetectedGarment {
  // Coarse slot (matches src/lib/bulk-import.ts's CategoryBucket, minus
  // "other" — a detected item should always resolve to a real slot).
  category: GarmentCategory;
  // The specific, concrete garment name (e.g. "mini skirt", "straight-leg
  // jeans", "crossbody bag") — NOT a repeat of `category`. This is the
  // single strongest signal src/lib/garment-matching.ts uses, since two
  // items can share a coarse category (a skirt and jeans are both
  // "bottoms") but should rank very differently against each other.
  garmentType: string;
  description: string;
  color: string;
  // null (not omitted) when the model can't tell — OpenAI structured
  // outputs want every field present, so "unknown" is a real value here,
  // not a missing key.
  pattern: string | null;
  material: string | null;
  silhouette: string;
  era: string | null;
  // Notable specifics beyond the general `description` — buttons,
  // hardware, logos, trim, distressing, embellishments, etc. — null if
  // nothing stands out beyond the basic look. Primarily for detection
  // richness/future display; not currently a scoring input in
  // src/lib/garment-matching.ts (a full free-text phrase rarely appears
  // verbatim in a listing's title/description the way a single concrete
  // term like garmentType/color does).
  visualDetails: string | null;
  // 2-4 short phrases optimized for searching Depop/Vinted/Poshmark/
  // Mercari/eBay for this SPECIFIC item — used as an additional
  // term-overlap signal in scoring, on top of garmentType/color/etc.
  searchQueries: string[];
}
