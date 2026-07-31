import Link from "next/link";
import { headers } from "next/headers";
import { Fraunces } from "next/font/google";
import { createClient } from "@/lib/supabase/server";
import { NavTabs } from "@/components/NavTabs";
import { NotificationBell } from "@/components/NotificationBell";
import { StyleFeaturesMenu } from "@/components/StyleFeaturesMenu";
import { getRecentNotifications, getUnreadNotificationCount } from "@/lib/notifications";

// High-fashion italic serif for the homepage-only wordmark treatment
// below (early-2000s editorial/luxury feel — Blumarine/Dior/Miu Miu era —
// with real visual weight, not a thin/delicate face). Tried Cormorant
// Garamond Italic first, but even at font-semibold it stayed too thin —
// Google's build of that family (and of Instrument Serif / DM Serif
// Display, the next two options considered) tops out with genuinely thin
// strokes at any weight Google actually ships. Fraunces is the one of the
// three brief-preferred fonts (Instrument Serif Italic, Fraunces Italic,
// DM Serif Display Italic) that ships real heavy weights (100-900) rather
// than a single fixed weight — Instrument Serif and DM Serif Display are
// BOTH only available at weight 400 from Google, so no legitimate (non-
// synthetic) way to make either "significantly thicker." This is
// deliberately its own font object — a separate Fraunces instance from
// layout.tsx's site-wide --font-display variable — so every other
// heading/wordmark on the site (including this exact same "Lockette" text
// on every other page, still using that shared variable at its own
// weight) is completely unaffected by this one being loaded at a heavier
// weight/italic here.
const wordmarkItalic = Fraunces({
  subsets: ["latin"],
  weight: ["900"],
  style: ["italic"],
});

export async function Nav() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Set by src/proxy.ts (see that file's own comment) — read server-side
  // so the homepage-only font swap below is already correct in the first
  // render, with no client-side flash and no effect on any other route's
  // identical "Lockette" text.
  const pathname = (await headers()).get("x-pathname");
  const isHomepage = pathname === "/";

  // Rendered outside NavTabs entirely (rather than as one more of its
  // tabs) so it can't interfere with NavTabs' own DOM-measurement-based
  // sliding underline.
  const [initialNotifications, initialUnreadCount] = user
    ? await Promise.all([getRecentNotifications(), getUnreadNotificationCount()])
    : [[], 0];

  return (
    <header className="sticky top-0 z-30 border-b border-border-soft bg-nav">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-6 py-4">
        <Link
          href="/"
          className={`shrink-0 whitespace-nowrap ${
            isHomepage
              ? // font-black (900) — Fraunces genuinely ships a 900
                // weight (unlike Instrument Serif/DM Serif Display,
                // both capped at 400 from Google — see the font
                // object's own comment), so this is a real heavy cut,
                // not synthetic/faux bolding. tracking-normal (not
                // -tight) gives its italic strokes room rather than
                // crowding them; leading-none keeps its vertical
                // footprint the same as before despite italic's
                // slightly taller natural line-height, so nav
                // height/position are unaffected.
                `${wordmarkItalic.className} italic font-black tracking-normal leading-none`
              : // Every other route — untouched, same as before this file
                // ever had a homepage-only branch.
                "font-display font-bold tracking-tight"
          } text-2xl text-tag-pink-ink sm:text-4xl`}
        >
          Lockette
        </Link>

        <div className="flex items-center gap-2">
          {user && <StyleFeaturesMenu />}
          {user && (
            <NotificationBell
              initialNotifications={initialNotifications}
              initialUnreadCount={initialUnreadCount}
            />
          )}
          <NavTabs isSignedIn={Boolean(user)} />
        </div>
      </div>
    </header>
  );
}
