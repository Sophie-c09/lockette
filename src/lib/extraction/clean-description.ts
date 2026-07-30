// Cleans a raw marketplace description (Depop/Vinted/etc.) into something
// Lockette-friendly: strips seller-communication chatter that has no
// meaning here (Lockette has no seller messaging), and pulls out
// whatever structured signal (brand/size/style hashtags) the free text
// happens to contain. Pure string processing — no I/O, no network, no LLM
// call (that's classifyListing, run separately after this).
//
// Sits between extraction and classification:
//   URL -> Extraction -> Clean description -> Classification -> Save listing
// (wired in from src/lib/listing-extraction.ts).

export interface CleanedListingDescription {
  description: string | null;
  brand: string | null;
  size: string | null;
  aestheticTags: string[];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// Seller-communication / marketplace-logistics noise removal
// ---------------------------------------------------------------------------

// Each pattern is matched case-insensitively; when removed, any immediately
// *trailing* run of non-ASCII-alphanumeric characters is swept away with it
// (emoji, stray punctuation, decorative symbols) so cleanup doesn't leave
// orphaned "💌" or "!" floating where the phrase used to be. Deliberately
// ASCII-only for what counts as "real content" here — it's what lets this
// also sweep up decorative non-Latin flourish characters some listings use
// as bullets, without touching normal prose.
const NOISE_PHRASE_PATTERNS: RegExp[] = [
  /\bdm\s+me\b/gi,
  /\bdm\s+for\s+(?:any\s+)?questions?\b/gi,
  /\bmessage\s+me\b/gi,
  /\bsend\s+me\s+a\s+message\b/gi,
  /\bpm\s+me\b/gi,
  /\bcontact\s+me\b/gi,
  /\bask\s+(?:me\s+)?any\s+questions?\b/gi,
  /\bfeel\s+free\s+to\s+message(?:\s+me)?\b/gi,
  /\bmessage\s+(?:me\s+)?for\s+measurements?\b/gi,
  /\boffers?\s+via\s+dm\b/gi,
  // Not literally "seller communication," but the same category of
  // marketplace logistics chatter that isn't about the item itself.
  /\bno\s+international\s+shipping\b/gi,
  // Bundle-marketing chatter (Style-Aware Admin Scraper's Step 9) — the
  // only prior precedent for stripping these exact phrases was
  // ListingDetailView.tsx's local cleanDescription(), which is
  // display-only and never persisted. Added here instead so every
  // scraped listing (not just this display) gets them removed for real,
  // before saving.
  /\bbundle[s]?\s+(available|only|deal)\b/gi,
  /\bdm\s+for\s+bundle[s]?\b/gi,
  /\bdiscount\s+on\s+bundle[s]?\b/gi,
];

function stripNoisePhrases(text: string): { text: string; removed: boolean } {
  let result = text;
  let removed = false;

  for (const pattern of NOISE_PHRASE_PATTERNS) {
    const withTrailingDecoration = new RegExp(
      `${pattern.source}[^A-Za-z0-9]*`,
      pattern.flags,
    );
    if (withTrailingDecoration.test(result)) removed = true;
    result = result.replace(withTrailingDecoration, "");
  }

  return { text: result, removed };
}

// ---------------------------------------------------------------------------
// Hashtags -> brand candidate / aesthetic tags
// ---------------------------------------------------------------------------

const HASHTAG_PATTERN = /#(\w+)/g;

function extractHashtags(text: string): string[] {
  return [...text.matchAll(HASHTAG_PATTERN)].map((match) => match[1]);
}

function stripHashtags(text: string): string {
  return text.replace(/\s*#\w+/g, "");
}

// Non-exhaustive on purpose — covers common thrift/fashion resale brands
// well enough to be useful; classifyListing (OpenAI) is the authoritative
// brand source when it's configured, this is just a free, offline fallback.
const KNOWN_BRANDS = [
  "Hollister",
  "Abercrombie & Fitch",
  "Abercrombie",
  "American Eagle",
  "Urban Outfitters",
  "Brandy Melville",
  "Free People",
  "Anthropologie",
  "Levi's",
  "Levis",
  "Wrangler",
  "Carhartt",
  "Patagonia",
  "The North Face",
  "Nike",
  "Adidas",
  "Champion",
  "Vans",
  "Converse",
  "Dr. Martens",
  "Doc Martens",
  "Coach",
  "Ralph Lauren",
  "Tommy Hilfiger",
  "Calvin Klein",
  "Guess",
  "Zara",
  "H&M",
  "Forever 21",
  "Gap",
  "Old Navy",
  "Victoria's Secret",
  "Lululemon",
  "Aritzia",
  "Topshop",
  "ASOS",
  "Reformation",
  "Juicy Couture",
  "Von Dutch",
  "Ed Hardy",
  "True Religion",
  "Diesel",
  "Baby Phat",
  "BAPE",
];

// Exported for reuse by generate-title.ts, which needs the same
// brand-recognition logic to both surface a listing's brand and strip its
// mention out of the item-type phrase it derives.
export function findKnownBrand(text: string): string | null {
  for (const brand of KNOWN_BRANDS) {
    const pattern = new RegExp(`\\b${escapeRegExp(brand.toLowerCase())}\\b`, "i");
    if (pattern.test(text)) return brand;
  }
  return null;
}

// Hashtags that are seller handles, generic promo, or location noise rather
// than a useful style tag — non-exhaustive heuristic stoplist.
const EXCLUDED_TAG_WORDS = new Set([
  "sale",
  "clearance",
  "discount",
  "deal",
  "deals",
  "bundle",
  "follow",
  "like4like",
  "f4f",
  "shopmycloset",
  "closet",
  "shop",
  "freeshipping",
  "new",
  "nyc",
  "la",
  "ny",
  "usa",
  "us",
  "uk",
  "atl",
  "chicago",
  "losangeles",
  "newyork",
  "california",
  "texas",
  "florida",
  "london",
]);

// Exported for reuse by src/lib/listing-hashtags.ts (same reasoning as
// formatTag above).
export function isExcludedTag(tag: string): boolean {
  return EXCLUDED_TAG_WORDS.has(tag.toLowerCase());
}

const TAG_SPECIAL_CASE: Record<string, string> = {
  y2k: "Y2K",
};

// Exported for reuse by src/lib/listing-hashtags.ts, which needs
// user-submitted "#y2k #lowrise" hashtags stored in exactly this same
// `#Capitalized` convention aesthetic_tags already uses everywhere else —
// a mismatched convention would silently break tag-overlap scoring for
// user-submitted listings only (see src/lib/match-scoring.ts).
export function formatTag(tag: string): string {
  const lower = tag.toLowerCase();
  if (lower in TAG_SPECIAL_CASE) return `#${TAG_SPECIAL_CASE[lower]}`;
  if (/^[a-z]/.test(lower)) {
    return `#${lower.charAt(0).toUpperCase()}${lower.slice(1)}`;
  }
  return `#${tag}`;
}

// ---------------------------------------------------------------------------
// Size extraction
// ---------------------------------------------------------------------------

const SIZE_LETTER_ALT = "xxs|xxl|xs|xl|s|m|l";
const SIZE_WORD_ALT = "extra small|extra large|small|medium|large|one size";
const SIZE_TOKEN = `(?:${SIZE_LETTER_ALT}|${SIZE_WORD_ALT})`;

const LABELED_SIZE_PATTERN = new RegExp(
  `\\b(?:size|sz|sized)\\s*[:\\-]?\\s*(${SIZE_TOKEN}(?:\\s*/\\s*(?:${SIZE_LETTER_ALT}))?)\\b`,
  "i",
);

const STANDALONE_SIZE_PATTERN = new RegExp(
  `^${SIZE_TOKEN}(?:\\s*/\\s*(?:${SIZE_LETTER_ALT}))?$`,
  "i",
);

const SIZE_LETTER_CASE: Record<string, string> = {
  xxs: "XXS",
  xs: "XS",
  s: "S",
  m: "M",
  l: "L",
  xl: "XL",
  xxl: "XXL",
};

const SIZE_WORD_CASE: Record<string, string> = {
  "extra small": "Extra Small",
  "extra large": "Extra Large",
  small: "Small",
  medium: "Medium",
  large: "Large",
  "one size": "One Size",
};

function normalizeSizeToken(raw: string): string {
  const lower = raw.trim().toLowerCase();
  return SIZE_LETTER_CASE[lower] ?? SIZE_WORD_CASE[lower] ?? raw.toUpperCase();
}

function normalizeSizeValue(raw: string): string {
  return raw
    .split("/")
    .map((part) => normalizeSizeToken(part))
    .join("/");
}

function extractAndStripSize(input: string): { text: string; size: string | null } {
  const labeled = input.match(LABELED_SIZE_PATTERN);
  if (labeled) {
    const size = normalizeSizeValue(labeled[1]);
    const stripPattern = new RegExp(`${escapeRegExp(labeled[0])}[^A-Za-z0-9]*`, "i");
    return { text: input.replace(stripPattern, ""), size };
  }

  // Fallback: a bare, unlabeled size mention standing as its own "- ... -"
  // clause (e.g. "- XS/S -" or the whole description just being "Medium"),
  // rather than following a "size"/"sz" label.
  const segments = input.split(/\s*-\s*/);
  for (let i = 0; i < segments.length; i++) {
    const trimmed = segments[i].trim();
    if (trimmed && STANDALONE_SIZE_PATTERN.test(trimmed)) {
      const size = normalizeSizeValue(trimmed);
      const remaining = [...segments.slice(0, i), ...segments.slice(i + 1)]
        .filter(Boolean)
        .join(" - ");
      return { text: remaining, size };
    }
  }

  return { text: input, size: null };
}

// ---------------------------------------------------------------------------
// Final whitespace/punctuation cleanup
// ---------------------------------------------------------------------------

function finalCleanup(text: string): string {
  return text
    .replace(/\s{2,}/g, " ")
    .replace(/^[\s\-–—,:;|]+/, "")
    .replace(/[\s\-–—,:;|]+$/, "")
    .trim();
}

function logCleaning(originalLength: number, cleanedLength: number, removedPhrases: boolean): void {
  console.log("[description-cleaner]");
  console.log(`Original length: ${originalLength}`);
  console.log(`Cleaned length: ${cleanedLength}`);
  console.log(`Removed phrases: ${removedPhrases}`);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function cleanListingDescription(
  description: string | null,
): CleanedListingDescription {
  if (!description || !description.trim()) {
    return { description: null, brand: null, size: null, aestheticTags: [] };
  }

  const originalLength = description.length;

  const hashtags = extractHashtags(description);
  let text = stripHashtags(description);

  let brand: string | null = null;
  const aestheticTags: string[] = [];
  for (const tag of hashtags) {
    const knownBrand = findKnownBrand(tag);
    if (knownBrand) {
      brand = brand ?? knownBrand;
      continue;
    }
    if (isExcludedTag(tag)) continue;
    aestheticTags.push(formatTag(tag));
  }

  const sizeResult = extractAndStripSize(text);
  text = sizeResult.text;

  const noiseResult = stripNoisePhrases(text);
  text = noiseResult.text;

  if (!brand) {
    brand = findKnownBrand(text);
  }

  text = finalCleanup(text);

  logCleaning(originalLength, text.length, noiseResult.removed);

  return {
    description: text || null,
    brand,
    size: sizeResult.size,
    aestheticTags,
  };
}
