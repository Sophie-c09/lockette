import Link from "next/link";
import { Badge, type TagVariant } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import type { StyleRequestQueueItem } from "@/lib/styleRequestAdmin";

const STATUS_VARIANTS: Record<StyleRequestQueueItem["status"], TagVariant> = {
  pending: "yellow",
  in_progress: "teal",
  completed: "pink",
};

// A simple list, not a swipe-deck like /admin/listings — curating a style
// request (review inspo, run the scraper, hand-pick listings) is a slower
// per-request workflow, not a fast one-tap approve/reject.
export function StyleRequestsQueueView({
  items,
  initialError,
}: {
  items: StyleRequestQueueItem[];
  initialError?: string;
}) {
  return (
    <div className="mx-auto max-w-2xl px-6 py-12">
      <h1 className="font-display text-2xl font-semibold text-ink">Style requests</h1>

      {initialError ? (
        <div className="mt-8 rounded-card border border-oxblood bg-highlight-cream p-8 text-center text-sm text-ink">
          <p className="font-medium">Couldn&apos;t load style requests</p>
          <p className="mt-1 text-ink-soft">{initialError}</p>
        </div>
      ) : items.length === 0 ? (
        <p className="mt-8 rounded-card border border-border bg-inner/50 p-12 text-center text-sm text-ink-soft">
          You&apos;re all caught up.
        </p>
      ) : (
        <div className="mt-8 flex flex-col gap-3">
          {items.map((item) => (
            <Link key={item.id} href={`/admin/style-requests/${item.id}`}>
              <Card className="flex items-center justify-between gap-3 p-5">
                <div className="min-w-0">
                  <p className="truncate text-sm text-ink">
                    {item.inspo_text || "No inspiration text provided"}
                  </p>
                  <p className="mt-1 text-xs text-ink-soft">
                    {item.budget != null ? `$${item.budget.toFixed(2)} budget` : "No budget set"}
                    {item.categories.length > 0 ? ` · ${item.categories.join(", ")}` : ""}
                  </p>
                </div>
                <Badge variant={STATUS_VARIANTS[item.status]} className="shrink-0">
                  {item.status === "in_progress" ? "In progress" : item.status}
                </Badge>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
