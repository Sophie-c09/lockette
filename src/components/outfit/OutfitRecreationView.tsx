"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ImageOff, Shuffle } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { MatchResultCard } from "@/components/MatchResultCard";
import { useRankedPage } from "@/lib/use-ranked-page";
import type { OutfitRecreationDetail, OutfitRecreationItem } from "@/app/actions/outfit-recreations";
import type { OutfitCategory } from "@/lib/outfit-classification";

// Widened from the old top/bottom/layer vocabulary to the full garment
// vocabulary (src/lib/garment-detection.ts) — see
// outfit-classification.ts's own comment.
const CATEGORY_LABELS: Record<OutfitCategory, string> = {
  tops: "Top",
  dresses: "Dress",
  bottoms: "Bottoms",
  outerwear: "Outerwear",
  shoes: "Shoes",
  bags: "Bag",
  accessories: "Accessory",
};

// "Find This Look" — an outfit-recreation moment rather than a results
// table: the uploaded photo as "Original Look," then each detected piece
// as its OWN section ("Recreated Pieces"), each showing only its top 3
// matches. Matches now come from the shared reverse-image-search engine
// (src/lib/garment-matching.ts via src/app/actions/outfit-recreations.ts's
// getOutfitRecreation) — already-fetched, already-ranked per-category
// pools (up to 12) are just paged 3-at-a-time (src/lib/use-ranked-page.ts):
// Shuffle reveals the next highest-ranked unused pieces, never a random
// pick, and "replacing a piece" IS shuffling that category — whichever
// piece currently leads a category becomes its pick in the combined
// "Your Recreated Outfit" preview at the bottom, which is why each
// section reports its current top pick back up to this parent.
function CategorySection({
  category,
  items,
  onTopPickChange,
}: {
  category: OutfitCategory;
  items: OutfitRecreationItem[];
  onTopPickChange: (category: OutfitCategory, item: OutfitRecreationItem | null) => void;
}) {
  // Memoized so `pool` (and therefore useRankedPage's `displayed`) keeps
  // the same reference across re-renders unless `items` actually changes
  // — `[...items].sort()` allocates a new array every call otherwise,
  // which would defeat useRankedPage's own memoization of `displayed`.
  const pool = useMemo(() => [...items].sort((a, b) => a.rank - b.rank), [items]);
  const { displayed, canShowMore, showNext } = useRankedPage(pool);
  const topPick = displayed[0] ?? null;

  // Tracks the last pick this section actually reported up, so the
  // effect below only calls onTopPickChange when there's a genuinely new
  // selection to report — not on every render. This (plus memoizing
  // `pool`/`displayed` above) is what fixes "Maximum update depth
  // exceeded": onTopPickChange used to be a fresh inline closure from the
  // parent on every render, AND `displayed` used to be a fresh array
  // reference on every render regardless of content, so this effect fired
  // on every render, which called setTopPicks in the parent, which
  // re-rendered this component with a new closure/new array, re-firing
  // the effect — forever.
  const lastReportedIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (items.length === 0) return;

    const nextId = topPick?.listing.id ?? null;
    if (lastReportedIdRef.current === nextId) return;

    lastReportedIdRef.current = nextId;
    onTopPickChange(category, topPick);
  }, [category, items, topPick, onTopPickChange]);

  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <h3 className="font-display text-lg font-semibold text-ink">{CATEGORY_LABELS[category] ?? category}</h3>
        {pool.length > displayed.length && (
          <Button
            type="button"
            variant="secondary"
            onClick={showNext}
            disabled={!canShowMore}
            className="w-fit"
          >
            <Shuffle className="h-4 w-4" strokeWidth={2} />
            Shuffle Matches
          </Button>
        )}
      </div>

      {displayed.length === 0 ? (
        <p className="mt-3 rounded-card bg-inner/50 p-6 text-center text-sm text-ink-soft">
          No good matches yet for this piece — try a wider budget next time.
        </p>
      ) : (
        <AnimatePresence mode="wait">
          <motion.div
            key={displayed.map((item) => item.listing.id).join(",")}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -12 }}
            transition={{ duration: 0.35, ease: "easeOut" }}
            className="mt-4 grid grid-cols-3 gap-3 sm:gap-5"
          >
            {displayed.map((item, index) => (
              <MatchResultCard key={item.listing.id} listing={item.listing} rank={index} />
            ))}
          </motion.div>
        </AnimatePresence>
      )}
    </div>
  );
}

