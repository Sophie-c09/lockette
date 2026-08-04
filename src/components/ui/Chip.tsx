"use client";

import { motion } from "motion/react";

// Pre-launch polish fix (item 9) — StepPreferences and StepBrands each
// hand-rolled their own near-identical selectable pill (same border-pill
// shape, same oxblood-selected/border-selected states, same hover), only
// differing in the optional leading color swatch. One shared component so
// onboarding's selection chips can't keep drifting apart from each other.
// `layout` (framer-motion) is applied unconditionally — a no-op unless the
// chip's position actually changes between renders (StepBrands' filtered
// list reflows; StepPreferences' fixed option lists never do).
export function Chip({
  label,
  selected,
  onClick,
  swatchColor,
}: {
  label: string;
  selected: boolean;
  onClick: () => void;
  swatchColor?: string;
}) {
  return (
    <motion.button
      type="button"
      layout
      onClick={onClick}
      className={`flex cursor-pointer items-center gap-2 rounded-pill border px-4 py-2 text-sm font-medium transition-colors ${
        selected
          ? "border-oxblood bg-oxblood text-parchment"
          : "border-border bg-surface text-ink-soft hover:border-oxblood/60"
      }`}
    >
      {swatchColor && (
        <span
          aria-hidden="true"
          className="h-2.5 w-2.5 shrink-0 rounded-full"
          style={{ backgroundColor: selected ? "currentColor" : swatchColor }}
        />
      )}
      {label}
    </motion.button>
  );
}
