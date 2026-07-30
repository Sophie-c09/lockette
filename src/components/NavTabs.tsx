"use client";

import { useLayoutEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { LinkButton } from "@/components/ui/Button";
import { CartNavLink } from "@/components/CartNavLink";
import { isActivePath } from "@/lib/nav";

const TAB_CLASS =
  "rounded-pill px-3 py-1.5 text-sm font-medium transition-colors duration-200 ease-in-out hover:text-ink";

interface UnderlineRect {
  left: number;
  width: number;
  visible: boolean;
}

// Sliding active-tab underline (Instagram/TikTok-style) for the top nav.
// Text stays neutral regardless of active state — only the underline (and
// a slight font-weight bump) indicates which tab is active. Positioned via
// direct DOM measurement (refs), not routing state, so it works the same
// regardless of how many tabs are present (signed in vs signed out).
export function NavTabs({ isSignedIn }: { isSignedIn: boolean }) {
  const pathname = usePathname();
  const containerRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef(new Map<string, HTMLAnchorElement>());
  const [underline, setUnderline] = useState<UnderlineRect>({
    left: 0,
    width: 0,
    visible: false,
  });

  const tabs = useMemo(() => {
    const list = [
      { href: "/match", label: "Match" },
      { href: "/discover", label: "Discover" },
    ];
    if (isSignedIn) list.push({ href: "/likes", label: "Likes" });
    list.push({ href: "/cart", label: "Cart" });
    list.push(isSignedIn ? { href: "/profile", label: "Profile" } : { href: "/login", label: "Sign in" });
    return list;
  }, [isSignedIn]);

  function registerTabRef(href: string) {
    return (el: HTMLAnchorElement | null) => {
      if (el) tabRefs.current.set(href, el);
      else tabRefs.current.delete(href);
    };
  }

  // useLayoutEffect (not useEffect): measuring and repositioning before the
  // browser paints avoids a visible flash at the wrong spot when the active
  // tab changes.
  useLayoutEffect(() => {
    function updateUnderline() {
      const container = containerRef.current;
      const activeTab = tabs.find((tab) => isActivePath(pathname, tab.href));
      const activeEl = activeTab ? tabRefs.current.get(activeTab.href) : undefined;

      if (!container || !activeEl) {
        setUnderline((prev) => (prev.visible ? { ...prev, visible: false } : prev));
        return;
      }

      const containerRect = container.getBoundingClientRect();
      const activeRect = activeEl.getBoundingClientRect();
      setUnderline({
        left: activeRect.left - containerRect.left,
        width: activeRect.width,
        visible: true,
      });
    }

    updateUnderline();
    // The same tabs can sit at different pixel positions across
    // breakpoints (e.g. gap-1 vs sm:gap-2), so keep the underline in sync
    // on resize too, not just on route change.
    window.addEventListener("resize", updateUnderline);
    return () => window.removeEventListener("resize", updateUnderline);
  }, [pathname, tabs]);

  return (
    <nav ref={containerRef} className="relative flex items-center gap-1 sm:gap-2">
      {tabs.map((tab) => {
        const isActive = isActivePath(pathname, tab.href);

        if (tab.href === "/cart") {
          return <CartNavLink key={tab.href} tabRef={registerTabRef(tab.href)} />;
        }

        return (
          <Link
            key={tab.href}
            href={tab.href}
            ref={registerTabRef(tab.href)}
            className={`${TAB_CLASS} ${isActive ? "font-semibold text-ink" : "text-teal"}`}
          >
            {tab.label}
          </Link>
        );
      })}

      {!isSignedIn && (
        <LinkButton href="/signup" className="ml-2">
          Get started
        </LinkButton>
      )}

      <span
        aria-hidden="true"
        // Soft pink underline, matching the feed highlight's color family
        // (tag-pink-ink) at reduced opacity — the token's full-strength
        // value is the bold "text pink" badge color, too harsh for a thin
        // line, so this dials it down to a muted, legible rose instead.
        className="pointer-events-none absolute bottom-0 h-0.5 rounded-full bg-tag-pink-ink/50 transition-all duration-300 ease-in-out"
        style={{
          transform: `translateX(${underline.left}px)`,
          width: `${underline.width}px`,
          opacity: underline.visible ? 1 : 0,
        }}
      />
    </nav>
  );
}
