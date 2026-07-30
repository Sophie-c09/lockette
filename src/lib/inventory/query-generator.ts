// Query diversification for Inventory Growth overnight/scaled discovery
// (src/lib/inventory/scaled-discovery.ts) — the actual fix for the
// climbing duplicate rate (62% -> 90% -> 93% across batches 1-3 of a real
// run, diagnosed against admin-scraper.ts's filterOutDuplicateCandidates).
// Root cause: marketplace-discovery.ts's SEARCH_TERMS is a small, fixed
// rotation (~50 terms) that every round/batch re-searches from page 1 —
// after a few rounds there's nothing new left to find with those exact
// terms, so discovery increasingly just re-surfaces listings already in
// the table. This module generates a much larger, deterministic space of
// search-term COMBINATIONS (style/aesthetic + decade/season + color/
// material + category) so a long-running overnight job has thousands of
// genuinely distinct queries to work through before it ever needs to
// repeat one — combined with discovery-history.ts (persisted "have we
// already crawled this query/page" tracking), a query is never re-crawled
// at all, let alone re-crawled at the same page.
//
// Pure — no I/O, no randomness (Math.random() would make "the next N
// unused queries" different every call, and non-deterministic ordering
// makes resuming after a restart impossible to reason about). Ordering is
// fixed once and for all by VOCAB's own array order; the only thing that
// changes which queries a caller gets back is which ones are already in
// its `excludeQueries` set.

const STYLE_ARCHETYPES = [
  "y2k",
  "coquette",
  "cottagecore",
  "indie sleaze",
  "streetwear",
  "grunge",
  "preppy",
  "boho",
  "dark academia",
  "balletcore",
  "gorpcore",
  "minimalist",
  // Added for discovery expansion (widen the query space once the
  // original vocabulary's own (query, page) combinations run dry) —
  // same "real, named subculture/aesthetic a real listing title would
  // plausibly use" bar as the original list.
  "fairycore",
  "clean girl",
  "old money",
  "art hoe",
  "kidcore",
  "mermaidcore",
  "softgirl",
  "e-girl",
] as const;

const CATEGORIES = [
  "top",
  "tank top",
  "cardigan",
  "sweater",
  "hoodie",
  "jacket",
  "blazer",
  "jeans",
  "shorts",
  "mini skirt",
  "midi skirt",
  "dress",
  "romper",
  "bag",
  "purse",
  "boots",
  "sneakers",
  "necklace",
  "scarf",
  // Added for discovery expansion (see STYLE_ARCHETYPES' own comment).
  "crop top",
  "sweatshirt",
  "vest",
  "pants",
  "skort",
  "jumpsuit",
  "kimono",
  "belt",
  "sunglasses",
  "flats",
  "heels",
] as const;

// A deliberately broad brand mix (fast-fashion through designer/vintage-
// collectible) — distinct from src/lib/selected-brands.ts's SelectedBrand
// (a narrow 3-option admin UI filter for a different feature); this list
// exists only to widen the query space, not to gate anything.
const BRANDS = [
  "abercrombie",
  "hollister",
  "american eagle",
  "brandy melville",
  "urban outfitters",
  "free people",
  "levi's",
  "coach",
  "ralph lauren",
  "nike",
  "adidas",
] as const;

const COLORS = [
  "black",
  "white",
  "cream",
  "brown",
  "pink",
  "blue",
  "green",
  "red",
  "beige",
  "lavender",
  "sage",
  // Added for discovery expansion (see STYLE_ARCHETYPES' own comment).
  "yellow",
  "orange",
  "purple",
  "grey",
  "mauve",
  "rust",
] as const;

const MATERIALS = [
  "denim",
  "leather",
  "suede",
  "lace",
  "satin",
  "velvet",
  "corduroy",
  "knit",
  "linen",
  "flannel",
  // Added for discovery expansion (see STYLE_ARCHETYPES' own comment).
  "chiffon",
  "mesh",
  "faux fur",
  "sequin",
  "tulle",
] as const;

