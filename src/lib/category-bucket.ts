// Coarse, keyword-matched category bucketing — moved out of
// src/lib/bulk-import.ts into its own dependency-free module (Discover
// production-crash fix, commit 459b7de's regression): bulk-import.ts
// transitively imports @/lib/listing-extraction -> browser-extractor.ts,
// which does `import { chromium } from "playwright"` at module scope —
// exactly the same "native-binary package pulled into a real user-facing
// request path" crash already documented and fixed once before in this
// codebase for /api/admin-scraper/large-scale (see that route's own
// header comment). discover-style-vector.ts/discover-personalization.ts
// only ever needed this one pure function, not the rest of bulk-import.ts,
// so importing the whole module was pulling Playwright into every
// Discover page load/Server Action for no reason — this file has zero
// imports of its own, so nothing that imports it can transitively reach
// Playwright (or any other heavy dependency) through this path again.
// bulk-import.ts re-exports both from here so its own existing callers
// (garment-matching.ts, etc.) are unaffected.
export type CategoryBucket = "tops" | "dresses" | "bottoms" | "outerwear" | "accessories" | "bags" | "shoes" | "other";

export type CategoryCounts = Partial<Record<CategoryBucket, number>>;

// Checked in order — more specific/definitive keywords first so e.g. a
// "sweater dress" lands in dresses rather than tops.
const CATEGORY_BUCKET_KEYWORDS: [string, CategoryBucket][] = [
  ["dress", "dresses"],
  ["skirt", "bottoms"],
  ["jean", "bottoms"],
  ["denim", "bottoms"],
  ["trouser", "bottoms"],
  ["legging", "bottoms"],
  ["pant", "bottoms"],
  ["short", "bottoms"],
  ["jacket", "outerwear"],
  ["coat", "outerwear"],
  ["hoodie", "outerwear"],
  ["cardigan", "outerwear"],
  ["blazer", "outerwear"],
  ["windbreaker", "outerwear"],
  ["shoe", "shoes"],
  ["sneaker", "shoes"],
  ["boot", "shoes"],
  ["sandal", "shoes"],
  ["heel", "shoes"],
  ["bag", "bags"],
  ["purse", "bags"],
  ["backpack", "bags"],
  ["tote", "bags"],
  ["clutch", "bags"],
  // "tote" collides with the real fashion brand "Toteme" the same way
  // "hat" collided with "Baby Phat" below — a plain substring match would
  // misfile a Toteme sweater/coat as a bag whenever "coat"/"jacket" etc.
  // don't ALSO appear in the title. Fixed structurally (word-boundary
  // matching, see categorizeListing below) rather than by only patching
  // this one specific collision.
  ["jewelry", "accessories"],
  ["necklace", "accessories"],
  ["earring", "accessories"],
  ["bracelet", "accessories"],
  ["belt", "accessories"],
  ["scarf", "accessories"],
  ["sunglasses", "accessories"],
  // Deliberately NOT "hat" — verified live against this app's own
  // inventory that it's a substring of the real, common brand name "Baby
  // Phat" ("Phat".includes("hat")), which was silently miscategorizing
  // every Baby Phat top/tee as an accessory. This keyword-substring
  // matcher has no word-boundary check, so a short, common word like
  // "hat" is too easy to collide with an unrelated brand/word.
  ["camisole", "tops"],
  ["blouse", "tops"],
  ["sweater", "tops"],
  ["cami", "tops"],
  ["crop", "tops"],
  ["tank", "tops"],
  ["t-shirt", "tops"],
  ["tee", "tops"],
  ["shirt", "tops"],
  ["top", "tops"],
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// P0 launch-readiness fix — the previous plain `haystack.includes(keyword)`
// check had no boundary awareness at all, which is WHY "hat" had to be
// removed outright above rather than fixed (it collided with the real
// brand "Baby Phat" — "hat" as a SUFFIX of an unrelated word). The same
// class of bug exists on the other side too: "tote" is a substring PREFIX
// of the real fashion brand "Toteme," which a plain substring check
// misfiles as a bag.
//
// Deliberately a RIGHT-boundary check only (keyword not immediately
// followed by another letter, allowing a plain "s"/"es" plural suffix) —
// NOT a full `\bkeyword\b`. A full word-boundary would fix the Toteme
// class but BREAK a real, common category of legitimate compound garment
// words where the keyword is a SUFFIX with no space before it: "sundress"
// (dress), "raincoat"/"overcoat"/"trenchcoat" (coat), "sweatpants" (pant),
// "sweatshirt" (shirt) would all stop matching their correct bucket if the
// left side were anchored too. Checked directly against this exact list:
// every current keyword's plural is either a plain "+s" or "+es" (e.g.
// "clutch"/"clutches", "dress"/"dresses") — "scarf"/"scarves" is the one
// keyword whose irregular plural this still doesn't catch, same as the
// plain-substring code before it (not a regression, a pre-existing,
// disclosed limitation). Precompiled once at module load, not per call —
// this runs over every scraped candidate during ingestion.
const CATEGORY_BUCKET_MATCHERS: [RegExp, CategoryBucket][] = CATEGORY_BUCKET_KEYWORDS.map(([keyword, bucket]) => [
  new RegExp(`${escapeRegExp(keyword)}(?:es|s)?(?![a-z])`),
  bucket,
]);

export function categorizeListing(listing: { title: string; category: string | null | undefined }): CategoryBucket {
  const haystack = `${listing.category ?? ""} ${listing.title ?? ""}`.toLowerCase();
  for (const [pattern, bucket] of CATEGORY_BUCKET_MATCHERS) {
    if (pattern.test(haystack)) return bucket;
  }
  return "other";
}
