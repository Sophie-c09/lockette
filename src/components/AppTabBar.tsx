"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Compass, Heart, Search, Sparkles, User } from "lucide-react";

// /feed and /discover were merged into a single unified browsing page
// (see src/lib/discover-feed.ts's own comment) — this tab now points at
// /discover instead of the old, now-redirect-only /feed route.
const TABS = [
  { href: "/search", label: "Search", icon: Search },
  { href: "/match", label: "Match", icon: Compass },
  { href: "/discover", label: "Discover", icon: Sparkles },
  { href: "/likes", label: "Likes", icon: Heart },
  { href: "/profile", label: "Profile", icon: User },
];

export function AppTabBar() {
  const pathname = usePathname();

  return (
    <nav className="fixed inset-x-0 bottom-0 z-40 border-t border-border-soft bg-nav">
      <div className="mx-auto flex max-w-md items-center justify-around px-6 py-2.5">
        {TABS.map(({ href, label, icon: Icon }) => {
          const isActive = pathname === href || pathname.startsWith(`${href}/`);
          return (
            <Link
              key={href}
              href={href}
              className={`flex flex-col items-center gap-1 rounded-2xl px-5 py-1.5 text-xs font-medium transition-all duration-200 ease-in-out ${
                isActive ? "bg-tag-pink text-oxblood" : "text-teal hover:text-ink"
              }`}
            >
              <Icon
                className="h-5 w-5"
                strokeWidth={isActive ? 2.25 : 1.75}
              />
              {label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
