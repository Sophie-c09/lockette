"use client";

// P0 first-60-seconds fix (item 9) — expanded from 8 brands (a static
// image-tile grid, BrandCard.tsx) to a searchable, alphabetical chip list
// covering the full BRANDS array (src/lib/onboarding-data.ts, ~65 brands).
// A tile-per-brand grid doesn't scale past a handful of options — this
// reuses the exact search-input styling SearchView.tsx already
// established elsewhere in the app and the same selectable-pill ("Chip")
// language StepPreferences.tsx uses one step later in this same flow, so
// the visual language stays consistent within onboarding rather than
// introducing a third pattern.
import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import { BRANDS, MIN_BRANDS_REQUIRED } from "@/lib/onboarding-data";
import { Chip } from "@/components/ui/Chip";

export { MIN_BRANDS_REQUIRED };

export function StepBrands({
  selected,
  onToggle,
}: {
  selected: string[];
  onToggle: (id: string) => void;
}) {
  const [query, setQuery] = useState("");

  // Already alphabetical in onboarding-data.ts, but sorting again here is
  // cheap insurance against that array ever drifting out of order, and
  // keeps this component correct on its own terms.
  const sortedBrands = useMemo(() => [...BRANDS].sort((a, b) => a.name.localeCompare(b.name)), []);

  const filteredBrands = useMemo(() => {
    const trimmed = query.trim().toLowerCase();
    if (!trimmed) return sortedBrands;
    return sortedBrands.filter((brand) => brand.name.toLowerCase().includes(trimmed));
  }, [sortedBrands, query]);

  const remaining = Math.max(0, MIN_BRANDS_REQUIRED - selected.length);

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
          Pick at least {MIN_BRANDS_REQUIRED} — we&apos;ll prioritize secondhand finds from labels
          you already trust.
        </p>
      </div>

      <div className="mx-auto max-w-2xl">
        <div className="relative mb-4">
          <Search
            className="pointer-events-none absolute top-1/2 left-4 h-5 w-5 -translate-y-1/2 text-ink-soft"
            strokeWidth={1.75}
          />
          <input
            type="text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search brands..."
            className="w-full rounded-2xl border border-border bg-surface py-3 pr-4 pl-12 text-sm text-ink placeholder:text-ink-soft/60 focus:border-oxblood focus:outline-none"
          />
        </div>

        <p className="mb-3 text-center text-xs font-medium text-ink-soft">
          {selected.length} selected
          {remaining > 0 && ` · choose ${remaining} more`}
        </p>

        <div className="scroll-smooth max-h-[360px] overflow-y-auto rounded-2xl border border-border bg-inner/40 p-4">
          {filteredBrands.length === 0 ? (
            <p className="py-8 text-center text-sm text-ink-soft">No brands match &quot;{query}&quot;.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {filteredBrands.map((brand) => (
                <Chip
                  key={brand.id}
                  label={brand.name}
                  swatchColor={brand.color}
                  selected={selected.includes(brand.id)}
                  onClick={() => onToggle(brand.id)}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
