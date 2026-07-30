"use client";

import Image from "next/image";
import { motion } from "motion/react";
import { Check } from "lucide-react";
import type { AestheticOption } from "@/lib/onboarding-data";

export function AestheticCard({
  aesthetic,
  selected,
  onToggle,
}: {
  aesthetic: AestheticOption;
  selected: boolean;
  onToggle: () => void;
}) {
  return (
    <motion.button
      type="button"
      onClick={onToggle}
      whileTap={{ scale: 0.96 }}
      aria-pressed={selected}
      className={`group relative aspect-[3/4] w-full overflow-hidden rounded-card border-2 text-left shadow-soft transition-colors ${
        selected ? "border-oxblood" : "border-transparent"
      }`}
    >
      <Image
        src={aesthetic.image}
        alt={aesthetic.name}
        fill
        className="object-cover transition-transform duration-500 group-hover:scale-105"
        sizes="(min-width: 1024px) 22vw, (min-width: 640px) 30vw, 45vw"
      />
      <div className="absolute inset-x-0 bottom-0 bg-darkgreen/55 p-4">
        <h3 className="font-display text-lg font-semibold text-white sm:text-xl">
          {aesthetic.name}
        </h3>
        <p className="mt-1 text-xs text-white/80 sm:text-sm">
          {aesthetic.description}
        </p>
      </div>

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
