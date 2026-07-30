// Small helper shared by every provider's own normalizeListing()
// (src/lib/marketplace-ingestion/providers/*.ts) — kept in one place so
// "how a listing's searchable text gets built" has exactly one
// implementation, not one copy per provider file.
import type { GarmentAttributes, RawMarketplaceListing } from "./types";

// Folds the fields a caller would actually want to text-search into one
// blob — same "structured detail becomes searchable text" approach
// src/app/actions/outfit-recreations.ts's getOutfitRecreation already
// uses when building a query description, and src/lib/marketplaces/*.ts's
// own searchableText fields.
export function buildSearchableText(raw: RawMarketplaceListing, garmentAttributes?: GarmentAttributes | null): string {
  return [
    raw.title,
    raw.description,
    raw.brand,
    raw.category,
    garmentAttributes?.garmentType,
    garmentAttributes?.color,
    garmentAttributes?.pattern,
    garmentAttributes?.material,
  ]
    .filter((part): part is string => Boolean(part))
    .join(" ");
}
