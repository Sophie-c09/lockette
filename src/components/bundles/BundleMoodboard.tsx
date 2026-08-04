"use client";

// Presentation-only redesign of the bundle collage — a Pinterest/Vogue-
// style fashion moodboard instead of an ecommerce tile grid. Deliberately
// NOT a rewrite of bundle generation, matching, pricing, or listing data:
// this component only decides where each already-real listing image
// floats and how the board around it looks. It takes exactly the same
// per-item data BundleOutfitView.tsx already has (listing id/image/
// category/price/title) and changes nothing about how that data was
// produced — see that file for the actual generation/matching/pricing
// logic, which this component never touches.
//
// No image-generation/background-removal service exists in this codebase
// (see src/lib/outfit-preview.ts's own header comment on why) — "isolated
// against no white background" is achieved by NEVER wrapping an image in
// a card/box at all (no fill, no border, just the real photo plus a soft
// drop-shadow so it reads as sitting on the board rather than boxed in),
// not by editing the photos themselves.
import type { ReactNode } from "react";
import { motion } from "motion/react";
import { ImageOff } from "lucide-react";

export interface BundleMoodboardItem {
  id: string;
  imageUrl: string | null;
  title: string;
  price: number | null;
  // Loose on purpose — a bundle item's stored category can be any of
  // GarmentCategory (src/lib/garment-detection.ts) or null (pre-category
  // manual bundles — see BundleOutfitView's own toGarmentCategory). This
  // component only ever reads it to pick a zone, never to gate whether an
  // item renders at all.
  category: string | null;
  // Optional, finer-grained garment name (e.g. "beanie", "crossbody bag")
  // — used only for the hats-in-upper-corners heuristic below; omitting
  // it just means every "accessories" item falls back to the generic
  // floating-accent zone, never a rendering failure.
  garmentType?: string | null;
}

type Zone = "top" | "bottom" | "shoes" | "bags" | "hat" | "accent";

// Requirement mapping (verbatim from the design spec):
//   tops -> center upper/middle | bottoms -> lower center |
//   shoes -> bottom corners | bags -> side areas |
//   jewelry/accessories -> smaller floating accents | hats -> upper corners
// dresses/outerwear join "tops" (same worn-on-top layer outfit-preview.ts
// already groups together for its own hero slot) since neither is a
// distinct stored category on its own. There's no separate "hats" or
// "jewelry" category in this app's data model (GARMENT_CATEGORIES has
// none — jewelry/hats/belts/scarves are all "accessories", see
// garment-detection.ts's own comment) — hats are pulled out of
// "accessories" here by matching garmentType/title against a small
// keyword list, a presentation-only heuristic that never touches stored
// data.
const HAT_KEYWORDS = ["hat", "cap", "beanie", "beret", "visor", "fedora"];

function zoneFor(item: BundleMoodboardItem): Zone {
  const category = (item.category ?? "").toLowerCase();
  if (category === "tops" || category === "dresses" || category === "outerwear") return "top";
  if (category === "bottoms") return "bottom";
  if (category === "shoes") return "shoes";
  if (category === "bags") return "bags";

  const haystack = `${item.garmentType ?? ""} ${item.title}`.toLowerCase();
  if (HAT_KEYWORDS.some((keyword) => haystack.includes(keyword))) return "hat";
  return "accent";
}

// Deterministic per-item "randomness" — a real Math.random()/Date.now()
// jitter would differ between server and client render (or between two
// client re-renders), which either breaks hydration or makes the board
// visibly reshuffle itself on every poll while a bundle is still
// generating. Hashing the item's own id instead means the same item
// always lands at the same jittered offset, every render, forever.
function seededJitter(seed: string, range: number): number {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  }
  const normalized = (Math.abs(hash) % 1000) / 1000; // 0..1
  return (normalized - 0.5) * 2 * range; // -range..range
}

interface Placement {
  top: number; // percent
  left: number; // percent
  widthPercent: number;
  rotateDeg: number;
  zIndex: number;
}

// The "gap" spots a floating accent (jewelry, belts, scarves — every
// non-hat accessory) settles into, cycling if there are more than four —
// deliberately in the vertical band BETWEEN the hat corners (top ~9-21%)
// and the shoe corners (top ~76-85%), and horizontally between the
// center column (tops/bottoms, ~26-74% left) and the bag column (~9/91%
// left), so an accent never lands on top of another zone's items.
const ACCENT_SPOTS = [
  { top: 46, left: 22 },
  { top: 46, left: 78 },
  { top: 74, left: 24 },
  { top: 74, left: 76 },
];

// A single center-column zone (top/bottom) shrinks each item and widens
// the gap between centers as more items share it — without this, N items
// all claiming the same ~40%-wide slot at a fixed spread would stack
// almost directly on top of each other (found live while smoke-testing:
// a 2-item "top" zone at fixed width overlapped by more than half).
// spreadStep is the distance BETWEEN adjacent centers; picked so two
// items of the resulting width just barely kiss/lightly overlap (an
// intentional, artful flat-lay layer) rather than mostly covering each
// other.
function widthForZoneCount(baseWidth: number, count: number): number {
  if (count <= 1) return baseWidth;
  if (count === 2) return baseWidth * 0.74;
  return baseWidth * 0.6;
}

function spreadStepForZoneCount(count: number): number {
  if (count <= 1) return 0;
  if (count === 2) return 26;
  return 22;
}

