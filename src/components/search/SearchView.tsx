"use client";

import { useMemo, useState } from "react";
import Image from "next/image";
import { Search } from "lucide-react";
import { MOCK_CLOTHING, type ClothingItem } from "@/lib/mock-clothing";
import { getTopAesthetics } from "@/lib/aesthetics";

export function SearchView({ likedItems }: { likedItems: ClothingItem[] }) {
  const [query, setQuery] = useState("");

  const topAesthetics = useMemo(
    () => getTopAesthetics(likedItems),
    [likedItems],
  );

  const hasQuery = query.trim().length > 0;

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();

    if (q) {
      return MOCK_CLOTHING.filter(
        (item) =>
          item.name.toLowerCase().includes(q) ||
          item.brand.toLowerCase().includes(q) ||
          item.aesthetics.some((aesthetic) =>
            aesthetic.toLowerCase().includes(q),
          ),
      );
    }

    // No query yet — lead with picks matching the aesthetics they like most,
    // or the full catalog if they haven't liked anything yet.
    if (topAesthetics.length === 0) {
      return MOCK_CLOTHING;
    }

    return MOCK_CLOTHING.filter((item) =>
      item.aesthetics.some((aesthetic) => topAesthetics.includes(aesthetic)),
    );
  }, [query, topAesthetics]);

  return (
    <div className="min-h-[calc(100vh-137px)] px-6 pt-12">
      <div className="mx-auto max-w-5xl">
        <div className="mb-8 text-center">
          <span className="font-display text-sm tracking-[0.2em] text-oxblood uppercase">
            Search
          </span>
          <h1 className="mt-2 font-display text-3xl font-semibold text-ink sm:text-4xl">
            Find something specific
          </h1>
        </div>

        <div className="relative mx-auto max-w-2xl">
          <Search
            className="pointer-events-none absolute top-1/2 left-4 h-5 w-5 -translate-y-1/2 text-ink-soft"
            strokeWidth={1.75}
          />
          <input
            type="text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search for items..."
            className="w-full rounded-2xl border border-border bg-surface py-3 pr-4 pl-12 text-sm text-ink placeholder:text-ink-soft/60 focus:border-oxblood focus:outline-none"
          />
        </div>

        <div className="mt-10">
          <p className="mb-4 text-center text-sm font-medium text-ink-soft">
            {hasQuery ? `Results for "${query.trim()}"` : "Recommended for you"}
          </p>

          {results.length > 0 ? (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 lg:grid-cols-4">
              {results.map((item) => (
                <div
                  key={item.id}
                  className="group relative aspect-[3/4] overflow-hidden rounded-card"
                >
                  <Image
                    src={item.image}
                    alt={item.name}
                    fill
                    className="object-cover transition-transform duration-300 ease-out group-hover:scale-105 group-active:scale-95"
                    sizes="(min-width: 1024px) 22vw, (min-width: 640px) 30vw, 45vw"
                  />
                  <div className="absolute inset-x-0 bottom-0 bg-darkgreen/55 p-3">
                    <p className="font-display text-sm font-semibold text-white">
                      {item.name}
                    </p>
                    <p className="text-xs text-white/80">${item.price}</p>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-center">
              <p className="text-sm text-ink-soft">No items found</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
