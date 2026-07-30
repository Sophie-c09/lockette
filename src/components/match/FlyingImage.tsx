"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import Image from "next/image";

const FLIGHT_DURATION_MS = 500;
const FLIGHT_SCALE = 0.3;

export type FlyingItem = {
  id: number;
  image: string;
  from: DOMRect;
  to: DOMRect;
};

// Clones a superliked item's image and animates it from the card's position
// to the Cart button's position, then calls onDone so the caller can drop it
// from state. Rendered through a portal straight to <body> so the fixed
// coordinates aren't affected by the card stack's own Framer Motion
// transforms.
export function FlyingImage({
  flying,
  onDone,
}: {
  flying: FlyingItem;
  onDone: () => void;
}) {
  const [inFlight, setInFlight] = useState(false);

  useEffect(() => {
    const frame = requestAnimationFrame(() => setInFlight(true));
    const timeout = setTimeout(onDone, FLIGHT_DURATION_MS + 20);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timeout);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const { from, to, image } = flying;
  const deltaX = to.left + to.width / 2 - (from.left + from.width / 2);
  const deltaY = to.top + to.height / 2 - (from.top + from.height / 2);

  return createPortal(
    <div
      aria-hidden
      className="pointer-events-none fixed z-[60] overflow-hidden rounded-card shadow-card"
      style={{
        top: from.top,
        left: from.left,
        width: from.width,
        height: from.height,
        transition: `transform ${FLIGHT_DURATION_MS}ms ease-in-out`,
        transform: inFlight
          ? `translate(${deltaX}px, ${deltaY}px) scale(${FLIGHT_SCALE})`
          : "translate(0, 0) scale(1)",
      }}
    >
      <Image src={image} alt="" fill className="object-cover" sizes="200px" />
    </div>,
    document.body,
  );
}
