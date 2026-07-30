"use client";

// Part 7 of the recommendation-integration architecture — real search
// debugging: look up any listing or user by id and see exactly what the
// AI pipeline knows. Deliberately utilitarian (raw values, no polish) —
// this is an internal admin tool, not a user-facing feature.
import { useState } from "react";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { getListingDebugInfo, getUserDebugInfo, type ListingDebugInfo, type UserDebugInfo } from "@/app/actions/admin-debug";

function StatusPill({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className={`rounded-pill px-2.5 py-1 text-xs font-medium ${ok ? "bg-tag-teal text-tag-teal-ink" : "bg-inner text-ink-soft"}`}>
      {ok ? "✓" : "✗"} {label}
    </span>
  );
}

function ListingDebugPanel() {
  const [listingId, setListingId] = useState("");
  const [info, setInfo] = useState<ListingDebugInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleLookup() {
    if (!listingId.trim()) return;
    setLoading(true);
    setError(null);
    setInfo(null);
    const result = await getListingDebugInfo(listingId.trim());
    setLoading(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    setInfo(result.info ?? null);
  }

  return (
    <Card className="p-6">
      <p className="font-display text-lg font-semibold text-ink">Listing debug</p>
      <div className="mt-3 flex gap-2">
        <input
          type="text"
          value={listingId}
          onChange={(event) => setListingId(event.target.value)}
          placeholder="Listing UUID"
          className="flex-1 rounded-2xl border border-border bg-surface px-4 py-2 text-sm text-ink focus:border-oxblood focus:outline-none"
        />
        <Button type="button" onClick={handleLookup} disabled={loading}>
          {loading ? "Looking up..." : "Look up"}
        </Button>
      </div>

      {error && <p className="mt-3 text-sm text-oxblood">{error}</p>}

      {info && (
        <div className="mt-4 flex flex-col gap-3 text-sm text-ink">
          <p className="font-semibold">{info.title}</p>
          <div className="flex flex-wrap gap-2">
            <StatusPill ok={info.hasVisualAnalysis} label="Visual analysis" />
            <StatusPill ok={info.hasVisualEmbedding} label={`Vector embedding${info.visualEmbeddingDimensions ? ` (${info.visualEmbeddingDimensions}d)` : ""}`} />
            <StatusPill ok={info.hasImageEmbedding} label="Legacy image embedding" />
          </div>
          <p>
            Quality score: <span className="font-semibold">{info.inventoryQualityScore ?? "not yet scored"}</span>
          </p>
          <p>
            Image hash: <span className="font-mono text-xs">{info.imageHash ?? "none"}</span>
          </p>
          <p>Last verified: {info.lastVerifiedAt ? new Date(info.lastVerifiedAt).toLocaleString() : "never"}</p>

          {info.visualAnalysis && (
            <pre className="overflow-x-auto rounded-2xl bg-inner/60 p-3 text-xs text-ink-soft">
              {JSON.stringify(info.visualAnalysis, null, 2)}
            </pre>
          )}

          <div>
            <p className="font-medium">Top similar listings:</p>
            {info.topSimilarListings.length === 0 ? (
              <p className="text-ink-soft">None (no embedding yet, or nothing similar found).</p>
            ) : (
              <ul className="mt-1 flex flex-col gap-1">
                {info.topSimilarListings.map((match) => (
                  <li key={match.id} className="text-ink-soft">
                    {match.title} — similarity {match.similarity.toFixed(3)}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}

function UserDebugPanel() {
  const [userId, setUserId] = useState("");
  const [info, setInfo] = useState<UserDebugInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleLookup() {
    if (!userId.trim()) return;
    setLoading(true);
    setError(null);
    setInfo(null);
    const result = await getUserDebugInfo(userId.trim());
    setLoading(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    setInfo(result.info ?? null);
  }

  return (
    <Card className="p-6">
      <p className="font-display text-lg font-semibold text-ink">User debug</p>
      <div className="mt-3 flex gap-2">
        <input
          type="text"
          value={userId}
          onChange={(event) => setUserId(event.target.value)}
          placeholder="User UUID"
          className="flex-1 rounded-2xl border border-border bg-surface px-4 py-2 text-sm text-ink focus:border-oxblood focus:outline-none"
        />
        <Button type="button" onClick={handleLookup} disabled={loading}>
          {loading ? "Looking up..." : "Look up"}
        </Button>
      </div>

      {error && <p className="mt-3 text-sm text-oxblood">{error}</p>}

      {info && (
        <div className="mt-4 flex flex-col gap-3 text-sm text-ink">
          <StatusPill ok={info.hasStyleEmbedding} label="Style embedding" />
          <p>
            Preferred aesthetics: <span className="font-medium">{info.preferredAesthetics.join(", ") || "none stated"}</span>
          </p>
          <p>
            Favorite brands: <span className="font-medium">{info.favoriteBrands.join(", ") || "none stated"}</span>
          </p>
          <p>
            Favorite categories: <span className="font-medium">{info.favoriteCategories.join(", ") || "none stated"}</span>
          </p>
          <p>
            Favorite colors: <span className="font-medium">{info.favoriteColors.join(", ") || "none stated"}</span>
          </p>

          {info.sampleRecommendationReasoning && (
            <div className="rounded-2xl bg-inner/60 p-3">
              <p className="font-medium">Sample recommendation reasoning</p>
              <p className="mt-1 text-ink-soft">
                Against &quot;{info.sampleRecommendationReasoning.listingTitle}&quot;: score{" "}
                {info.sampleRecommendationReasoning.score.toFixed(2)} — {info.sampleRecommendationReasoning.reasoning}
              </p>
            </div>
          )}

          <div>
            <p className="font-medium">Recent feedback:</p>
            {info.recentFeedback.length === 0 ? (
              <p className="text-ink-soft">No recorded feedback yet.</p>
            ) : (
              <ul className="mt-1 flex flex-col gap-1">
                {info.recentFeedback.map((entry, index) => (
                  <li key={index} className="text-ink-soft">
                    {entry.action} — {entry.listingId ?? "(no listing)"} — {new Date(entry.createdAt).toLocaleString()}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}

export function AiDebugView() {
  return (
    <div className="min-h-[calc(100vh-137px)] px-6 py-16">
      <div className="mx-auto flex max-w-2xl flex-col gap-6">
        <div className="text-center">
          <span className="font-display text-sm uppercase tracking-[0.2em] text-oxblood">Admin</span>
          <h1 className="mt-2 font-display text-3xl font-semibold text-ink sm:text-4xl">AI Search Debug</h1>
          <p className="mt-2 text-sm text-ink-soft">Inspect what the AI pipeline actually knows about a listing or a user.</p>
        </div>

        <ListingDebugPanel />
        <UserDebugPanel />
      </div>
    </div>
  );
}
