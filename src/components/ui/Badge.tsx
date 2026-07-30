import type { ReactNode } from "react";

export type TagVariant = "pink" | "teal" | "yellow";

const VARIANT_STYLES: Record<TagVariant, string> = {
  pink: "bg-tag-pink text-tag-pink-ink",
  teal: "bg-tag-teal text-tag-teal-ink",
  yellow: "bg-tag-yellow text-tag-yellow-ink",
};

const VARIANT_CYCLE: TagVariant[] = ["pink", "teal", "yellow"];

// Cycles through the tag palette by list position, so a row of tags reads as
// curated and varied rather than one flat color repeated down the line.
export function tagVariantForIndex(index: number): TagVariant {
  return VARIANT_CYCLE[index % VARIANT_CYCLE.length];
}

export function Badge({
  children,
  variant = "pink",
  className = "",
}: {
  children: ReactNode;
  variant?: TagVariant;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex items-center rounded-pill px-3 py-1.5 text-xs font-medium ${VARIANT_STYLES[variant]} ${className}`}
    >
      {children}
    </span>
  );
}
