import type { Metadata } from "next";
import { getImportDashboardStats } from "@/lib/import-dashboard";
import { ImportListingView } from "@/components/admin/ImportListingView";

// Internal tool — not linked from anywhere in the app's nav, gated by
// src/app/admin/layout.tsx (profiles.is_admin, see src/lib/admin.ts).
export const metadata: Metadata = {
  title: "Import listing — Lockette admin",
};

export default async function AdminImportPage() {
  const { stats, error } = await getImportDashboardStats();

  if (error) {
    console.error("[admin-import-page]", error);
  }

  return <ImportListingView initialStats={stats} />;
}
