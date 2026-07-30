"use client";

import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ImageOff, Shuffle, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { MatchResultCard } from "@/components/MatchResultCard";
import { findSimilarListings } from "@/app/actions/similar-listings";
import { useRankedPage } from "@/lib/use-ranked-page";
import { BUDGET_OPTIONS, type BudgetOption } from "@/lib/budget-options";
import type { Listing } from "@/lib/supabase/listings.types";

// "Find Similar" — redesigned as a self-contained, premium stylist moment
// rather than an endless results grid: the piece you're viewing shown as
// "Original Inspiration," a budget choice, then only the top 3 strongest
// matches. Backend untouched (src/lib/similar-listings.ts,
// src/app/actions/similar-listings.ts) — this file only changes what's
// rendered and how "Shuffle" pages through the already-fetched,
// already-ranked pool (src/lib/use-ranked-page.ts — the next 3 unused
// results, never a random re-draw).
export function SimilarListingsPanel({
  listingId,
  aestheticTags,
  heroImage,
  heroTitle,
}: {
  listingId: string;
  aestheticTags: string[];
  heroImage: string | null;
  heroTitle: string;
}) {
  const [selectedBudget, setSelectedBudget] = useState<BudgetOption | null>(null);
  const [confirmedBudget, setConfirmedBudget] = useState<BudgetOption | null>(null);
  const [pool, setPool] = useState<Listing[]>([]);
  const [loading, setLoading] = useState(false);
  const { displayed, canShowMore, showNext, reset } = useRankedPage(pool);

  async function handleFindSimilar() {
    if (!selectedBudget) return;
    setConfirmedBudget(selectedBudget);
    setLoading(true);

    const result = await findSimilarListings(listingId, aestheticTags, selectedBudget);
    setPool(result.listings);
    reset();
    setLoading(false);
  }

  function handleChangeBudget() {
    setConfirmedBudget(null);
    setPool([]);
    reset();
  }

  return (
    <section id="find-similar" className="mt-20 scroll-mt-24">
      <div className="flex flex-col items-center text-center">
        <span className="font-display text-xs uppercase tracking-[0.25em] text-oxblood">
          Original Inspiration
        </span>

        <div className="relative mt-5 h-44 w-36 overflow-hidden rounded-card shadow-card sm:h-52 sm:w-40">
          {heroImage ? (
            // eslint-disable-next-line @next/next/no-img-element -- arbitrary external marketplace domain, not known in advance
            <img src={heroImage} alt={heroTitle} className="h-full w-full object-cover" />
          ) : (
            <div className="flex h-full w-full items-center justify-center bg-inner">
              <ImageOff className="h-8 w-8 text-muted" strokeWidth={1.5} />
            </div>
          )}
        </div>

        <div className="mt-6 h-8 w-px bg-border" aria-hidden="true" />

        <h2 className="mt-2 font-display text-2xl font-semibold text-ink sm:text-3xl">Find Similar</h2>
        <p className="mt-1.5 max-w-xs text-sm text-ink-soft">
          Your stylist is scanning the racks for pieces that match this one.
        </p>
      </div>

      {confirmedBudget === null ? (
        <div className="mx-auto mt-8 flex max-w-md flex-col items-center gap-4">
          <div className="flex flex-wrap justify-center gap-2">
            {BUDGET_OPTIONS.map((option) => (
              <Button
                key={option.value}
                type="button"
                variant={selectedBudget === option.value ? "primary" : "secondary"}
                onClick={() => setSelectedBudget(option.value)}
                className="w-fit"
              >
                {option.label}
              </Button>
            ))}
          </div>
          <Button type="button" onClick={handleFindSimilar} disabled={!selectedBudget} className="w-fit">
            <Sparkles className="h-4 w-4" strokeWidth={2} />
            Find Similar
          </Button>
        </div>
      ) : (
        <>
          <div className="mt-8 flex items-center justify-center gap-3">
            <Button
              type="button"
              variant="secondary"
              onClick={showNext}
              disabled={loading || !canShowMore}
              className="w-fit"
            >
              <Shuffle className="h-4 w-4" strokeWidth={2} />
              Shuffle Matches
            </Button>
            <Button type="button" variant="secondary" onClick={handleChangeBudget} className="w-fit">
              Change budget
            </Button>
          </div>

          <div className="mt-8">
            {loading ? (
              <LoadingCards />
            ) : displayed.length === 0 ? (
              <p className="mt-4 text-center text-sm text-ink-soft">
                Nothing in that range yet — try a wider budget.
              </p>
            ) : (
              <AnimatePresence mode="wait">
                <motion.div
                  key={displayed.map((l) => l.id).join(",")}
                  initial={{ opacity: 0, y: 14 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -14 }}
                  transition={{ duration: 0.35, ease: "easeOut" }}
                  className="grid grid-cols-3 gap-3 sm:gap-5"
                >
                  {displayed.map((listing, index) => (
                    <MatchResultCard key={listing.id} listing={listing} rank={index} />
                  ))}
                </motion.div>
              </AnimatePresence>
            )}
          </div>
        </>
      )}
    </section>
  );
}

function LoadingCards() {
  return (
    <div className="grid grid-cols-3 gap-3 sm:gap-5">
      {[0, 1, 2].map((index) => (
        <motion.div
          key={index}
          className="aspect-[3/4] rounded-card bg-inner"
          animate={{ opacity: [0.5, 0.9, 0.5] }}
          transition={{ duration: 1.4, repeat: Infinity, ease: "easeInOut", delay: index * 0.15 }}
        />
      ))}
    </div>
  );
}
