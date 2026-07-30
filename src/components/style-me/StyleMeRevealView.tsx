"use client";

import { useEffect, useState } from "react";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { ListingCard } from "@/components/listing/ListingCard";
import { getStyleMeRequest, addStyleMeBundleToCart, type StyleMeRequestDetail } from "@/app/actions/style-me";
import { useToast } from "@/components/ToastProvider";

const STATUS_STEPS = ["pending", "in_progress", "shipped", "delivered"] as const;

const STATUS_LABELS: Record<(typeof STATUS_STEPS)[number], string> = {
  pending: "Pending",
  in_progress: "Being styled",
  shipped: "Shipped",
  delivered: "Delivered",
};

// Polls while waiting so the tracker advances without a manual refresh —
// same pattern as NotificationBell's own poll interval, just slower
// since this is a multi-minute reveal, not a live notification feed.
const POLL_INTERVAL_MS = 15_000;

export function StyleMeRevealView({ initialRequest }: { initialRequest: StyleMeRequestDetail }) {
  const { showToast } = useToast();
  const [request, setRequest] = useState(initialRequest);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    if (request.status === "delivered") return;

    const interval = setInterval(async () => {
      const result = await getStyleMeRequest(request.id);
      if (result.request) setRequest(result.request);
    }, POLL_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [request.status, request.id]);

  async function handleAddAllToCart() {
    if (!request.bundle) return;

    setAdding(true);
    const result = await addStyleMeBundleToCart(request.bundle.id);
    setAdding(false);

    if (result.error) {
      showToast(result.error);
      return;
    }
    showToast(`Added ${result.added} item${result.added === 1 ? "" : "s"} to your cart`);
  }

  const currentStepIndex = STATUS_STEPS.indexOf(request.status);

  return (
    <div className="mx-auto max-w-2xl px-6 py-12">
      <h1 className="font-display text-2xl font-semibold text-ink">Your Style Me bundle</h1>

      {request.imageUrls.length > 0 && (
        <div className="mt-6 flex gap-2 overflow-x-auto">
          {request.imageUrls.map((url) => (
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
      {request.inspoText && <p className="mt-3 text-sm text-ink-soft">{request.inspoText}</p>}
      <p className="mt-1 text-xs text-ink-soft">Budget: ${request.budget.toFixed(2)}</p>

      <Card className="mt-6 p-6">
        <div className="flex items-center justify-between gap-2">
          {STATUS_STEPS.map((step, index) => (
            <div key={step} className="flex flex-1 flex-col items-center gap-1.5">
              <div
                className={`h-2.5 w-2.5 rounded-full ${index <= currentStepIndex ? "bg-oxblood" : "bg-inner"}`}
              />
              <span
                className={`text-[11px] ${index <= currentStepIndex ? "font-medium text-ink" : "text-ink-soft"}`}
              >
                {STATUS_LABELS[step]}
              </span>
            </div>
          ))}
        </div>
      </Card>

      {request.status !== "delivered" ? (
        <p className="mt-6 text-center text-sm text-ink-soft">
          Your surprise bundle is on its way — check back soon.
        </p>
      ) : request.bundle ? (
        <div className="mt-6">
          <h2 className="font-display text-lg font-semibold text-ink">{request.bundle.title}</h2>
          {request.bundle.description && (
            <p className="mt-1 text-sm text-ink-soft">{request.bundle.description}</p>
          )}

          {request.bundle.items.length > 0 ? (
            <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3">
              {request.bundle.items.map((listing) => (
                <ListingCard key={listing.id} listing={listing} />
              ))}
            </div>
          ) : (
            <p className="mt-4 text-sm text-ink-soft">We couldn&apos;t find great matches this time.</p>
          )}

          <Button type="button" onClick={handleAddAllToCart} disabled={adding} className="mt-4 w-fit">
            {adding ? "Adding…" : "Add All to Cart"}
          </Button>
        </div>
      ) : (
        <p className="mt-6 text-center text-sm text-ink-soft">
          We couldn&apos;t put together a bundle this time — sorry about that.
        </p>
      )}
    </div>
  );
}
