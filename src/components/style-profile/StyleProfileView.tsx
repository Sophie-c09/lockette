"use client";

import { motion } from "motion/react";
import { Sparkles } from "lucide-react";
import { LinkButton } from "@/components/ui/Button";
import { Badge, tagVariantForIndex } from "@/components/ui/Badge";
import { AESTHETICS, BRANDS, COLOR_OPTIONS } from "@/lib/onboarding-data";
import { MOODBOARD_IMAGES, type MoodImage } from "@/lib/moodboard-data";
import type { StyleDna } from "@/lib/style-dna";
import { MoodCard } from "./MoodCard";
import { BrandTile } from "./BrandTile";
import { Moodboard } from "./Moodboard";

const COLOR_HEX: Record<string, string> = Object.fromEntries(
  COLOR_OPTIONS.map((color) => [color.name, color.hex]),
);

const fadeUp = {
  hidden: { opacity: 0, y: 24 },
  show: { opacity: 1, y: 0 },
};

export function StyleProfileView({
  styleDna,
  aesthetics,
  brands,
  categories,
  colors,
  size,
  budgetMax,
}: {
  styleDna: StyleDna;
  aesthetics: string[];
  brands: string[];
  categories: string[];
  colors: string[];
  size: string | null;
  budgetMax: number | null;
}) {
  const aestheticOptions = AESTHETICS.filter((option) =>
    aesthetics.includes(option.id),
  );
  const brandOptions = BRANDS.filter((option) => brands.includes(option.id));

  const moodboardImages: MoodImage[] = aesthetics.length
    ? aesthetics.flatMap((id) => MOODBOARD_IMAGES[id] ?? [])
    : Object.values(MOODBOARD_IMAGES).flat().slice(0, 9);

  return (
    <div className="px-6 py-16 sm:py-20">
      <div className="mx-auto max-w-5xl">
        <motion.div
          initial="hidden"
          animate="show"
          variants={fadeUp}
          transition={{ duration: 0.5 }}
          className="text-center"
        >
          <span className="font-display text-sm uppercase tracking-[0.3em] text-oxblood">
            Your Lockette Style
          </span>
          <h1 className="mt-3 font-display text-4xl font-semibold text-ink sm:text-6xl">
            {styleDna.styleName}
          </h1>
        </motion.div>

        <motion.p
          initial="hidden"
          animate="show"
          variants={fadeUp}
          transition={{ duration: 0.5, delay: 0.1 }}
          className="mx-auto mt-8 max-w-2xl text-center font-display text-xl leading-relaxed text-ink italic sm:text-2xl"
        >
          &ldquo;{styleDna.description}&rdquo;
        </motion.p>

        <motion.div
          initial="hidden"
          animate="show"
          variants={fadeUp}
          transition={{ duration: 0.5, delay: 0.2 }}
          className="mx-auto mt-10 flex max-w-lg items-start gap-4 rounded-card border border-border bg-surface p-6 text-left shadow-soft"
        >
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-parchment-deep">
            <Sparkles className="h-5 w-5 text-oxblood" strokeWidth={1.5} />
          </div>
          <div>
            <p className="font-display text-lg font-semibold text-ink">
              {styleDna.personality.label}
            </p>
            <p className="mt-1 text-sm text-ink-soft">
              {styleDna.personality.blurb}
            </p>
          </div>
        </motion.div>

        <motion.div
          initial="hidden"
          animate="show"
          variants={fadeUp}
          transition={{ duration: 0.5, delay: 0.3 }}
          className="mt-10 flex justify-center"
        >
          <LinkButton href="/match" className="px-7 py-3.5 text-base">
            Start Matching
          </LinkButton>
        </motion.div>

        {(size || budgetMax) && (
          <div className="mt-14 flex justify-center gap-10 text-center">
            {size && (
              <div>
                <p className="font-display text-2xl font-semibold text-ink">
                  {size}
                </p>
                <p className="text-xs tracking-wide text-ink-soft uppercase">
                  Size
                </p>
              </div>
            )}
            {budgetMax != null && (
              <div>
                <p className="font-display text-2xl font-semibold text-ink">
                  {budgetMax >= 250 ? "$100+" : `Up to $${budgetMax}`}
                </p>
                <p className="text-xs tracking-wide text-ink-soft uppercase">
                  Budget
                </p>
              </div>
            )}
          </div>
        )}

        {aestheticOptions.length > 0 && (
          <motion.section
            initial="hidden"
            whileInView="show"
            viewport={{ once: true, margin: "-80px" }}
            variants={fadeUp}
            transition={{ duration: 0.5 }}
            className="mt-20"
          >
            <h2 className="mb-6 text-center font-display text-2xl font-semibold text-ink sm:text-3xl">
              Favorite Aesthetics
            </h2>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 lg:grid-cols-4">
              {aestheticOptions.map((option) => (
                <MoodCard
                  key={option.id}
                  image={option.image}
                  name={option.name}
                  description={option.description}
                />
              ))}
            </div>
          </motion.section>
        )}

        {brandOptions.length > 0 && (
          <motion.section
            initial="hidden"
            whileInView="show"
            viewport={{ once: true, margin: "-80px" }}
            variants={fadeUp}
            transition={{ duration: 0.5 }}
            className="mt-16"
          >
            <h2 className="mb-6 text-center font-display text-2xl font-semibold text-ink sm:text-3xl">
              Favorite Brands
            </h2>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 lg:grid-cols-4">
              {brandOptions.map((option) => (
                <BrandTile
                  key={option.id}
                  name={option.name}
                  color={option.color}
                />
              ))}
            </div>
          </motion.section>
        )}

        {categories.length > 0 && (
          <motion.section
            initial="hidden"
            whileInView="show"
            viewport={{ once: true, margin: "-80px" }}
            variants={fadeUp}
            transition={{ duration: 0.5 }}
            className="mt-16"
          >
            <h2 className="mb-6 text-center font-display text-2xl font-semibold text-ink sm:text-3xl">
              Favorite Categories
            </h2>
            <div className="flex flex-wrap justify-center gap-2">
              {categories.map((category, index) => (
                <Badge
                  key={category}
                  variant={tagVariantForIndex(index)}
                  className="px-4 py-2 text-sm"
                >
                  {category}
                </Badge>
              ))}
            </div>
          </motion.section>
        )}

        {colors.length > 0 && (
          <motion.section
            initial="hidden"
            whileInView="show"
            viewport={{ once: true, margin: "-80px" }}
            variants={fadeUp}
            transition={{ duration: 0.5 }}
            className="mt-16"
          >
            <h2 className="mb-6 text-center font-display text-2xl font-semibold text-ink sm:text-3xl">
              Color Palette
            </h2>
            <div className="flex flex-wrap justify-center gap-x-6 gap-y-4">
              {colors.map((color) => (
                <div key={color} className="flex flex-col items-center gap-2">
                  <span
                    className="block h-14 w-14 rounded-full border-2 border-border shadow-soft"
                    style={{ backgroundColor: COLOR_HEX[color] ?? "#cccccc" }}
                  />
                  <span className="text-xs text-ink-soft">{color}</span>
                </div>
              ))}
            </div>
          </motion.section>
        )}

        <motion.section
          initial="hidden"
          whileInView="show"
          viewport={{ once: true, margin: "-80px" }}
          variants={fadeUp}
          transition={{ duration: 0.5 }}
          className="mt-20"
        >
          <h2 className="mb-2 text-center font-display text-2xl font-semibold text-ink sm:text-3xl">
            Your Moodboard
          </h2>
          <p className="mb-8 text-center text-sm text-ink-soft">
            A collage of the pieces and moments that capture your style.
          </p>
          <Moodboard images={moodboardImages} />
        </motion.section>

        <div className="mt-16 flex justify-center pb-4">
          <LinkButton href="/match" className="px-7 py-3.5 text-base">
            Start Matching
          </LinkButton>
        </div>
      </div>
    </div>
  );
}
