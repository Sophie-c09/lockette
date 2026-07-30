"use client";

import { motion } from "motion/react";
import {
  BUDGET_OPTIONS,
  CATEGORY_OPTIONS,
  COLOR_OPTIONS,
  SIZE_OPTIONS,
} from "@/lib/onboarding-data";

function Chip({
  label,
  selected,
  onClick,
}: {
  label: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`cursor-pointer rounded-pill border px-4 py-2 text-sm font-medium transition-colors ${
        selected
          ? "border-oxblood bg-oxblood text-parchment"
          : "border-border bg-surface text-ink-soft hover:border-oxblood/60"
      }`}
    >
      {label}
    </button>
  );
}

export function StepPreferences({
  size,
  onSizeChange,
  budgetMax,
  onBudgetChange,
  categories,
  onToggleCategory,
  colors,
  onToggleColor,
}: {
  size: string | null;
  onSizeChange: (size: string) => void;
  budgetMax: number | null;
  onBudgetChange: (value: number) => void;
  categories: string[];
  onToggleCategory: (category: string) => void;
  colors: string[];
  onToggleColor: (color: string) => void;
}) {
  return (
    <div className="mx-auto max-w-2xl">
      <div className="mb-10 text-center">
        <span className="font-display text-sm uppercase tracking-[0.2em] text-oxblood">
          Step 3 of 3
        </span>
        <h1 className="mt-2 font-display text-3xl font-semibold text-ink sm:text-4xl">
          Your shopping preferences
        </h1>
        <p className="mt-2 text-sm text-ink-soft">
          Fine-tune your matches with a few last details.
        </p>
      </div>

      <div className="flex flex-col gap-10">
        <section>
          <h2 className="mb-3 font-display text-lg font-semibold text-ink">
            What&apos;s your size?
          </h2>
          <div className="flex flex-wrap gap-2">
            {SIZE_OPTIONS.map((option) => (
              <Chip
                key={option}
                label={option}
                selected={size === option}
                onClick={() => onSizeChange(option)}
              />
            ))}
          </div>
        </section>

        <section>
          <h2 className="mb-3 font-display text-lg font-semibold text-ink">
            What&apos;s your budget per item?
          </h2>
          <div className="flex flex-wrap gap-2">
            {BUDGET_OPTIONS.map((option) => (
              <Chip
                key={option.label}
                label={option.label}
                selected={budgetMax === option.value}
                onClick={() => onBudgetChange(option.value)}
              />
            ))}
          </div>
        </section>

        <section>
          <h2 className="mb-3 font-display text-lg font-semibold text-ink">
            Favorite categories
          </h2>
          <div className="flex flex-wrap gap-2">
            {CATEGORY_OPTIONS.map((category) => (
              <Chip
                key={category}
                label={category}
                selected={categories.includes(category)}
                onClick={() => onToggleCategory(category)}
              />
            ))}
          </div>
        </section>

        <section>
          <h2 className="mb-3 font-display text-lg font-semibold text-ink">
            Colors you gravitate to
          </h2>
          <div className="flex flex-wrap gap-x-5 gap-y-3">
            {COLOR_OPTIONS.map((color) => {
              const isSelected = colors.includes(color.name);
              return (
                <button
                  key={color.name}
                  type="button"
                  onClick={() => onToggleColor(color.name)}
                  className="flex cursor-pointer flex-col items-center gap-1.5"
                >
                  <motion.span
                    animate={{ scale: isSelected ? 1.12 : 1 }}
                    transition={{ type: "spring", stiffness: 400, damping: 20 }}
                    className={`block h-11 w-11 rounded-full border-2 shadow-soft ${
                      isSelected ? "border-oxblood" : "border-border"
                    }`}
                    style={{ backgroundColor: color.hex }}
                  />
                  <span className="text-xs text-ink-soft">{color.name}</span>
                </button>
              );
            })}
          </div>
        </section>
      </div>
    </div>
  );
}
