"use client";

import { motion } from "motion/react";
import { AESTHETICS } from "@/lib/onboarding-data";
import { AestheticCard } from "./AestheticCard";

const container = {
  hidden: {},
  show: { transition: { staggerChildren: 0.05 } },
};

const cardVariant = {
  hidden: { opacity: 0, y: 16 },
  show: { opacity: 1, y: 0 },
};

export function StepAesthetics({
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
          Step 1 of 3
        </span>
        <h1 className="mt-2 font-display text-3xl font-semibold text-ink sm:text-4xl">
          Choose your aesthetics
        </h1>
        <p className="mt-2 text-sm text-ink-soft">
          Pick as many as speak to you — this shapes everything we show you.
        </p>
      </div>

      <motion.div
        variants={container}
        initial="hidden"
        animate="show"
        className="mx-auto grid max-w-5xl grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 lg:grid-cols-4"
      >
        {AESTHETICS.map((aesthetic) => (
          <motion.div key={aesthetic.id} variants={cardVariant}>
            <AestheticCard
              aesthetic={aesthetic}
              selected={selected.includes(aesthetic.id)}
              onToggle={() => onToggle(aesthetic.id)}
            />
          </motion.div>
        ))}
      </motion.div>
    </div>
  );
}
