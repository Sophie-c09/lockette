"use client";

import { useState, useTransition, type MouseEvent } from "react";
import { Heart } from "lucide-react";
import { saveListing, unsaveListing } from "@/app/actions/saved-items";
import { useToast } from "@/components/ToastProvider";

// Reusable heart toggle for a real (Supabase-backed) listing. Optimistic:
// flips instantly, then persists — and reverts if the server action
// reports an actual error.
//
// P0 launch-readiness fix — a signed-out click (or any other failure) used
// to revert the heart with zero explanation: the error message
// ("Sign in to save listings.") was already returned by saveListing/
// unsaveListing, it was just never shown anywhere. Now surfaced via a
// toast so an unauthenticated visitor gets a real, actionable prompt
// instead of a heart that silently un-fills itself.
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
  const { showToast } = useToast();

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
        showToast(result.error);
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
      className={`flex h-10 w-10 cursor-pointer items-center justify-center rounded-full bg-surface/70 text-oxblood backdrop-blur-sm transition-all duration-150 ease-out hover:bg-surface/90 active:scale-90 disabled:pointer-events-none ${className}`}
    >
      <Heart
        className={`h-5 w-5 transition-transform duration-150 ease-out ${saved ? "scale-110" : "scale-100"}`}
        strokeWidth={2}
        fill={saved ? "currentColor" : "none"}
      />
    </button>
  );
}
