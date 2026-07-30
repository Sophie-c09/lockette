// The second, orthogonal filter axis on /discover (?type=<slug>), matched
// against listings.category — a raw scraped string like "Women Tank tops"
// or "Women Straight jeans" — rather than aesthetic_tags, which is what
// the existing ?category=<slug> aesthetic filter matches (see
// aesthetic-categories.ts). Deliberately kept as a *separate* file/concept
// from that one even though both filters live on the same page: aesthetic
// ("Y2K", "Vintage") and item type ("Tops", "Jeans") are independent
// facets of the same listing, matched against two different columns, and
// combining them is exactly the point of this filter (see
// discover-feed.ts).
//
// Each type's `categoryKeywords` are ILIKE substrings, OR'd together —
// chosen and verified directly against the live `listings.category`
// data, not guessed. Two things worth calling out from that verification:
// - "shorts" (plural) is used, not "short" — "short" alone also matches
//   "Short-sleeved tops", which is a top, not a pair of shorts.
// - Outerwear and Shoes currently match zero real listings — this
//   72-row seed catalog (Vinted/Depop tops-and-dresses scrape) simply
//   doesn't contain any coats/jackets/shoes yet. The filter itself is
//   correct and will start returning results the moment matching
//   inventory is imported; it's not a bug in the matching logic.
export interface ItemTypeCategory {
  slug: string;
  label: string;
  categoryKeywords: string[];
}

export const ITEM_TYPE_CATEGORIES: ItemTypeCategory[] = [
  { slug: "tops", label: "Tops", categoryKeywords: ["top", "shirt", "blouse", "cami"] },
  { slug: "dresses", label: "Dresses", categoryKeywords: ["dress"] },
  { slug: "shorts", label: "Shorts", categoryKeywords: ["shorts"] },
  { slug: "jeans", label: "Jeans", categoryKeywords: ["jean"] },
  { slug: "outerwear", label: "Outerwear", categoryKeywords: ["jacket", "coat", "blazer", "outerwear"] },
  { slug: "shoes", label: "Shoes", categoryKeywords: ["shoe", "sneaker", "boot", "heel", "sandal"] },
];

export function getItemTypeCategoryBySlug(slug: string): ItemTypeCategory | undefined {
  const normalized = slug.trim().toLowerCase();
  return ITEM_TYPE_CATEGORIES.find((type) => type.slug === normalized);
}
