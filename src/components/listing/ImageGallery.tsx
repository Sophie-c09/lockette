"use client";

import { useRef, useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, ImageOff } from "lucide-react";

// Desktop: large main image + a click-to-switch thumbnail row underneath.
// Mobile: a native scroll-snap carousel (no drag library needed — swiping
// the row is just horizontal scrolling). Both share the same activeIndex
// state and the same prev/next arrow controls, which is why this renders
// both layouts and toggles visibility with Tailwind's responsive classes
// rather than picking one at mount time.
export function ImageGallery({
  images,
  alt,
  overlay,
}: {
  images: string[];
  alt: string;
  overlay?: ReactNode;
}) {
  // Defense in depth: callers are expected to already pass a clean string[]
  // (see ListingDetailView), but this component never trusts that on its
  // own — a null/undefined/non-array/non-string-entry prop degrades to the
  // empty-gallery state instead of throwing.
  const safeImages = Array.isArray(images)
    ? images.filter((src): src is string => typeof src === "string" && src.length > 0)
    : [];

  const [activeIndex, setActiveIndex] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const boundedIndex = safeImages.length > 0 ? activeIndex % safeImages.length : 0;

  function goTo(index: number) {
    if (safeImages.length === 0) return;
    const next = (index + safeImages.length) % safeImages.length;
    setActiveIndex(next);
    const container = scrollRef.current;
    if (container) {
      container.scrollTo({ left: next * container.clientWidth, behavior: "smooth" });
    }
  }

  function handleScroll() {
    const container = scrollRef.current;
    if (!container || container.clientWidth === 0) return;
    const index = Math.round(container.scrollLeft / container.clientWidth);
    if (index !== activeIndex) setActiveIndex(index);
  }

  return (
    <div>
      <div className="relative aspect-square overflow-hidden rounded-card bg-inner sm:aspect-[4/5]">
        {safeImages.length === 0 ? (
          <div className="flex h-full w-full items-center justify-center">
            <ImageOff className="h-10 w-10 text-muted" strokeWidth={1.5} />
          </div>
        ) : (
          <>
            <div
              ref={scrollRef}
              onScroll={handleScroll}
              className="flex h-full snap-x snap-mandatory overflow-x-auto sm:hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            >
              {safeImages.map((src, index) => (
                // eslint-disable-next-line @next/next/no-img-element -- arbitrary external marketplace domain, not known in advance
                <img
                  key={src}
                  src={src}
                  alt={`${alt} — photo ${index + 1} of ${safeImages.length}`}
                  className="h-full w-full shrink-0 snap-center object-cover"
                />
              ))}
            </div>

            {/* eslint-disable-next-line @next/next/no-img-element -- arbitrary external marketplace domain, not known in advance */}
            <img
              src={safeImages[boundedIndex]}
              alt={`${alt} — photo ${boundedIndex + 1} of ${safeImages.length}`}
              className="hidden h-full w-full object-cover sm:block"
            />

            {safeImages.length > 1 && (
              <>
                <button
                  type="button"
                  onClick={() => goTo(boundedIndex - 1)}
                  aria-label="Previous image"
                  className="absolute left-2 top-1/2 z-10 flex h-8 w-8 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full bg-darkgreen/45 text-white transition-colors hover:bg-oxblood"
                >
                  <ChevronLeft className="h-4 w-4" strokeWidth={2.5} />
                </button>
                <button
                  type="button"
                  onClick={() => goTo(boundedIndex + 1)}
                  aria-label="Next image"
                  className="absolute right-2 top-1/2 z-10 flex h-8 w-8 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full bg-darkgreen/45 text-white transition-colors hover:bg-oxblood"
                >
                  <ChevronRight className="h-4 w-4" strokeWidth={2.5} />
                </button>
              </>
            )}
          </>
        )}

        {overlay}
      </div>

      {safeImages.length > 1 && (
        <div className="mt-3 hidden gap-2 sm:flex">
          {safeImages.map((src, index) => (
            <button
              key={src}
              type="button"
              onClick={() => goTo(index)}
              aria-label={`View photo ${index + 1}`}
              aria-pressed={index === boundedIndex}
              className={`h-16 w-16 shrink-0 cursor-pointer overflow-hidden rounded-card border-2 transition-colors ${
                index === boundedIndex ? "border-oxblood" : "border-transparent"
              }`}
            >
              {/* eslint-disable-next-line @next/next/no-img-element -- arbitrary external marketplace domain, not known in advance */}
              <img src={src} alt={`${alt} thumbnail ${index + 1}`} className="h-full w-full object-cover" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
