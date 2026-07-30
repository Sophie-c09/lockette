import Link from "next/link";
import { ImageOff, Sparkles } from "lucide-react";
import { Card } from "@/components/ui/Card";
import type { MyOutfitRecreation } from "@/app/actions/outfit-recreations";

export function MyOutfitsView({ recreations }: { recreations: MyOutfitRecreation[] }) {
  if (recreations.length === 0) {
    return (
      <div className="mx-auto flex max-w-md flex-col items-center gap-4 px-6 py-16 text-center">
        <Sparkles className="h-8 w-8 text-oxblood" strokeWidth={1.5} />
        <p className="text-sm text-ink-soft">You haven&apos;t recreated an outfit yet.</p>
        <Link
          href="/recreate-outfit"
          className="text-sm font-semibold text-oxblood underline underline-offset-4"
        >
          Recreate This Outfit
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl px-6 py-12">
      <h1 className="font-display text-2xl font-semibold text-ink">My outfit recreations</h1>

      <div className="mt-8 grid grid-cols-2 gap-4 sm:grid-cols-3">
        {recreations.map((recreation) => (
          <Link key={recreation.id} href={`/recreate-outfit/${recreation.id}`}>
            <Card className="flex flex-col overflow-hidden p-0">
              <div className="relative aspect-square w-full bg-inner">
                {recreation.photoUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element -- signed Supabase Storage URL, not known in advance
                  <img
                    src={recreation.photoUrl}
                    alt="Uploaded outfit"
                    className="absolute inset-0 h-full w-full object-cover"
                  />
                ) : (
                  <div className="flex h-full w-full items-center justify-center">
                    <ImageOff className="h-6 w-6 text-muted" strokeWidth={1.5} />
                  </div>
                )}
              </div>
              <div className="p-3">
                <p className="text-xs text-ink-soft">
                  {recreation.categories.map((category) => category).join(" · ") || "No categories detected"}
                </p>
                <p className="mt-1 text-[11px] text-ink-soft/70">
                  {new Date(recreation.createdAt).toLocaleDateString(undefined, {
                    month: "short",
                    day: "numeric",
                    year: "numeric",
                  })}
                </p>
              </div>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
