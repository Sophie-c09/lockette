import type { Metadata } from "next";
import { fetchDiscoverBatch, DISCOVER_BATCH_SIZE, parseDiscoverSortOption } from "@/lib/discover-feed";
import { getHomepageCategoryBySlug, getAestheticCategoryBySlug } from "@/lib/aesthetic-categories";
import { getItemTypeCategoryBySlug } from "@/lib/item-type-categories";
import { DiscoverView } from "@/components/discover/DiscoverView";
import { createClient } from "@/lib/supabase/server";
import { isCurrentUserAdmin } from "@/lib/admin";
import { RetryButton } from "@/components/ui/RetryButton";

export const metadata: Metadata = {
  title: "Discover — Lockette",
};

export default async function DiscoverPage({
  searchParams,
}: {
  searchParams: Promise<{ category?: string; type?: string; query?: string; style?: string; sort?: string }>;
}) {
  const { category: categorySlug, type: typeSlug, query: searchQuery, style: styleSlug, sort: sortParam } = await searchParams;
  const activeSort = parseDiscoverSortOption(sortParam);

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const isAdmin = user ? await isCurrentUserAdmin(supabase, user.id) : false;

  const { listings, savedListingIds, error } = await fetchDiscoverBatch(
    0,
    DISCOVER_BATCH_SIZE,
    categorySlug,
    typeSlug,
    searchQuery,
    styleSlug,
    activeSort,
  );

  if (error) {
    return (
      <div className="flex min-h-[calc(100vh-137px)] items-center justify-center px-6 text-center">
        <div className="mx-auto flex max-w-md flex-col items-center gap-4 rounded-card bg-highlight-cream px-8 py-16 text-center">
          <p className="text-sm text-ink-soft">
            Something went wrong loading the marketplace.
          </p>
          <RetryButton />
        </div>
      </div>
    );
  }

  // Resolved server-side so an unrecognized/typo'd ?category= or ?type=
  // value never shows a "Showing: <garbage>" header — it just silently
  // falls back to the unfiltered feed (see fetchDiscoverBatch's identical
  // fallback). ?query= has no fixed list to resolve against (it's free
  // text from the homepage's product-search cards, or a user-typed URL) —
  // just trimmed for display.
  const activeCategory = categorySlug ? getHomepageCategoryBySlug(categorySlug) : undefined;
  const activeItemType = typeSlug ? getItemTypeCategoryBySlug(typeSlug) : undefined;
  const activeSearchQuery = searchQuery?.trim() || null;
  const activeStyle = styleSlug ? getAestheticCategoryBySlug(styleSlug) : undefined;

  return (
    <DiscoverView
      // Forces a full remount whenever any active filter changes via a
      // same-route navigation (e.g. a pill click or "clear filters" link)
      // — without this, React could reuse the existing DiscoverView
      // instance across the navigation and leak the previous filter's
      // pagination offset/loaded listings into the new one. activeSort is
      // included so a real navigation carrying a new ?sort= (a pasted
      // link, or a category pill click that preserved the sort selected
      // client-side) still seeds a correct initial sortOption — the sort
      // DROPDOWN itself no longer navigates at all (DiscoverView re-sorts
      // client-side; see its own sortOption state comment), so this key
      // changing on sort alone doesn't happen from ordinary dropdown use.
      key={`${activeCategory?.slug ?? "all"}:${activeItemType?.slug ?? "all"}:${activeSearchQuery ?? "all"}:${activeStyle?.slug ?? "all"}:${activeSort}`}
      initialListings={listings}
      initialSavedListingIds={savedListingIds}
      initialOffset={DISCOVER_BATCH_SIZE}
      isAdmin={isAdmin}
      categorySlug={activeCategory?.slug ?? null}
      categoryLabel={activeCategory?.label ?? null}
      typeSlug={activeItemType?.slug ?? null}
      typeLabel={activeItemType?.label ?? null}
      searchQuery={activeSearchQuery}
      styleSlug={activeStyle?.slug ?? null}
      styleLabel={activeStyle?.label ?? null}
      styleDescription={activeStyle?.description ?? null}
      sortOption={activeSort}
    />
  );
}
