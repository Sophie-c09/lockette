"use client";

import Image from "next/image";
import { motion } from "motion/react";
import type { MoodImage } from "@/lib/moodboard-data";

const HEIGHTS = ["h-56", "h-72", "h-64", "h-80", "h-60", "h-96", "h-68"];

export function Moodboard({ images }: { images: MoodImage[] }) {
  return (
    <div className="columns-2 gap-3 sm:columns-3 sm:gap-4 lg:columns-4">
      {images.map((image, index) => (
        <motion.div
          key={`${image.src}-${index}`}
          initial={{ opacity: 0, y: 24 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-40px" }}
          transition={{ duration: 0.4, delay: (index % 8) * 0.05 }}
          className={`relative mb-3 break-inside-avoid overflow-hidden rounded-card shadow-soft sm:mb-4 ${HEIGHTS[index % HEIGHTS.length]}`}
        >
          <Image
            src={image.src}
            alt={image.alt}
            fill
            className="object-cover"
            sizes="(min-width: 1024px) 23vw, (min-width: 640px) 31vw, 47vw"
          />
        </motion.div>
      ))}
    </div>
  );
}
