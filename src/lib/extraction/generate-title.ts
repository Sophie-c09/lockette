// Turns a raw/messy marketplace title (or, when that's unusable, the
// already-cleaned description) into a short structured title:
//
//   [Item Type] · [Brand]
//
// Pure string processing — no I/O, no LLM call (that's classifyListing,
// which runs *after* this in the pipeline; see listing-extraction.ts).
//
// Honest limitation: item-type detection is text-derived only. It can spot
// "cable knit long sleeve top" because those words are literally present in
// the source text, but it can't infer something like "straight leg" for a
// "Levi's 501" listing that never says "straight leg" anywhere — that
// would require actual product knowledge (or an LLM), not text parsing.
import { findKnownBrand } from "@/lib/extraction/clean-description";

export interface TitleSourceListing {
  title: string;
  description: string | null;
  category: string | null;
  brand: string | null;
  aesthetic_tags: string[];
}

const MAX_TITLE_LENGTH = 50;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// Noise: seller/logistics phrases, emoji, decorative symbols, punctuation
// ---------------------------------------------------------------------------

// Bare-word patterns (titles are short, so unlike clean-description.ts these
// don't need the fuller phrase variants — a lone "dm"/"message"/"offers"/
// "bundle" in a title is always marketplace chatter, never genuine content).
const NOISE_PATTERNS: RegExp[] = [
  /\bno\s+international\s+shipping\b/gi,
  /\bshipping\s+info\b/gi,
  /\bdm\b/gi,
  /\bmessage\b/gi,
  /\boffers?\b/gi,
  /\bbundle\b/gi,
];

function stripNoise(text: string): string {
  let result = text;
  for (const pattern of NOISE_PATTERNS) {
    // Sweep up trailing decoration (emoji, punctuation, and — as a side
    // effect — decorative non-ASCII "letter" characters some listings use
    // as bullets) the same way clean-description.ts does.
    const withTrailingDecoration = new RegExp(`${pattern.source}[^A-Za-z0-9]*`, pattern.flags);
    result = result.replace(withTrailingDecoration, "");
  }
  return result;
}

function stripSymbols(text: string): string {
  // \p{S} (Symbol) covers most emoji and decorative math/dingbat glyphs;
  // \p{Extended_Pictographic} catches the emoji that fall outside \p{S}.
  return text.replace(/[\p{S}\p{Extended_Pictographic}]/gu, " ");
}

// ---------------------------------------------------------------------------
// First clause: the item description is the opening clause of a listing —
// everything after a dash/pipe/newline/"with" is condition notes, flaws, or
// measurements, so only the opening clause is worth parsing for item type.
// ---------------------------------------------------------------------------

function firstClause(text: string): string {
  const cutIndex = text.search(/[-|\n]|\bwith\b/i);
  return cutIndex === -1 ? text : text.slice(0, cutIndex);
}

// ---------------------------------------------------------------------------
// Filler: condition/flaw/quality/aesthetic words that describe the listing
// rather than naming the item itself.
// ---------------------------------------------------------------------------

const FILLER_PHRASES = [
  "few holes",
  "small hole",
  "barely worn",
  "gently used",
  "like new",
  "perfect condition",
  "great condition",
  "good condition",
  "excellent condition",
  "no flaws",
  "no rips",
  "no stains",
  "must have",
  "so cute",
  "super cute",
];

function stripFillerPhrases(text: string): string {
  let result = text;
  for (const phrase of FILLER_PHRASES) {
    result = result.replace(new RegExp(escapeRegExp(phrase), "gi"), " ");
  }
  return result;
}

const FILLER_WORDS = new Set([
  "cute",
  "cozy",
  "amazing",
  "rare",
  "vintage",
  "y2k",
  "retro",
  "aesthetic",
  "trendy",
  "cool",
  "super",
  "so",
  "perfect",
  "great",
  "good",
  "nice",
  "lovely",
  "gorgeous",
  "stunning",
  "beautiful",
  "faded",
  "fading",
]);

// Plain colors are dropped (a color isn't the item type) — but a
// print/pattern word is kept, since it *is* part of how the item is
// described (e.g. "Floral Corset Dress" keeps "floral").
const PLAIN_COLORS = new Set([
  "black",
  "white",
  "red",
  "blue",
  "green",
  "yellow",
  "pink",
  "purple",
  "brown",
  "grey",
  "gray",
  "beige",
  "tan",
  "navy",
  "orange",
  "cream",
  "maroon",
  "burgundy",
  "olive",
]);

// ---------------------------------------------------------------------------
// Garment nouns: the item-type phrase must contain one of these to count as
// usable — otherwise the caller falls back to the next source (title ->
// description) instead of returning a phrase with no actual noun in it.
// ---------------------------------------------------------------------------

