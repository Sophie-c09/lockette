"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Camera, Gift, Wand2, WandSparkles } from "lucide-react";

// Main-nav entry point for the three personal-styling features — rendered
// in Nav.tsx alongside (not inside) NavTabs, same reasoning as
// NotificationBell: NavTabs' sliding underline is driven by measuring the
// DOM position of each *navigable tab* it owns, and a dropdown trigger
// isn't a single destination the underline could point at. Click-outside-
// to-close follows NotificationBell.tsx's own pattern exactly, for the
// same look/feel across both nav dropdowns.
const STYLE_FEATURES = [
  { href: "/style-request", icon: Wand2, label: "Create a styled bundle" },
  { href: "/style-me", icon: Gift, label: "Get personalized outfits" },
  { href: "/recreate-outfit", icon: Camera, label: "Recreate this outfit" },
] as const;

export function StyleFeaturesMenu() {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-label="Personal styling"
        aria-expanded={open}
        className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-full text-ink-soft transition-colors hover:text-ink"
      >
        <WandSparkles className="h-5 w-5" strokeWidth={1.75} />
      </button>

      {open && (
        <div className="absolute right-0 top-full z-40 mt-2 w-72 max-w-[90vw] overflow-hidden rounded-card border border-border bg-surface shadow-card">
          {STYLE_FEATURES.map(({ href, icon: Icon, label }) => (
            <Link
              key={href}
              href={href}
              onClick={() => setOpen(false)}
              className="flex items-center gap-3 border-b border-border/60 p-3 text-left text-sm font-medium text-ink last:border-b-0 hover:bg-inner"
            >
              <Icon className="h-4 w-4 shrink-0 text-oxblood" strokeWidth={1.75} />
              {label}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
