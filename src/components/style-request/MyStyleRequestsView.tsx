"use client";

import { useState } from "react";
import Link from "next/link";
import { Sparkles } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { Badge, type TagVariant } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { addBundleToCart, type MyStyleRequest } from "@/app/actions/style-requests";
import { BundleOutfitView } from "@/components/style-request/BundleOutfitView";
import { useToast } from "@/components/ToastProvider";
import { RetryButton } from "@/components/ui/RetryButton";

const STATUS_LABELS: Record<MyStyleRequest["status"], string> = {
  pending: "Pending review",
  in_progress: "Being styled",
  completed: "Ready",
};

const STATUS_VARIANTS: Record<MyStyleRequest["status"], TagVariant> = {
  pending: "yellow",
  in_progress: "teal",
  completed: "pink",
};

function BundleCard({ bundle, onChanged }: { bundle: NonNullable<MyStyleRequest["bundle"]>; onChanged: () => void }) {
  const { showToast } = useToast();
  const [adding, setAdding] = useState(false);

  // AI-generated bundles (this feature) are either mid-generation, failed,
  // or fully priced; the original manual admin-curation flow is always
  // status: 'ready' with itemSubtotal: null — this is the exact signal
  // that distinguishes the two, without a schema migration on old rows.
  // AI-generated ones (in ANY lifecycle state) get the full outfit-collage
  // experience (BundleOutfitView, shared with /bundle/[id], which itself
  // handles the generating/error/ready states); old ones keep their
  // original, simpler grid.
  const isAiGenerated =
    bundle.status === "generating" || bundle.status === "error" || bundle.itemSubtotal != null;

  async function handleAddAllToCart() {
    setAdding(true);
    const result = await addBundleToCart(bundle.id);
    setAdding(false);

    if (result.error) {
      showToast(result.error);
      return;
    }
    showToast(`Added ${result.added} item${result.added === 1 ? "" : "s"} to your cart`);
  }

  if (isAiGenerated) {
    return <BundleOutfitView bundle={bundle} onChanged={onChanged} />;
  }

  return (
    <div className="mt-4">
      <h3 className="font-display text-base font-semibold text-ink">{bundle.title}</h3>
      {bundle.description && <p className="mt-1 text-sm text-ink-soft">{bundle.description}</p>}

      {bundle.items.length > 0 && (
        <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3">
          {bundle.items.map(({ listing }) => (
            <div key={listing.id} className="overflow-hidden rounded-card border border-border bg-surface">
              {listing.image_url && (
                // eslint-disable-next-line @next/next/no-img-element -- arbitrary external marketplace domain, not known in advance
                <img src={listing.image_url} alt={listing.title} className="aspect-[3/4] w-full object-cover" />
              )}
              <div className="p-3">
                <p className="truncate text-sm font-medium text-ink">{listing.title}</p>
                {listing.price != null && <p className="text-sm text-oxblood">${Number(listing.price).toFixed(2)}</p>}
              </div>
            </div>
          ))}
        </div>
      )}

      <Button type="button" onClick={handleAddAllToCart} disabled={adding} className="mt-4 w-fit">
        {adding ? "Adding…" : "Add All to Cart"}
      </Button>
    </div>
  );
}

export function MyStyleRequestsView({
  requests,
  hasError = false,
}: {
  requests: MyStyleRequest[];
  hasError?: boolean;
}) {
  const [, forceRefresh] = useState(0);

  // Pre-launch polish fix (item 4) — a failed fetch (requests: [], error
  // set) used to render identically to a genuinely empty list, telling a
  // user whose request fetch just failed "you haven't sent a style
  // request yet," which is actively misleading. hasError distinguishes
  // the two so a real failure gets a real retry instead.
  if (requests.length === 0) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-12">
        <h1 className="font-display text-2xl font-semibold text-ink">My style requests</h1>
        <div className="mx-auto mt-8 flex max-w-md flex-col items-center gap-4 rounded-card bg-highlight-cream px-8 py-16 text-center">
          <Sparkles className="h-8 w-8 text-oxblood" strokeWidth={1.5} />
          {hasError ? (
            <>
              <p className="text-sm text-ink-soft">Something went wrong loading your style requests.</p>
              <RetryButton />
            </>
          ) : (
            <>
              <p className="text-sm text-ink-soft">You haven&apos;t sent a style request yet.</p>
              <Link href="/style-request" className="text-sm font-semibold text-oxblood underline underline-offset-4">
                Get Styled
              </Link>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl px-6 py-12">
      <h1 className="font-display text-2xl font-semibold text-ink">My style requests</h1>

      <div className="mt-8 flex flex-col gap-6">
        {requests.map((request) => (
          <Card key={request.id} className="p-6">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-ink-soft">
                {new Date(request.createdAt).toLocaleDateString(undefined, {
                  month: "short",
                  day: "numeric",
                  year: "numeric",
                })}
              </span>
              <Badge variant={STATUS_VARIANTS[request.status]}>{STATUS_LABELS[request.status]}</Badge>
            </div>

            {request.inspoText && <p className="mt-3 text-sm text-ink-soft">{request.inspoText}</p>}

            {request.inspoImageUrls.length > 0 && (
              <div className="mt-3 flex gap-2 overflow-x-auto">
                {request.inspoImageUrls.map((url) => (
                  // eslint-disable-next-line @next/next/no-img-element -- signed Supabase Storage URL, not known in advance
                  <img
                    key={url}
                    src={url}
                    alt="Style inspiration"
                    className="h-20 w-20 shrink-0 rounded-2xl object-cover"
                  />
                ))}
              </div>
            )}

            {request.status === "completed" && request.bundle && (
              // A swap doesn't change this page's own server-fetched props
              // in place — forcing a re-render here is a light nudge; the
              // next real navigation/refresh picks up the server's fresh
              // read regardless (revalidatePath("/my-style-requests"),
              // see replaceBundleItem in app/actions/style-requests.ts).
              <BundleCard bundle={request.bundle} onChanged={() => forceRefresh((n) => n + 1)} />
            )}
          </Card>
        ))}
      </div>
    </div>
  );
}
