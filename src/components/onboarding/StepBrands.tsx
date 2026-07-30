"use client";

import { motion } from "motion/react";
import { BRANDS } from "@/lib/onboarding-data";
import { BrandCard } from "./BrandCard";

const container = {
  hidden: {},
  show: { transition: { staggerChildren: 0.05 } },
};

const cardVariant = {
  hidden: { opacity: 0, y: 16 },
  show: { opacity: 1, y: 0 },
};

export function StepBrands({
  selected,
  onToggle,
}: {
  selected: string[];
  onToggle: (id: string) => void;
}) {
  return (
    <div>
      <div className="mb-8 text-center">
        <span className="font-display text-sm uppercase tracking-[0.2em] text-oxblood">
          Step 2 of 3
        </span>
        <h1 className="mt-2 font-display text-3xl font-semibold text-ink sm:text-4xl">
          Choose brands you love
        </h1>
        <p className="mt-2 text-sm text-ink-soft">
          We&apos;ll prioritize secondhand finds from labels you already trust.
        </p>
      </div>

      <motion.div
        variants={container}
        initial="hidden"
        animate="show"
        className="mx-auto grid max-w-4xl grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 lg:grid-cols-4"
      >
        {BRANDS.map((brand) => (
          <motion.div key={brand.id} variants={cardVariant}>
            <BrandCard
              brand={brand}
              selected={selected.includes(brand.id)}
              onToggle={() => onToggle(brand.id)}
            />
          </motion.div>
        ))}
      </motion.div>
    </div>
  );
}
