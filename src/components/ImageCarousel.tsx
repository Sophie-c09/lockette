"use client";

import { useRef, useState, type MouseEvent, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, ImageOff } from "lucide-react";

// Compact, card-sized image carousel — reusable across any grid/list
// context that shows one listing at a time in a fixed-aspect box (Discover
// cards via ListingCard.tsx, the admin moderation dashboard via
// AdminListingsView.tsx). Deliberately NOT the same component as
// src/components/listing/ImageGallery.tsx (the listing detail page's own
// gallery): that one adds a desktop thumbnail strip sized for a full page,
// which would overwhelm a small grid card — this one is just the
// swipe/arrow/dot-indicator interaction, at whatever size the parent's
// aspect-ratio wrapper gives it.
//
// Mobile: a native scroll-snap row (swiping is just horizontal scroll, no
// drag library needed). Desktop: click-through arrows. Both share the same
// activeIndex state, same as ImageGallery.tsx's own approach.
export function ImageCarousel({
  images,
  alt,
  overlay,
  className = "",
}: {
  images: (string | null | undefined)[] | null | undefined;
  alt: string;
  // Rendered on top of the image area (badges, buttons, etc.) — same
  // pattern as ImageGallery.tsx's own `overlay` prop.
  overlay?: ReactNode;
  className?: string;
}) {
  // Defense in depth — callers pass whatever a listing row happens to
  // have (images?: string[] | null, sometimes mixed with a null/undefined
  // entry), never trusted as already-clean.
  const safeImages = Array.isArray(images)
    ? images.filter((src): src is string => typeof src === "string" && src.length > 0)
    : [];

  const [activeIndex, setActiveIndex] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const boundedIndex = safeImages.length > 0 ? activeIndex % safeImages.length : 0;

  function goTo(event: MouseEvent, index: number) {
    event.stopPropagation();
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
    <div className={`relative h-full w-full overflow-hidden bg-inner ${className}`}>
      {safeImages.length === 0 ? (
        <div className="flex h-full w-full items-center justify-center">
          <ImageOff className="h-8 w-8 text-muted" strokeWidth={1.5} />
        </div>
      ) : (
        <>
          {/* Mobile: native scroll-snap swipe row. */}
          <div
            ref={scrollRef}
            onScroll={handleScroll}
            className="flex h-full snap-x snap-mandatory overflow-x-auto [scrollbar-width:none] sm:hidden [&::-webkit-scrollbar]:hidden"
          >
            {safeImages.map((src, index) => (
              // eslint-disable-next-line @next/next/no-img-element -- arbitrary external marketplace domain, not known in advance
              <img
                key={src}
                src={src}
                alt={`${alt} — photo ${index + 1} of ${safeImages.length}`}
                loading={index === 0 ? "eager" : "lazy"}
                className="h-full w-full shrink-0 snap-center object-cover"
              />
            ))}
          </div>

          {/* Desktop/tablet: single image + click-through arrows. */}
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
                onClick={(event) => goTo(event, boundedIndex - 1)}
                aria-label="Previous photo"
                className="absolute left-1.5 top-1/2 z-10 hidden h-9 w-9 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full bg-surface/60 text-ink backdrop-blur-sm transition-colors hover:bg-surface/85 sm:flex"
              >
                <ChevronLeft className="h-4 w-4" strokeWidth={2.5} />
              </button>
              <button
                type="button"
                onClick={(event) => goTo(event, boundedIndex + 1)}
                aria-label="Next photo"
                className="absolute right-1.5 top-1/2 z-10 hidden h-9 w-9 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full bg-surface/60 text-ink backdrop-blur-sm transition-colors hover:bg-surface/85 sm:flex"
              >
                <ChevronRight className="h-4 w-4" strokeWidth={2.5} />
              </button>

              {/* Position indicators — "● ○ ○ ○" style dots. Each button's
                  own tappable box is bigger than the visible dot (a
                  centered inner span) so the touch target grows without
                  the dots themselves looking oversized. */}
              <div className="absolute bottom-2 left-1/2 z-10 flex -translate-x-1/2 items-center">
                {safeImages.map((src, index) => (
                  <button
                    key={src}
                    type="button"
                    onClick={(event) => goTo(event, index)}
                    aria-label={`Go to photo ${index + 1}`}
                    aria-current={index === boundedIndex}
                    className="flex h-6 w-6 cursor-pointer items-center justify-center"
                  >
                    <span
                      className={`h-1.5 w-1.5 rounded-full transition-colors ${
                        index === boundedIndex ? "bg-white" : "bg-white/50"
                      }`}
                    />
                  </button>
                ))}
              </div>
            </>
          )}
        </>
      )}

      {overlay}
    </div>
  );
}