function RecreatedOutfitPreview({
  categories,
  topPicks,
}: {
  categories: OutfitCategory[];
  topPicks: Partial<Record<OutfitCategory, OutfitRecreationItem | null>>;
}) {
  const hasAnyPick = categories.some((category) => topPicks[category]);
  if (!hasAnyPick) return null;

  return (
    <div className="mt-14 rounded-card border border-border/60 bg-inner/40 px-6 py-8">
      <h3 className="text-center font-display text-xs font-semibold uppercase tracking-[0.2em] text-ink-soft">
        Your Recreated Outfit
      </h3>
      <div className="mt-5 flex flex-wrap items-start justify-center gap-5">
        {categories.map((category) => {
          const pick = topPicks[category];
          return (
            <div key={category} className="flex flex-col items-center gap-2">
              <div className="h-20 w-20 overflow-hidden rounded-2xl bg-surface shadow-soft sm:h-24 sm:w-24">
                {pick?.listing.image_url ? (
                  // eslint-disable-next-line @next/next/no-img-element -- arbitrary external marketplace domain, not known in advance
                  <img
                    src={pick.listing.image_url}
                    alt={pick.listing.title}
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <div className="flex h-full w-full items-center justify-center">
                    <ImageOff className="h-5 w-5 text-muted" strokeWidth={1.5} />
                  </div>
                )}
              </div>
              <span className="text-xs font-medium text-ink-soft">{CATEGORY_LABELS[category] ?? category}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function OutfitRecreationView({ recreation }: { recreation: OutfitRecreationDetail }) {
  const [topPicks, setTopPicks] = useState<Partial<Record<OutfitCategory, OutfitRecreationItem | null>>>({});

  // Stable across every render (empty dep array — setTopPicks's own
  // functional-updater form never needs anything from this render's
  // closure) so every CategorySection instance can share the SAME
  // function reference instead of each getting a fresh inline closure
  // from .map() on every render — see CategorySection's own comment on
  // why an unstable callback here was the other half of the infinite
  // render loop.
  const handleTopPickChange = useCallback((category: OutfitCategory, item: OutfitRecreationItem | null) => {
    setTopPicks((prev) => ({ ...prev, [category]: item }));
  }, []);

  return (
    <div className="mx-auto max-w-2xl px-6 py-12">
      <div className="flex flex-col items-center text-center">
        <span className="font-display text-xs uppercase tracking-[0.25em] text-oxblood">Original Look</span>

        {recreation.photoUrl && (
          <div className="relative mt-5 h-48 w-40 overflow-hidden rounded-card shadow-card sm:h-56 sm:w-44">
            {/* eslint-disable-next-line @next/next/no-img-element -- signed Supabase Storage URL, not known in advance */}
            <img src={recreation.photoUrl} alt="Uploaded outfit" className="h-full w-full object-cover" />
          </div>
        )}

        <div className="mt-6 h-8 w-px bg-border" aria-hidden="true" />
        <h1 className="mt-2 font-display text-2xl font-semibold text-ink sm:text-3xl">Recreated Pieces</h1>
        <p className="mt-1.5 max-w-xs text-sm text-ink-soft">
          A curated match for every piece we spotted in your photo.
        </p>
      </div>

      <div className="mt-12 flex flex-col gap-12">
        {recreation.categories.map((category, index) => (
          <div key={category} className={index > 0 ? "border-t border-border/50 pt-12" : undefined}>
            <CategorySection
              category={category}
              items={recreation.itemsByCategory[category] ?? []}
              onTopPickChange={handleTopPickChange}
            />
          </div>
        ))}
      </div>

      <RecreatedOutfitPreview categories={recreation.categories} topPicks={topPicks} />
    </div>
  );
}
