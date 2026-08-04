"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Search, Sparkles, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import {
  searchActiveListings,
  createBundleForRequest,
  previewAIBundle,
  confirmAIBundle,
  type GeneratedBundlePreview,
} from "@/lib/styleRequestAdmin";
import type { StyleRequestDetail } from "@/lib/styleRequestAdmin";
import type { SelectedCategory } from "@/lib/selected-categories";
import type { CategoryCounts, PriceMode } from "@/lib/bulk-import";
import type { Listing } from "@/lib/supabase/listings.types";

type ScraperPhase = "idle" | "discovering" | "importing" | "done";
type AiPhase = "idle" | "generating" | "previewing" | "confirming";

const BULK_CHUNK_SIZE = 25;
// A style request isn't asking for a huge bulk-import — just enough fresh
// candidates for an admin to hand-pick from, so this stays modest compared
// to /admin/import's 25/100/500 tiers.
const SCRAPE_TARGET = 30;

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

// Maps the request's own budget onto the scraper's existing PriceMode —
// there's no free-text search entry point (confirmed against
// marketplace-discovery.ts), so budget/categories are what actually drive
// "Run Scraper," not the inspo text itself.
function priceModeForBudget(budget: number | null): PriceMode {
  if (budget == null) return "any";
  if (budget <= 10) return "under10";
  if (budget <= 20) return "under20";
  return "any";
}

