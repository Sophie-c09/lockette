"use client";

// Pre-submission fix — this page used to search a hardcoded, fake catalog
// (src/lib/mock-clothing.ts, now deleted) with randomly-generated
// placeholder photos from a third-party image service, entirely
// disconnected from the real `listings` table Discover/Match use. It's
// reachable straight from the bottom tab bar in production, so it was
// showing every real user a fake product catalog. Rather than build a new
// search backend, this now just hands off to /discover's own real,
// already-working search (?query=) — the same real inventory, scoring, and
// filtering every other part of the app already relies on.
import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Search } from "lucide-react";

export function SearchView() {
  const router = useRouter();
  const [query, setQuery] = useState("");

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = query.trim();
    router.push(trimmed ? `/discover?query=${encodeURIComponent(trimmed)}` : "/discover");
  }

  return (
    <div className="min-h-[calc(100vh-137px)] px-6 pt-12">
      <div className="mx-auto max-w-5xl">
        <div className="mb-8 text-center">
          <span className="font-display text-sm tracking-[0.2em] text-oxblood uppercase">
            Search
          </span>
          <h1 className="mt-2 font-display text-3xl font-semibold text-ink sm:text-4xl">
            Find something specific
          </h1>
        </div>

        <form onSubmit={handleSubmit} className="relative mx-auto max-w-2xl">
          <Search
            className="pointer-events-none absolute top-1/2 left-4 h-5 w-5 -translate-y-1/2 text-ink-soft"
            strokeWidth={1.75}
          />
          <input
            type="text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search for items..."
            aria-label="Search for items"
            className="w-full rounded-2xl border border-border bg-surface py-3 pr-4 pl-12 text-sm text-ink placeholder:text-ink-soft/60 focus:border-oxblood focus:outline-none"
          />
        </form>

        <p className="mt-10 text-center text-sm text-ink-soft">
          Search title, brand, or style across all of Lockette&apos;s inventory.
        </p>
      </div>
    </div>
  );
}
