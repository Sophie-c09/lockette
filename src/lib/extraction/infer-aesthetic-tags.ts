// Fallback tag inference: runs only when clean-description.ts's
// hashtag-based extraction found nothing (many real listings simply don't
// use hashtags, or all of theirs got excluded as brand/promo/location
// noise). Guarantees aesthetic_tags is never empty, which matters beyond
// cosmetics — match-scoring.ts's styleScore/likesScore can only ever be
// non-zero for a listing that has at least one tag to compare.

// Mirrors listing-classification.ts's AESTHETIC_TAG_VOCABULARY in spirit,
// but kept independent — that file (the AI classifier) is out of scope
// here, and this needs to work with zero I/O regardless of whether
// OPENAI_API_KEY is even configured.
const AESTHETIC_KEYWORDS = [
  "Y2K",
  "Vintage",
  "90s",
  "2000s",
  "Streetwear",
  "Old Money",
  "Coquette",
  "Cottagecore",
  "Grunge",
  "Minimalist",
  "Preppy",
  "Boho",
  "Balletcore",
  "Punk",
];

// Generic item-type tags derived from category text when no aesthetic
// keyword is present anywhere in the title/description either — a category
// like "Women T-shirts" doesn't say anything about vibe, but it does at
// least give a genuine, non-arbitrary tag to work with.
const CATEGORY_FALLBACK_TAGS: Array<{ pattern: RegExp; tag: string }> = [
  { pattern: /dress/i, tag: "#Dresses" },
  { pattern: /jean|denim/i, tag: "#Denim" },
  { pattern: /jacket|coat|outerwear/i, tag: "#Outerwear" },
  { pattern: /skirt/i, tag: "#Skirts" },
  { pattern: /sweater|knit|jumper|cardigan/i, tag: "#Knitwear" },
  { pattern: /short/i, tag: "#Shorts" },
  { pattern: /top|shirt|blouse|tee|tank|cami/i, tag: "#Tops" },
  { pattern: /shoe|boot|sneaker|sandal|heel/i, tag: "#Shoes" },
  { pattern: /bag|purse/i, tag: "#Bags" },
  { pattern: /accessor|jewel/i, tag: "#Accessories" },
];

function toBrandTag(brand: string): string | null {
  const cleaned = brand.replace(/[^a-z0-9]/gi, "");
  return cleaned ? `#${cleaned}` : null;
}

export interface InferTagsContext {
  title: string;
  description: string | null;
  category: string | null;
  brand: string | null;
}

/**
 * Best-effort aesthetic tags when none were found via hashtags. Tier 1:
 * known aesthetic keywords appearing anywhere in the title/description
 * text (not just as hashtags). Tier 2: a generic tag derived from category,
 * plus a brand tag. Tier 3 (absolute last resort): generic thrift tags —
 * this function never returns an empty array.
 */
export function inferAestheticTags(context: InferTagsContext, maxTags = 3): string[] {
  const haystack = `${context.title} ${context.description ?? ""}`.toLowerCase();

  const found: string[] = [];
  for (const keyword of AESTHETIC_KEYWORDS) {
    const pattern = new RegExp(`\\b${keyword.toLowerCase()}\\b`);
    if (pattern.test(haystack)) {
      found.push(`#${keyword}`);
      if (found.length >= maxTags) return found;
    }
  }
  if (found.length > 0) return found;

  if (context.category) {
    const match = CATEGORY_FALLBACK_TAGS.find(({ pattern }) => pattern.test(context.category!));
    if (match) found.push(match.tag);
  }
  if (context.brand) {
    const brandTag = toBrandTag(context.brand);
    if (brandTag) found.push(brandTag);
  }
  if (found.length > 0) return found.slice(0, maxTags);

  return ["#Thrifted", "#Preloved"];
}
