import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { fetchMatchBatch, MATCH_BATCH_SIZE } from "@/lib/match-feed";
import { MatchView } from "@/components/match/MatchView";
import { RetryButton } from "@/components/ui/RetryButton";

export const metadata: Metadata = {
  title: "Match — Lockette",
};

export default async function MatchPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { listings, error } = await fetchMatchBatch(0, MATCH_BATCH_SIZE);

  if (error) {
    return (
      <div className="flex min-h-[calc(100vh-137px)] items-center justify-center px-6 text-center">
        <div className="mx-auto flex max-w-md flex-col items-center gap-4 rounded-card bg-highlight-cream px-8 py-16 text-center">
          <p className="text-sm text-ink-soft">
            Something went wrong loading your matches.
          </p>
          <RetryButton />
        </div>
      </div>
    );
  }

  return (
    <MatchView
      initialListings={listings}
      initialOffset={MATCH_BATCH_SIZE}
      isSignedIn={Boolean(user)}
    />
  );
}
