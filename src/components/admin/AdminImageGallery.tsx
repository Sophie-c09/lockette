"use client";

import { useState, type CSSProperties } from "react";
import { Swiper, SwiperSlide } from "swiper/react";
import { Navigation, Pagination, Thumbs, FreeMode } from "swiper/modules";
import type { Swiper as SwiperInstance } from "swiper";
import { ImageOff, X } from "lucide-react";

import "swiper/css";
import "swiper/css/navigation";
import "swiper/css/pagination";
import "swiper/css/thumbs";
import "swiper/css/free-mode";

// Swiper-based photo viewer for the /admin/listings moderation dashboard
// (AdminListingCard.tsx) — a large main Swiper (arrows + pagination dots,
// swipeable on mobile) with a synced thumbnail strip below it, matching
// this task's own spec. Deliberately admin-only: the public Discover feed
// still uses ImageCarousel.tsx (a smaller, purpose-built component for a
// grid card, not this file) — this component is never imported from
// anywhere outside src/components/admin/.
//
// Delete lives ONLY on the main swiper's slides (large, easy to hit),
// not duplicated onto the small thumbnail strip — a delete button on a
// 56px-tall thumbnail would be nearly impossible to tap accurately on
// mobile, and thumbnails are a navigation aid, not an action surface, in
// every other gallery convention.
export function AdminImageGallery({
  images,
  alt,
  onDeleteImage,
}: {
  images: string[];
  alt: string;
  // Index into the CURRENT images array — parent owns actually removing
  // it from listing.images and persisting that to Supabase (see
  // AdminListingCard.tsx's handleDeleteImage), this component only ever
  // renders whatever `images` it's given.
  onDeleteImage: (index: number) => void;
}) {
  const [thumbsSwiper, setThumbsSwiper] = useState<SwiperInstance | null>(null);

  if (images.length === 0) {
    return (
      <div className="flex aspect-square w-full items-center justify-center bg-inner">
        <ImageOff className="h-10 w-10 text-muted" strokeWidth={1.5} />
      </div>
    );
  }

  return (
    <div className="w-full">
      <Swiper
        modules={[Navigation, Pagination, Thumbs]}
        navigation
        pagination={{ clickable: true }}
        thumbs={{ swiper: thumbsSwiper }}
        className="admin-gallery-main aspect-square w-full bg-inner"
        style={
          {
            "--swiper-navigation-color": "var(--color-oxblood)",
            "--swiper-pagination-color": "var(--color-oxblood)",
            "--swiper-navigation-size": "22px",
          } as CSSProperties
        }
      >
        {images.map((src, index) => (
          <SwiperSlide key={src}>
            <div className="relative h-full w-full">
              {/* eslint-disable-next-line @next/next/no-img-element -- arbitrary external marketplace domain, not known in advance */}
              <img
                src={src}
                alt={`${alt} — photo ${index + 1} of ${images.length}`}
                className="h-full w-full object-cover"
              />
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  onDeleteImage(index);
                }}
                aria-label={`Delete photo ${index + 1}`}
                className="absolute right-2 top-2 z-10 flex h-8 w-8 cursor-pointer items-center justify-center rounded-full bg-black/60 text-white transition-colors hover:bg-oxblood"
              >
                <X className="h-4 w-4" strokeWidth={2.5} />
              </button>
            </div>
          </SwiperSlide>
        ))}
      </Swiper>

      {images.length > 1 && (
        <Swiper
          modules={[Thumbs, FreeMode]}
          onSwiper={setThumbsSwiper}
          watchSlidesProgress
          freeMode
          slidesPerView={4.5}
          spaceBetween={8}
          className="admin-gallery-thumbs mt-2 h-16 w-full px-1"
        >
          {images.map((src, index) => (
            <SwiperSlide key={src} className="h-16 cursor-pointer overflow-hidden rounded-card">
              {/* eslint-disable-next-line @next/next/no-img-element -- arbitrary external marketplace domain, not known in advance */}
              <img src={src} alt={`Thumbnail ${index + 1}`} className="h-full w-full object-cover" />
            </SwiperSlide>
          ))}
        </Swiper>
      )}
    </div>
  );
}
