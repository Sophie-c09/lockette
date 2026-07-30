import type { Metadata } from "next";
import { getListingsForModeration } from "@/lib/listingModeration";
import { AdminListingsView } from "@/components/admin/AdminListingsView";

// Internal tool — same "not linked from anywhere in the app's nav" posture
// as the other /admin pages, gated by src/app/admin/layout.tsx.
export const metadata: Metadata = {
  title: "Listing moderation — Lockette admin",
};

const DEFAULT_FILTER = "flagged" as const;

export default async function AdminListingsPage() {
  const { items, error } = await getListingsForModeration(DEFAULT_FILTER);

  if (error) {
    console.error("[admin-listings-page]", error);
  }

  // `error` is passed through (not swallowed) so the client can render a
  // distinct "couldn't load" state — a fetch failure (e.g. the signed-in
  // account isn't actually flagged admin) must never look identical to a
  // genuinely empty queue.
  return <AdminListingsView initialItems={items} initialFilter={DEFAULT_FILTER} initialError={error} />;
}