const GARMENT_NOUNS = [
  // compounds first so they're recognized as a unit
  "long sleeve top",
  "short sleeve top",
  "baby tee",
  "tank top",
  "tube top",
  "halter top",
  "crop top",
  "button up",
  "polo shirt",
  "denim jacket",
  "bomber jacket",
  // single words
  "top",
  "tee",
  "shirt",
  "blouse",
  "jeans",
  "pants",
  "trousers",
  "shorts",
  "skirt",
  "dress",
  "jacket",
  "coat",
  "vest",
  "hoodie",
  "sweater",
  "cardigan",
  "sweatshirt",
  "leggings",
  "romper",
  "jumpsuit",
  "overalls",
  "tank",
  "cami",
  "kimono",
  "poncho",
  "onesie",
  "bodysuit",
  "bra",
  "swimsuit",
  "bikini",
  "scarf",
  "hat",
  "beanie",
  "bag",
  "purse",
  "shoes",
  "boots",
  "sneakers",
  "sandals",
  "heels",
];

function containsGarmentNoun(phrase: string): boolean {
  const lower = phrase.toLowerCase();
  return GARMENT_NOUNS.some((noun) => new RegExp(`\\b${escapeRegExp(noun)}\\b`).test(lower));
}

// ---------------------------------------------------------------------------
// Item-type extraction
// ---------------------------------------------------------------------------

// Strips the brand's full name, and also its "core" name with a trailing
// corporate suffix removed (e.g. brand="Hollister Co." but the listing text
// itself just says "hollister top" — the fuller legal name from JSON-LD
// shouldn't stop the bare brand mention in the text from being recognized).
function coreBrandName(brand: string): string {
  return brand.replace(/\s+(co\.?|inc\.?|llc|ltd\.?)$/i, "").trim();
}

function stripBrandMention(text: string, brand: string): string {
  let result = text;
  const candidates = new Set([brand, coreBrandName(brand)]);
  for (const candidate of candidates) {
    if (!candidate) continue;
    const pattern = new RegExp(`\\b${escapeRegExp(candidate)}\\b[^A-Za-z0-9]*`, "gi");
    result = result.replace(pattern, " ");
  }
  return result;
}

function extractItemTypePhrase(rawText: string, brand: string | null): string | null {
  let text = firstClause(rawText);
  text = stripSymbols(text);
  text = stripNoise(text);
  if (brand) text = stripBrandMention(text, brand);
  text = stripFillerPhrases(text);
  text = text.replace(/[^\p{L}\p{N}\s]/gu, " ");

  const tokens = text
    .split(/\s+/)
    .map((word) => word.trim())
    .filter(Boolean)
    .filter((word) => !FILLER_WORDS.has(word.toLowerCase()))
    .filter((word) => !PLAIN_COLORS.has(word.toLowerCase()));

  const phrase = tokens.join(" ").trim();
  return phrase && containsGarmentNoun(phrase) ? phrase : null;
}

function toTitleCase(phrase: string): string {
  return phrase
    .split(/\s+/)
    .map((word) => (word ? word.charAt(0).toUpperCase() + word.slice(1).toLowerCase() : word))
    .join(" ");
}

function resolveItemType(listing: TitleSourceListing, brand: string | null): string {
  if (listing.category && listing.category.trim()) {
    const cleaned = extractItemTypePhrase(listing.category, brand);
    if (cleaned) return toTitleCase(cleaned);
  }

  const fromTitle = extractItemTypePhrase(listing.title, brand);
  if (fromTitle) return toTitleCase(fromTitle);

  if (listing.description) {
    const fromDescription = extractItemTypePhrase(listing.description, brand);
    if (fromDescription) return toTitleCase(fromDescription);
  }

  return "Item";
}

// ---------------------------------------------------------------------------
// Brand resolution
// ---------------------------------------------------------------------------

function resolveBrand(listing: TitleSourceListing): string | null {
  if (listing.brand) return listing.brand;

  for (const tag of listing.aesthetic_tags) {
    const found = findKnownBrand(tag.replace(/^#/, ""));
    if (found) return found;
  }

  return findKnownBrand(listing.title) ?? (listing.description ? findKnownBrand(listing.description) : null);
}

// ---------------------------------------------------------------------------
// Length limit
// ---------------------------------------------------------------------------

function truncateTitle(title: string, maxLength = MAX_TITLE_LENGTH): string {
  if (title.length <= maxLength) return title;

  const separatorIndex = title.lastIndexOf(" · ");
  if (separatorIndex === -1) return title.slice(0, maxLength).trim();

  const brandPart = title.slice(separatorIndex);
  const words = title.slice(0, separatorIndex).split(" ");

  // Drop the item type's leading (least distinctive) modifier words first —
  // the head noun sits at the end of the phrase, so it survives longest.
  while (words.length > 1 && `${words.join(" ")}${brandPart}`.length > maxLength) {
    words.shift();
  }

  const shortened = `${words.join(" ")}${brandPart}`;
  return shortened.length <= maxLength ? shortened : shortened.slice(0, maxLength).trim();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function generateCleanTitle(listing: TitleSourceListing): string {
  const brand = resolveBrand(listing);
  const itemType = resolveItemType(listing, brand);
  const title = brand ? `${itemType} · ${brand}` : itemType;
  return truncateTitle(title);
}
