"use client";

import { motion } from "motion/react";
import { Check } from "lucide-react";
import type { BrandOption } from "@/lib/onboarding-data";

export function BrandCard({
  brand,
  selected,
  onToggle,
}: {
  brand: BrandOption;
  selected: boolean;
  onToggle: () => void;
}) {
  return (
    <motion.button
      type="button"
      onClick={onToggle}
      whileTap={{ scale: 0.96 }}
      aria-pressed={selected}
      style={{ backgroundColor: brand.color }}
      className={`relative flex aspect-[4/3] w-full items-center justify-center overflow-hidden rounded-card border-2 p-4 shadow-soft transition-colors ${
        selected ? "border-oxblood" : "border-transparent"
      }`}
    >
      <span className="font-display text-xl font-semibold italic text-white sm:text-2xl">
        {brand.name}
      </span>

      <motion.div
        initial={false}
        animate={{ scale: selected ? 1 : 0, opacity: selected ? 1 : 0 }}
        transition={{ type: "spring", stiffness: 400, damping: 25 }}
        className="absolute right-3 top-3 flex h-7 w-7 items-center justify-center rounded-full bg-oxblood text-parchment shadow-soft"
      >
        <Check className="h-4 w-4" strokeWidth={3} />
      </motion.div>
    </motion.button>
  );
}
