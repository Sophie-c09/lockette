import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { NavTabs } from "@/components/NavTabs";
import { NotificationBell } from "@/components/NotificationBell";
import { StyleFeaturesMenu } from "@/components/StyleFeaturesMenu";
import { getRecentNotifications, getUnreadNotificationCount } from "@/lib/notifications";

export async function Nav() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

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
          className="shrink-0 whitespace-nowrap font-display text-2xl font-bold tracking-tight text-tag-pink-ink sm:text-4xl"
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