export function StyleRequestDetailView({ detail }: { detail: StyleRequestDetail }) {
  const router = useRouter();

  const [scraperPhase, setScraperPhase] = useState<ScraperPhase>("idle");
  const [scraperImported, setScraperImported] = useState(0);
  const [scraperError, setScraperError] = useState<string | null>(null);

  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<Listing[]>([]);
  const [searching, setSearching] = useState(false);

  const [selected, setSelected] = useState<Listing[]>(detail.bundle?.items ?? []);
  const [title, setTitle] = useState(detail.bundle?.title ?? "");
  const [description, setDescription] = useState(detail.bundle?.description ?? "");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const [aiPhase, setAiPhase] = useState<AiPhase>("idle");
  const [aiPreview, setAiPreview] = useState<GeneratedBundlePreview | null>(null);
  const [aiError, setAiError] = useState<string | null>(null);

  async function handleGenerateAIBundle() {
    setAiPhase("generating");
    setAiError(null);
    setAiPreview(null);

    const result = await previewAIBundle(detail.id);

    if (result.error || !result.preview) {
      setAiError(result.error ?? "Couldn't generate a bundle from this request's inspiration.");
      setAiPhase("idle");
      return;
    }

    setAiPreview(result.preview);
    setAiPhase("previewing");
  }

  async function handleConfirmAIBundle() {
    if (!aiPreview) return;
    setAiPhase("confirming");
    setAiError(null);

    const result = await confirmAIBundle(detail.id, aiPreview);

    setAiPhase("previewing");

    if (result.error) {
      setAiError(result.error);
      return;
    }

    router.push("/admin/style-requests");
  }

  const priceMode = priceModeForBudget(detail.budget);
  const selectedCategories = detail.categories as SelectedCategory[];

  // Mirrors ImportListingView.tsx's discover -> chunk -> process-batch
  // orchestration exactly, pre-filled from this request's budget/
  // categories — scraped candidates land as 'pending' in the same,
  // existing /admin/listings queue, never auto-approved.
  async function handleRunScraper() {
    setScraperPhase("discovering");
    setScraperImported(0);
    setScraperError(null);

    let urls: string[];
    try {
      const response = await fetch("/api/bulk-import/discover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetCount: SCRAPE_TARGET, priceMode, selectedCategories, selectedBrands: [] }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Failed to find listings.");
      urls = Array.isArray(data.urls) ? data.urls : [];
    } catch (err) {
      setScraperError(err instanceof Error ? err.message : "Failed to find listings.");
      setScraperPhase("idle");
      return;
    }

    if (urls.length === 0) {
      setScraperError("Couldn't find any new listings right now — try again later.");
      setScraperPhase("idle");
      return;
    }

    setScraperPhase("importing");

    let imported = 0;
    let categoryCounts: CategoryCounts = {};

    for (const batch of chunk(urls, BULK_CHUNK_SIZE)) {
      try {
        const response = await fetch("/api/bulk-import/process-batch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            urls: batch,
            categoryCounts,
            totalInsertedSoFar: imported,
            priceMode,
            selectedCategories,
            selectedBrands: [],
          }),
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error ?? "This batch failed.");
        imported += data.successCount ?? 0;
        if (data.categoryCounts) categoryCounts = data.categoryCounts;
      } catch (err) {
        console.error("[style-request-scraper]", err);
      }
      setScraperImported(imported);
    }

    setScraperPhase("done");
  }

  async function handleSearch() {
    setSearching(true);
    const result = await searchActiveListings(searchQuery);
    setSearching(false);

    if (result.error) {
      setSearchResults([]);
      return;
    }
    setSearchResults(result.listings);
  }

  function toggleSelected(listing: Listing) {
    setSelected((prev) =>
      prev.some((entry) => entry.id === listing.id)
        ? prev.filter((entry) => entry.id !== listing.id)
        : [...prev, listing],
    );
  }

  async function handleCreateBundle() {
    setSaving(true);
    setSaveError(null);

    const result = await createBundleForRequest(detail.id, {
      title,
      description,
      listingIds: selected.map((listing) => listing.id),
    });

    setSaving(false);

    if (result.error) {
      setSaveError(result.error);
      return;
    }

    router.push("/admin/style-requests");
  }

  return (
    <div className="mx-auto max-w-3xl px-6 py-12">
      <h1 className="font-display text-2xl font-semibold text-ink">Style request</h1>

      <Card className="mt-6 p-6">
        <p className="text-sm text-ink">{detail.inspoText || "No inspiration text provided."}</p>
        <p className="mt-2 text-xs text-ink-soft">
          {detail.budget != null ? `$${detail.budget.toFixed(2)} budget` : "No budget set"}
          {detail.categories.length > 0 ? ` · ${detail.categories.join(", ")}` : ""}
        </p>

        {detail.inspoImageUrls.length > 0 && (
          <div className="mt-4 flex gap-2 overflow-x-auto">
            {detail.inspoImageUrls.map((url) => (
              // eslint-disable-next-line @next/next/no-img-element -- signed Supabase Storage URL, not known in advance
              <img key={url} src={url} alt="Style inspiration" className="h-28 w-28 shrink-0 rounded-2xl object-cover" />
            ))}
          </div>
        )}
      </Card>

      <Card className="mt-6 p-6">
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-oxblood" strokeWidth={2} />
          <p className="font-display text-base font-semibold text-ink">Generate with AI</p>
        </div>
        <p className="mt-1.5 text-sm text-ink-soft">
          Analyzes the inspiration photo(s) directly (the primary signal — text/budget/categories
          are secondary context only), searches Lockette&apos;s inventory per detected item, and
          ranks matches by visual similarity, garment match, style, color, and budget. Nothing is
          saved until you confirm below.
        </p>

        {aiPhase === "idle" && (
          <Button type="button" onClick={handleGenerateAIBundle} className="mt-3 w-fit">
            Generate Bundle
          </Button>
        )}

        {aiPhase === "generating" && (
          <div className="mt-3 flex items-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin text-oxblood" />
            <p className="text-sm text-ink-soft">Analyzing inspiration and searching inventory…</p>
          </div>
        )}

        {aiError && <p className="mt-3 text-sm text-oxblood">{aiError}</p>}

        {aiPreview && (aiPhase === "previewing" || aiPhase === "confirming") && (
          <div className="mt-4 rounded-2xl border border-border bg-inner/40 p-4">
            <p className="text-sm text-ink-soft">{aiPreview.bundle.analysis.outfitDescription}</p>
            {aiPreview.bundle.analysis.aesthetic.length > 0 && (
              <p className="mt-1 text-xs text-ink-soft">{aiPreview.bundle.analysis.aesthetic.join(" · ")}</p>
            )}

            <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
              {aiPreview.bundle.items.map((item) => (
                <div key={item.listing.id} className="overflow-hidden rounded-2xl border border-border">
                  <div className="relative aspect-square bg-inner">
                    {item.listing.image_url && (
                      // eslint-disable-next-line @next/next/no-img-element -- arbitrary external marketplace domain, not known in advance
                      <img
                        src={item.listing.image_url}
                        alt={item.listing.title}
                        className="absolute inset-0 h-full w-full object-cover"
                      />
                    )}
                  </div>
                  <div className="p-2">
                    <p className="truncate text-xs font-medium text-ink">{item.listing.title}</p>
                    <p className="text-xs text-oxblood">${(item.listing.price ?? 0).toFixed(2)}</p>
                  </div>
                </div>
              ))}
            </div>

            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-sm">
              <span className="text-ink-soft">
                Subtotal ${aiPreview.bundle.pricing.itemSubtotal.toFixed(2)} + Lockette fee $
                {aiPreview.bundle.pricing.mavelleFee.toFixed(2)} ={" "}
                <span className="font-semibold text-ink">${aiPreview.bundle.pricing.totalPrice.toFixed(2)}</span>
              </span>
              <span className="text-ink-soft">{aiPreview.bundle.delivery.rangeLabel}</span>
            </div>

            <Button
              type="button"
              onClick={handleConfirmAIBundle}
              disabled={aiPhase === "confirming"}
              className="mt-4 w-fit"
            >
              {aiPhase === "confirming" ? "Saving…" : "Confirm & Save Bundle"}
            </Button>
          </div>
        )}
      </Card>

      <Card className="mt-6 flex flex-col items-center gap-3 p-6 text-center">
        <p className="font-display text-base font-semibold text-ink">Run Scraper</p>
        <p className="text-sm text-ink-soft">
          Finds fresh candidates matching this request&apos;s budget/categories. Everything lands
          as pending in <span className="font-medium text-ink">/admin/listings</span> for review
          first, never live directly.
        </p>

        {scraperPhase === "idle" && (
          <Button type="button" onClick={handleRunScraper} className="w-fit">
            Run Scraper
          </Button>
        )}

        {(scraperPhase === "discovering" || scraperPhase === "importing") && (
          <div className="flex flex-col items-center gap-2">
            <Loader2 className="h-8 w-8 animate-spin text-oxblood" strokeWidth={1.5} />
            <p className="text-sm font-medium text-ink">
              {scraperPhase === "discovering" ? "Finding listings..." : `Imported ${scraperImported}`}
            </p>
          </div>
        )}

        {scraperPhase === "done" && (
          <p className="text-sm text-ink">
            Found {scraperImported} new candidates — approve them in{" "}
            <a href="/admin/listings" className="font-medium text-oxblood underline underline-offset-4">
              /admin/listings
            </a>
            , then search for them below.
          </p>
        )}

        {scraperError && <p className="text-sm text-oxblood">{scraperError}</p>}
      </Card>

      <Card className="mt-6 p-6">
        <p className="font-display text-base font-semibold text-ink">Pick listings</p>
        <div className="mt-3 flex gap-2">
          <input
            type="text"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            onKeyDown={(event) => event.key === "Enter" && handleSearch()}
            placeholder="Search active listings by title or description"
            className="w-full rounded-2xl border border-border bg-surface px-4 py-2.5 text-sm text-ink focus:border-oxblood focus:outline-none"
          />
          <Button type="button" variant="secondary" onClick={handleSearch} disabled={searching}>
            <Search className="h-4 w-4" strokeWidth={2} />
            {searching ? "…" : "Search"}
          </Button>
        </div>

        {searchResults.length > 0 && (
          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
            {searchResults.map((listing) => {
              const isSelected = selected.some((entry) => entry.id === listing.id);
              return (
                <button
                  key={listing.id}
                  type="button"
                  onClick={() => toggleSelected(listing)}
                  className={`flex flex-col overflow-hidden rounded-2xl border p-0 text-left transition-colors ${
                    isSelected ? "border-oxblood ring-2 ring-oxblood" : "border-border"
                  }`}
                >
                  <div className="relative aspect-square w-full bg-inner">
                    {listing.image_url && (
                      // eslint-disable-next-line @next/next/no-img-element -- arbitrary external marketplace domain, not known in advance
                      <img
                        src={listing.image_url}
                        alt={listing.title}
                        className="absolute inset-0 h-full w-full object-cover"
                      />
                    )}
                  </div>
                  <div className="p-2">
                    <p className="truncate text-xs font-medium text-ink">{listing.title}</p>
                    {listing.price != null && (
                      <p className="text-xs text-oxblood">${listing.price.toFixed(2)}</p>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </Card>

      <Card className="mt-6 p-6">
        <p className="font-display text-base font-semibold text-ink">Selected ({selected.length})</p>

        {selected.length > 0 && (
          <div className="mt-3 flex flex-col gap-2">
            {selected.map((listing) => (
              <div key={listing.id} className="flex items-center justify-between gap-2 rounded-2xl bg-inner/50 px-3 py-2">
                <span className="min-w-0 truncate text-sm text-ink">{listing.title}</span>
                <button
                  type="button"
                  onClick={() => toggleSelected(listing)}
                  aria-label="Remove"
                  className="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-full text-ink-soft hover:bg-white hover:text-ink"
                >
                  <X className="h-3.5 w-3.5" strokeWidth={2.5} />
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="mt-5 flex flex-col gap-4">
          <div>
            <label htmlFor="bundle-title" className="mb-1.5 block text-sm font-medium text-ink">
              Bundle title
            </label>
            <input
              id="bundle-title"
              type="text"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="e.g. Your Y2K low-rise edit"
              className="w-full rounded-2xl border border-border bg-surface px-4 py-3 text-sm text-ink focus:border-oxblood focus:outline-none"
            />
          </div>
          <div>
            <label htmlFor="bundle-description" className="mb-1.5 block text-sm font-medium text-ink">
              Description
            </label>
            <textarea
              id="bundle-description"
              rows={3}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              className="w-full rounded-2xl border border-border bg-surface px-4 py-3 text-sm text-ink focus:border-oxblood focus:outline-none"
            />
          </div>

          {saveError && <p className="text-sm text-oxblood">{saveError}</p>}

          <Button type="button" onClick={handleCreateBundle} disabled={saving} className="w-fit">
            {saving ? "Saving…" : "Create Bundle"}
          </Button>
        </div>
      </Card>
    </div>
  );
}