// Overlaps in spirit with STYLE_ARCHETYPES (both describe a vibe) but
// kept as its own input per the spec — these read more like a mood/finish
// than a named subculture, and combining them with archetypes/materials
// widens the query space further (e.g. "romantic lace top").
const AESTHETICS = [
  "romantic",
  "edgy",
  "vintage",
  "retro",
  "cozy",
  "chic",
  "grunge-inspired",
  // Added for discovery expansion (see STYLE_ARCHETYPES' own comment).
  "whimsical",
  "sporty",
  "glam",
  "minimal",
] as const;

const SEASONS = ["spring", "summer", "fall", "winter"] as const;

const DECADES = ["70s", "80s", "90s", "2000s", "y2k"] as const;

// Every non-category vocab, grouped once so query-building can treat them
// uniformly ("one modifier + one category", "two modifiers + one
// category") without a wall of near-identical loops.
const MODIFIER_GROUPS: readonly (readonly string[])[] = [
  STYLE_ARCHETYPES,
  COLORS,
  MATERIALS,
  BRANDS,
  AESTHETICS,
  SEASONS,
  DECADES,
];

// "y2k cardigan", "cream vintage sweater", "coquette lace top", "90s
// leather jacket", "brown suede bag" (this feature's own worked examples)
// are all 2-3 word combinations, never a full cartesian product across
// every input dimension at once (which would produce unusable noise like
// "y2k 90s cream suede floral cottagecore cardigan spring under 10").
// Generated in two deterministic passes:
//   1. every (single modifier, category) pair, one pass per modifier
//      group, in MODIFIER_GROUPS order — e.g. all style+category, then
//      all color+category, then all material+category, etc.
//   2. every (aesthetic/style modifier, second color/material modifier,
//      category) triple, for the richer 3-word combinations the examples
//      also show ("cream vintage sweater").
// Both passes flow through a Set for de-duplication (a handful of exact
// string collisions are possible across groups) — order of first
// appearance is preserved, which is what makes this deterministic.
function buildAllQueries(): string[] {
  const seen = new Set<string>();

  for (const group of MODIFIER_GROUPS) {
    for (const modifier of group) {
      for (const category of CATEGORIES) {
        seen.add(`${modifier} ${category}`);
      }
    }
  }

  // Richer 3-word combinations: a style/aesthetic word + a color-or-
  // material word + a category — e.g. "coquette cream top", "grunge
  // suede jacket". Bounded to STYLE_ARCHETYPES x (COLORS+MATERIALS) x
  // CATEGORIES rather than every modifier group crossed with every other
  // (which would run into the tens of thousands and mostly produce
  // combinations no real seller's listing title would ever match) — this
  // alone is 12 x 21 x 19 = 4,788 combinations, already well past "hundreds/
  // thousands" on its own.
  const secondModifiers = [...COLORS, ...MATERIALS];
  for (const style of STYLE_ARCHETYPES) {
    for (const second of secondModifiers) {
      for (const category of CATEGORIES) {
        seen.add(`${style} ${second} ${category}`);
      }
    }
  }

  return [...seen];
}

// Computed once per process — pure function of the vocab constants above,
// so every caller (and every restart of the same process) sees the exact
// same list in the exact same order.
let cachedQueries: string[] | null = null;

/** The full, deterministically-ordered query space this generator can produce. */
export function allGeneratedQueries(): string[] {
  if (!cachedQueries) cachedQueries = buildAllQueries();
  return cachedQueries;
}

/**
 * The next `count` queries this run hasn't used yet, in stable order —
 * "track generated queries so they are not reused" is satisfied by the
 * caller passing in everything already recorded for this platform (see
 * discovery-history.ts's getProcessedQueries), not by any state kept
 * inside this module itself (which stays pure and restart-safe).
 */
export function nextUnusedQueries(excludeQueries: ReadonlySet<string>, count: number): string[] {
  const result: string[] = [];
  for (const query of allGeneratedQueries()) {
    if (result.length >= count) break;
    if (!excludeQueries.has(query)) result.push(query);
  }
  return result;
}

export const QUERY_GENERATOR_VOCAB = {
  styleArchetypes: STYLE_ARCHETYPES,
  categories: CATEGORIES,
  brands: BRANDS,
  colors: COLORS,
  materials: MATERIALS,
  aesthetics: AESTHETICS,
  seasons: SEASONS,
  decades: DECADES,
};
