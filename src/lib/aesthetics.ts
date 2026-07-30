import type { Aesthetic, ClothingItem } from "@/lib/mock-clothing";

const TOP_AESTHETIC_COUNT = 3;
const SIMILAR_ITEMS_LIMIT = 10;

// Shared by /search, /match, and /discover: flattens a user's liked items
// down to their most-liked aesthetics, most frequent first.
export function getTopAesthetics(items: ClothingItem[]): Aesthetic[] {
  const counts = new Map<Aesthetic, number>();

  for (const item of items) {
    for (const aesthetic of item.aesthetics) {
      counts.set(aesthetic, (counts.get(aesthetic) ?? 0) + 1);
    }
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP_AESTHETIC_COUNT)
    .map(([aesthetic]) => aesthetic);
}

// Ranks the rest of the catalog by aesthetic overlap with a single selected
// item (+2 per shared aesthetic), for a "Because you liked this" row.
export function getSimilarItems(
  selectedItem: ClothingItem,
  items: ClothingItem[],
  limit = SIMILAR_ITEMS_LIMIT,
): ClothingItem[] {
  return items
    .filter((item) => item.id !== selectedItem.id)
    .map((item) => ({
      item,
      score:
        item.aesthetics.filter((aesthetic) =>
          selectedItem.aesthetics.includes(aesthetic),
        ).length * 2,
    }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ item }) => item);
}
