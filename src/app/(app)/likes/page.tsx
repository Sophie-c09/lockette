import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Heart, ImageOff, X } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { LinkButton } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Badge, tagVariantForIndex } from "@/components/ui/Badge";
import { PlatformBadge } from "@/components/ui/PlatformBadge";
import { unsaveListingAction } from "@/app/actions/saved-items";
import { RetryButton } from "@/components/ui/RetryButton";

export const metadata: Metadata = {
  title: "Your likes — Lockette",
};

type LikedListing = {
  id: string;
  title: string;
  price: number | null;
  image_url: string | null;
  images: string[] | null;
  brand: string | null;
  size: string | null;
  aesthetic_tags: string[];
  platform: string | null;
  // Optional — may not exist on the live DB yet (see supabase/schema.sql).
  // Unlike Discover/Feed/Match, a sold/unavailable listing stays visible
  // here (with a "Sold" badge) rather than being filtered out — the point
  // of Likes is "everything you've saved," including things you were too
  // late for.
  status?: "active" | "sold" | "unavailable" | "pending" | "flagged" | "rejected";
};

export default async function LikesPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  // Step 1: saved_items only — no join, since relying on an automatic
  // FK-based join here has been a source of past failures; a plain
  // listing_id list is fetched first and the actual listings are fetched
  // separately below.
  const { data: savedRows, error: savedError } = await supabase
    .from("saved_items")
    .select("listing_id, created_at")
    .eq("user_id", user.id)
    .not("listing_id", "is", null)
    .order("created_at", { ascending: false });

  if (savedError) {
    return (
      <LikesShell>
        <ErrorState />
      </LikesShell>
    );
  }

  const orderedListingIds = (savedRows ?? [])
    .map((row) => row.listing_id)
    .filter((id): id is string => Boolean(id));

  if (orderedListingIds.length === 0) {
    return (
      <LikesShell>
        <EmptyState />
      </LikesShell>
    );
  }

  // Step 2: fetch the real listings by id. status may not exist on the
  // live DB yet (see supabase/schema.sql) — selecting a missing column
  // fails the whole query, so this falls back to the pre-status column set
  // rather than showing an error page over it.
  const withStatus = await supabase
    .from("listings")
    .select("id, title, price, image_url, images, brand, size, aesthetic_tags, platform, status")
    .in("id", orderedListingIds);

  let listingsData = withStatus.data;
  let listingsError = withStatus.error;

  if (listingsError) {
    console.error("[likes] status-aware query failed, falling back:", listingsError);
    const fallback = await supabase
      .from("listings")
      .select("id, title, price, image_url, images, brand, size, aesthetic_tags, platform")
      .in("id", orderedListingIds);
    listingsData = fallback.data?.map((row) => ({ ...row, status: undefined })) ?? null;
    listingsError = fallback.error;
  }

  if (listingsError) {
    return (
      <LikesShell>
        <ErrorState />
      </LikesShell>
    );
  }

  const listingById = new Map((listingsData ?? []).map((listing) => [listing.id, listing as LikedListing]));
  // Re-apply saved_items' created_at order — `.in()` doesn't preserve it —
  // and drop any id whose listing no longer exists (e.g. deleted since liking).
  const likedListings = orderedListingIds
    .map((id) => listingById.get(id))
    .filter((listing): listing is LikedListing => Boolean(listing));

  const hasUnavailableLikes = likedListings.some(
    (listing) => listing.status && listing.status !== "active",
  );

  return (
    <LikesShell>
      {hasUnavailableLikes && (
        <p className="mb-6 -mt-2 text-center text-sm text-ink-soft">
          Some saved items are no longer available
        </p>
      )}

      {likedListings.length > 0 ? (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {likedListings.map((listing) => {
            const isSold = Boolean(listing.status) && listing.status !== "active";

            return (
            <Card
              key={listing.id}
              className={`flex flex-col overflow-hidden p-0 ${isSold ? "opacity-50 grayscale" : ""}`}
            >
              <div className="relative aspect-[3/4] shrink-0 bg-inner">
                {listing.image_url ? (
                  // eslint-disable-next-line @next/next/no-img-element -- arbitrary external marketplace domain, not known in advance
                  <img
                    src={listing.image_url}
                    alt={listing.title}
                    className="absolute inset-0 h-full w-full object-cover"
                  />
                ) : (
                  <div className="flex h-full w-full items-center justify-center">
                    <ImageOff className="h-8 w-8 text-muted" strokeWidth={1.5} />
                  </div>
                )}

                <form action={unsaveListingAction.bind(null, listing.id)} className="absolute right-2 top-2">
                  <button
                    type="submit"
                    aria-label={`Remove ${listing.title} from likes`}
                    className="flex h-10 w-10 cursor-pointer items-center justify-center rounded-full bg-darkgreen/45 text-white transition-colors hover:bg-oxblood"
                  >
                    <X className="h-3.5 w-3.5" strokeWidth={2.5} />
                  </button>
                </form>

                {listing.platform && (
                  <PlatformBadge platform={listing.platform} className="absolute bottom-2 right-2" />
                )}
              </div>

              <div className="flex flex-1 flex-col gap-2 p-4">
                <div className="flex items-start justify-between gap-2">
                  <h3 className="min-w-0 line-clamp-2 font-display text-sm font-semibold leading-tight text-ink">
                    {listing.title}
                  </h3>
                  {isSold && (
                    <Badge variant="pink" className="shrink-0 text-[11px]">
                      Sold
                    </Badge>
                  )}
                  {listing.price != null && (
                    <span className="shrink-0 font-display text-sm font-semibold text-oxblood">
                      ${listing.price.toFixed(2)}
                    </span>
                  )}
                </div>

                {(listing.brand || listing.size) && (
                  <p className="text-xs text-ink-soft">
                    {[listing.brand, listing.size].filter(Boolean).join(" · ")}
                  </p>
                )}

                {listing.aesthetic_tags.length > 0 && (
                  <div className="mt-auto flex flex-wrap gap-1.5 pt-2">
                    {listing.aesthetic_tags.map((tag, index) => (
                      <Badge key={tag} variant={tagVariantForIndex(index)} className="text-[11px]">
                        {tag}
                      </Badge>
                    ))}
                  </div>
                )}
              </div>
            </Card>
            );
          })}
        </div>
      ) : (
        <EmptyState />
      )}
    </LikesShell>
  );
}

function LikesShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-[calc(100vh-137px)] scroll-smooth px-6 pt-12">
      <div className="mx-auto max-w-5xl">
        <div className="mb-8 text-center">
          <span className="font-display text-sm tracking-[0.2em] text-oxblood uppercase">
            Likes
          </span>
          <h1 className="mt-2 font-display text-3xl font-semibold text-ink sm:text-4xl">
            Everything you&apos;ve saved
          </h1>
        </div>

        {children}
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-4 rounded-card bg-highlight-cream px-8 py-16 text-center">
      <Heart className="h-8 w-8 text-oxblood" strokeWidth={1.5} />
      <p className="text-sm text-ink-soft">Like items on Discover to see them here</p>
      <LinkButton href="/discover">Go to Discover</LinkButton>
    </div>
  );
}

function ErrorState() {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-4 rounded-card bg-highlight-cream px-8 py-16 text-center">
      <Heart className="h-8 w-8 text-oxblood" strokeWidth={1.5} />
      <p className="text-sm text-ink-soft">Something went wrong loading your likes.</p>
      <RetryButton />
    </div>
  );
}
