import Link from "next/link";
import { ImageOff, Sparkles } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { Badge, type TagVariant } from "@/components/ui/Badge";
import type { MyStyleMeRequest } from "@/app/actions/style-me";

const STATUS_LABELS: Record<MyStyleMeRequest["status"], string> = {
  pending: "Pending",
  in_progress: "Being styled",
  shipped: "Shipped",
  delivered: "Delivered",
};

const STATUS_VARIANTS: Record<MyStyleMeRequest["status"], TagVariant> = {
  pending: "yellow",
  in_progress: "teal",
  shipped: "teal",
  delivered: "pink",
};

export function MyStyleMeView({ requests }: { requests: MyStyleMeRequest[] }) {
  if (requests.length === 0) {
    return (
      <div className="mx-auto flex max-w-md flex-col items-center gap-4 px-6 py-16 text-center">
        <Sparkles className="h-8 w-8 text-oxblood" strokeWidth={1.5} />
        <p className="text-sm text-ink-soft">You haven&apos;t tried Style Me yet.</p>
        <Link href="/style-me" className="text-sm font-semibold text-oxblood underline underline-offset-4">
          Style Me
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl px-6 py-12">
      <h1 className="font-display text-2xl font-semibold text-ink">My Style Me bundles</h1>

      <div className="mt-8 grid grid-cols-2 gap-4 sm:grid-cols-3">
        {requests.map((request) => (
          <Link key={request.id} href={`/style-me/${request.id}`}>
            <Card className="flex flex-col overflow-hidden p-0">
              <div className="relative aspect-square w-full bg-inner">
                {request.imageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element -- signed Supabase Storage URL, not known in advance
                  <img
                    src={request.imageUrl}
                    alt="Style inspiration"
                    className="absolute inset-0 h-full w-full object-cover"
                  />
                ) : (
                  <div className="flex h-full w-full items-center justify-center">
                    <ImageOff className="h-6 w-6 text-muted" strokeWidth={1.5} />
                  </div>
                )}
              </div>
              <div className="flex items-center justify-between gap-2 p-3">
                <Badge variant={STATUS_VARIANTS[request.status]} className="text-[11px]">
                  {STATUS_LABELS[request.status]}
                </Badge>
                <span className="text-[11px] text-ink-soft/70">
                  {new Date(request.createdAt).toLocaleDateString(undefined, {
                    month: "short",
                    day: "numeric",
                  })}
                </span>
              </div>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
