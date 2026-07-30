import Link from "next/link";
import { Camera, Gift, Wand2 } from "lucide-react";

// Shared discoverability entry point for the three personal-styling
// features (Get Styled, Style Me, Recreate This Outfit) — dropped into
// Discover, Match, and Listing Detail (see each of those files' own
// comment on placement) so users encounter them while browsing, not only
// on Profile. Pure navigation: no form/submission logic lives here, all of
// that stays exactly where it already was (StyleRequestForm.tsx,
// StyleMeForm.tsx, RecreateOutfitForm.tsx) — this is only a set of Links to
// the existing routes. Icons match ProfileView.tsx's own choices for each
// feature (Wand2/Gift/Camera) so the same feature reads the same way
// wherever a user encounters it.
const STYLE_FEATURES = [
  { href: "/style-request", icon: Wand2, label: "Create a styled bundle" },
  { href: "/style-me", icon: Gift, label: "Get personalized outfits" },
  { href: "/recreate-outfit", icon: Camera, label: "Recreate this outfit" },
] as const;

export function StyleFeaturesPromo({ className = "" }: { className?: string }) {
  return (
    <div className={`flex flex-wrap items-center justify-center gap-2.5 ${className}`}>
      {STYLE_FEATURES.map(({ href, icon: Icon, label }) => (
        <Link
          key={href}
          href={href}
          className="inline-flex items-center gap-2 rounded-pill border border-border bg-surface px-4 py-2 text-sm font-medium text-ink-soft transition-colors hover:border-oxblood hover:text-oxblood"
        >
          <Icon className="h-4 w-4" strokeWidth={1.75} />
          {label}
        </Link>
      ))}
    </div>
  );
}