function placeItem(item: BundleMoodboardItem, indexInZone: number, countInZone: number, zone: Zone): Placement {
  const jitterX = seededJitter(`${item.id}x`, 3);
  const jitterY = seededJitter(`${item.id}y`, 2.5);
  const rotateDeg = seededJitter(`${item.id}r`, 7);
  const centerOffset = (indexInZone - (countInZone - 1) / 2) * spreadStepForZoneCount(countInZone);

  switch (zone) {
    case "top": {
      const widthPercent = widthForZoneCount(42, countInZone);
      return { top: 28 + jitterY, left: 50 + centerOffset + jitterX, widthPercent, rotateDeg, zIndex: 30 - indexInZone };
    }
    case "bottom": {
      const widthPercent = widthForZoneCount(36, countInZone);
      return { top: 63 + jitterY, left: 50 + centerOffset + jitterX, widthPercent, rotateDeg, zIndex: 20 - indexInZone };
    }
    case "shoes": {
      const left = indexInZone % 2 === 0 ? 15 : 85;
      const stackOffset = Math.floor(indexInZone / 2) * 11;
      return { top: 86 - stackOffset, left: left + jitterX * 0.5, widthPercent: 20, rotateDeg, zIndex: 10 };
    }
    case "bags": {
      const left = indexInZone % 2 === 0 ? 8 : 92;
      const stackOffset = Math.floor(indexInZone / 2) * 18;
      return { top: 48 + stackOffset + jitterY, left: left + jitterX * 0.4, widthPercent: 22, rotateDeg, zIndex: 12 };
    }
    case "hat": {
      const left = indexInZone % 2 === 0 ? 12 : 88;
      const stackOffset = Math.floor(indexInZone / 2) * 14;
      return { top: 8 + stackOffset, left: left + jitterX * 0.4, widthPercent: 16, rotateDeg, zIndex: 18 };
    }
    case "accent":
    default: {
      const spot = ACCENT_SPOTS[indexInZone % ACCENT_SPOTS.length];
      return { top: spot.top + jitterY, left: spot.left + jitterX, widthPercent: 15, rotateDeg, zIndex: 25 + indexInZone };
    }
  }
}

function FloatingItem({
  item,
  placement,
  onClick,
}: {
  item: BundleMoodboardItem;
  placement: Placement;
  onClick?: (itemId: string) => void;
}): ReactNode {
  const clickable = Boolean(onClick);

  return (
    <motion.button
      type="button"
      disabled={!clickable}
      onClick={() => onClick?.(item.id)}
      aria-label={clickable ? `${item.title}${item.price != null ? ` — $${Number(item.price).toFixed(2)}` : ""}` : item.title}
      className={`absolute flex items-center justify-center bg-transparent p-0 ${clickable ? "cursor-pointer" : "cursor-default"}`}
      style={{
        top: `${placement.top}%`,
        left: `${placement.left}%`,
        width: `${placement.widthPercent}%`,
        zIndex: placement.zIndex,
        transform: `translate(-50%, -50%) rotate(${placement.rotateDeg}deg)`,
      }}
      initial={{ opacity: 0, scale: 0.85 }}
      animate={{ opacity: 1, scale: 1 }}
      whileHover={clickable ? { scale: 1.06, rotate: 0 } : undefined}
      transition={{ duration: 0.5, ease: "easeOut" }}
    >
      {item.imageUrl ? (
        // eslint-disable-next-line @next/next/no-img-element -- arbitrary external marketplace domain, not known in advance
        <img
          src={item.imageUrl}
          alt={item.title}
          draggable={false}
          className="pointer-events-none aspect-square w-full select-none object-contain"
          style={{ filter: "drop-shadow(0 10px 14px rgba(15, 42, 31, 0.16))" }}
        />
      ) : (
        <div className="flex aspect-square w-full items-center justify-center">
          <ImageOff className="h-6 w-6 text-muted" strokeWidth={1.5} />
        </div>
      )}
    </motion.button>
  );
}

/**
 * The bundle's collage, redesigned as a floating fashion flat lay inside
 * a large soft-pink board — see this file's own header comment for what
 * this does and doesn't change. Callers decide what a click does
 * (BundleOutfitView.tsx wires it to the exact same item-detail side panel
 * the old grid opened); omit onItemClick to render a static, non-
 * interactive board.
 */
export function BundleMoodboard({
  items,
  onItemClick,
  className = "",
}: {
  items: BundleMoodboardItem[];
  onItemClick?: (itemId: string) => void;
  className?: string;
}) {
  const zoned = items.map((item) => ({ item, zone: zoneFor(item) }));
  const countByZone = zoned.reduce<Record<Zone, number>>(
    (acc, { zone }) => ({ ...acc, [zone]: (acc[zone] ?? 0) + 1 }),
    { top: 0, bottom: 0, shoes: 0, bags: 0, hat: 0, accent: 0 },
  );
  const seenByZone: Record<Zone, number> = { top: 0, bottom: 0, shoes: 0, bags: 0, hat: 0, accent: 0 };

  return (
    <div className={`rounded-3xl bg-pink-soft p-4 shadow-card sm:p-6 ${className}`}>
      <div className="relative aspect-[4/5] w-full overflow-hidden rounded-2xl">
        {zoned.map(({ item, zone }) => {
          const indexInZone = seenByZone[zone]++;
          const placement = placeItem(item, indexInZone, countByZone[zone], zone);
          return <FloatingItem key={item.id} item={item} placement={placement} onClick={onItemClick} />;
        })}
      </div>
    </div>
  );
}
