import { Badge } from "@/components/ui/Badge";
import { ListingCard } from "@/components/listing/ListingCard";
import { matchConfidenceForRank, matchConfidenceBadgeVariant } from "@/lib/match-confidence";
import type { Listing } from "@/lib/supabase/listings.types";

// Shared result card for both reverse-search features (Find Similar /
// Find This Look) — reuses ListingCard as-is (image, title, brand/size,
// price, marketplace/platform tag, hover lift all come for free from that
// shared component) and adds only a qualitative match-confidence badge on
// top, positioned as a sibling overlay rather than passed through
// ListingCard's own numeric `matchScore` prop — this redesign's brief
// asks for stylist-style language ("Best Match"), not a raw percentage.
export function MatchResultCard({ listing, rank }: { listing: Listing; rank: number }) {
  const confidence = matchConfidenceForRank(rank);

  return (
    <div className="relative">
      <Badge
        variant={matchConfidenceBadgeVariant(confidence.tone)}
        className="absolute left-2 top-2 z-10 shadow-soft"
      >
        {confidence.label}
      </Badge>
      <ListingCard listing={listing} />
    </div>
  );
}
