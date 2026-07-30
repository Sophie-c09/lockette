import type { TagVariant } from "@/components/ui/Badge";

// Purely presentational — translates a candidate's POSITION in an
// already-ranked pool (fetchSimilarListings' shared-tag sort,
// fetchGarmentCandidates' garment-attribute score sort — see
// src/lib/garment-matching.ts) into a qualitative "how strong is this
// match" label. No new scoring happens here: rank order already comes
// from the real ranking logic, this only labels it in stylist language
// instead of a raw percentage, per this redesign's "premium AI stylist,
// not a search engine" goal.
export type MatchConfidenceTone = "strong" | "medium" | "soft";

export interface MatchConfidence {
  label: string;
  tone: MatchConfidenceTone;
}

export function matchConfidenceForRank(rank: number): MatchConfidence {
  if (rank === 0) return { label: "Best Match", tone: "strong" };
  if (rank <= 2) return { label: "Great Match", tone: "strong" };
  if (rank <= 5) return { label: "Good Match", tone: "medium" };
  return { label: "Match", tone: "soft" };
}

export function matchConfidenceBadgeVariant(tone: MatchConfidenceTone): TagVariant {
  if (tone === "strong") return "pink";
  if (tone === "medium") return "teal";
  return "yellow";
}
