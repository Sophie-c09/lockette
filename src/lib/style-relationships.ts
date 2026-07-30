// Shared "aesthetics that feel similar to each other" map — used by both
// feed-scoring.ts (to give partial credit for related-but-not-identical
// styles, so a Y2K lover doesn't get 0% for a Vintage listing) and the
// extraction pipeline (to enrich a listing's aesthetic_tags with inferred
// related styles at import time, not just its literal hashtags). Pure, no
// I/O. Each relationship is listed once; areStylesRelated/getRelatedStyles
// check both directions, so declaring "y2k -> vintage" here also makes
// "vintage" resolve back to "y2k" without needing the reverse entry too.
export const STYLE_RELATIONSHIPS: Record<string, string[]> = {
  "y2k": ["vintage", "coquette", "indie sleaze", "streetwear"],
  "coquette": ["balletcore", "romantic", "vintage"],
  "grunge": ["indie sleaze", "vintage", "alternative"],
  "old money": ["minimalist", "classic", "clean girl"],
  "cottagecore": ["romantic", "boho", "vintage"],
  "streetwear": ["grunge", "punk"],
  "preppy": ["old money", "classic", "clean girl"],
  "boho": ["cottagecore", "romantic"],
  "punk": ["grunge", "alternative"],
  "balletcore": ["coquette", "romantic", "classic"],
};

function normalizeStyle(tag: string): string {
  return tag.trim().toLowerCase().replace(/^#/, "");
}

/** True if a and b are different but declared as related styles (either direction). */
export function areStylesRelated(a: string, b: string): boolean {
  const na = normalizeStyle(a);
  const nb = normalizeStyle(b);
  if (!na || !nb || na === nb) return false;
  return (STYLE_RELATIONSHIPS[na]?.includes(nb) ?? false) || (STYLE_RELATIONSHIPS[nb]?.includes(na) ?? false);
}

/** Every style related to `tag`, checking both directions of the map. */
export function getRelatedStyles(tag: string): string[] {
  const key = normalizeStyle(tag);
  if (!key) return [];

  const direct = STYLE_RELATIONSHIPS[key] ?? [];
  const reverse = Object.entries(STYLE_RELATIONSHIPS)
    .filter(([otherKey, related]) => otherKey !== key && related.includes(key))
    .map(([otherKey]) => otherKey);

  return [...new Set([...direct, ...reverse])];
}

function toTitleCase(word: string): string {
  return word.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

/**
 * Broadens a listing's tags with inferred related styles (e.g. a literal
 * "#Y2K" tag also implies the listing is plausibly Vintage/Coquette-
 * adjacent), so aesthetic_tags reflects more than just whatever literal
 * hashtags happened to be in the source text. Keeps all original tags
 * first, then fills remaining slots with related styles, deduped, capped
 * at maxTags.
 */
export function enrichWithRelatedStyles(tags: string[], maxTags = 5): string[] {
  const result: string[] = [];
  const seen = new Set<string>();

  function addTag(rawTag: string) {
    const key = normalizeStyle(rawTag);
    if (!key || seen.has(key)) return;
    seen.add(key);
    result.push(rawTag.startsWith("#") ? rawTag : `#${toTitleCase(rawTag)}`);
  }

  for (const tag of tags) addTag(tag);

  for (const tag of tags) {
    if (result.length >= maxTags) break;
    for (const related of getRelatedStyles(tag)) {
      if (result.length >= maxTags) break;
      addTag(toTitleCase(related));
    }
  }

  return result.slice(0, maxTags);
}
