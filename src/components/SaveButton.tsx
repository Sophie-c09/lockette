"use client";

import { useState, useTransition, type MouseEvent } from "react";
import { Heart } from "lucide-react";
import { saveListing, unsaveListing } from "@/app/actions/saved-items";

// Reusable heart toggle for a real (Supabase-backed) listing. Optimistic:
// flips instantly, then persists — and reverts only if the server action
// reports an actual error (a signed-out click still no-ops the same way
// saveItem/unsaveItem already do elsewhere in the app, so anonymous
// browsing stays seamless).
export function SaveButton({
  listingId,
  initialSaved,
  className = "",
}: {
  listingId: string;
  initialSaved: boolean;
  className?: string;
}) {
  const [saved, setSaved] = useState(initialSaved);
  const [isPending, startTransition] = useTransition();

  function handleClick(event: MouseEvent<HTMLButtonElement>) {
    // Save buttons sit inside clickable listing cards — never let the click
    // bubble into the card's own navigate-to-detail handler.
    event.preventDefault();
    event.stopPropagation();

    const next = !saved;
    setSaved(next);

    startTransition(async () => {
      const result = next
        ? await saveListing(listingId)
        : await unsaveListing(listingId);
      if (result.error) {
        setSaved(!next);
      }
    });
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={isPending}
      aria-pressed={saved}
      aria-label={saved ? "Remove from saved" : "Save listing"}
      className={`flex h-8 w-8 cursor-pointer items-center justify-center rounded-full bg-surface/70 text-oxblood backdrop-blur-sm transition-all duration-150 ease-out hover:bg-surface/90 active:scale-90 disabled:pointer-events-none ${className}`}
    >
      <Heart
        className={`h-4 w-4 transition-transform duration-150 ease-out ${saved ? "scale-110" : "scale-100"}`}
        strokeWidth={2}
        fill={saved ? "currentColor" : "none"}
      />
    </button>
  );
}
