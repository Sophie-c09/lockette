import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { isCurrentUserAdmin } from "@/lib/admin";

// Single admin-auth gate for every /admin/* route (import, orders,
// purchase-queue, listings, and any future one) — replaces the identical
// redirect+"Access denied" check that used to be duplicated in each admin
// page's own component (and was missing entirely on /admin/import, which
// had no protection at all). A `redirect()` call here aborts rendering
// before any page component below it ever runs, so this is a real gate,
// not just a UI nicety — same profiles.is_admin check as everywhere else
// in the app (see src/lib/admin.ts).
export default async function AdminLayout({ children }: { children: ReactNode }) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  if (!(await isCurrentUserAdmin(supabase, user.id))) {
    return (
      <div className="px-6 py-12 text-center text-sm text-ink-soft">
        Access denied.
      </div>
    );
  }

  return <>{children}</>;
}
