// AI-Powered Outfit Creation — Part 4: the "Pinterest-style outfit board."
// No image-generation/compositing service exists anywhere in this
// codebase (no DALL-E/image-editing API, no server-side canvas
// stitching) — and fabricating one just to produce a single flattened
// "AI-generated" image would mean sometimes showing clothing that isn't
// the real, purchasable listing, which this feature's own spec
// explicitly forbids ("Do not create fake clothing... Use the actual
// marketplace listing images"). So this module does the honest version:
// a LAYOUT — which real listing image goes in which visual slot, in what
// order — for the UI to render as an actual CSS mosaic of real `<img>`
// tags pointing at real listing photos. That satisfies "Pinterest-style
// collage" without ever inventing a pixel. If image generation becomes
// available later, only the rendering layer needs to change; this
// module's output (a real image per real item, positioned) is already
// the right input for that too.
import type { GarmentCategory } from "@/lib/garment-detection";

export type OutfitPreviewSlot = "hero" | "middle" | "base" | "accent";

// Mirrors how an outfit is actually worn/laid out in a flatlay — worn-on-
// top garments (tops, outerwear, dresses) get the largest, top-most tile;
// bottoms sit in the middle; shoes anchor the bottom; bags/accessories
// are smaller supporting tiles. This is this file's own worked example
// ("Top: Baby tee / Middle: Low-rise jeans / Bottom: Sneakers"), not an
// arbitrary photo-grid ordering.
const CATEGORY_SLOT: Record<GarmentCategory, OutfitPreviewSlot> = {
  outerwear: "hero",
  dresses: "hero",
  tops: "hero",
  bottoms: "middle",
  shoes: "base",
  bags: "accent",
  accessories: "accent",
};

const SLOT_ORDER: OutfitPreviewSlot[] = ["hero", "middle", "base", "accent"];

export interface OutfitPreviewInputItem {
  listingId: string;
  category: GarmentCategory;
  garmentType: string;
  title: string;
  // Real listing photo URL — null only if a listing genuinely has none
  // (see Listing.image_url's own nullability); never a placeholder image
  // URL invented here.
  imageUrl: string | null;
  price: number | null;
  // Display/collage order within its slot — see styled_bundle_items'
  // own `position` column (supabase/schema.sql).
  position: number;
}

export interface OutfitPreviewTile extends OutfitPreviewInputItem {
  slot: OutfitPreviewSlot;
}

export interface OutfitPreviewLayout {
  tiles: OutfitPreviewTile[];
  // True if ANY tile has no real image — the UI's cue to render its own
  // placeholder graphic for just that tile (e.g. a generic garment-bag
  // icon), never a fabricated photo standing in for a real one.
  hasPlaceholderTiles: boolean;
}

/**
 * Arranges real listing items into a deterministic, wear-order layout —
 * no image generation, no fake clothing; every tile's imageUrl is either
 * a real listing photo or null (for the UI to placeholder honestly).
 */
export function buildOutfitPreviewLayout(items: OutfitPreviewInputItem[]): OutfitPreviewLayout {
  const tiles: OutfitPreviewTile[] = items
    .map((item) => ({ ...item, slot: CATEGORY_SLOT[item.category] ?? "accent" }))
    .sort((a, b) => {
      const slotDiff = SLOT_ORDER.indexOf(a.slot) - SLOT_ORDER.indexOf(b.slot);
      return slotDiff !== 0 ? slotDiff : a.position - b.position;
    });

  return {
    tiles,
    hasPlaceholderTiles: tiles.some((tile) => !tile.imageUrl),
  };
}
