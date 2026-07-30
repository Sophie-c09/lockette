import type { Metadata } from "next";
import { getPurchaseQueueItems } from "@/lib/purchaseQueue";
import { PurchaseQueueView } from "@/components/admin/PurchaseQueueView";

// Internal tool — same "not linked from anywhere in the app's nav" posture
// as /admin/orders, gated by src/app/admin/layout.tsx (same email
// allowlist).
export const metadata: Metadata = {
  title: "Purchase Queue — Lockette admin",
};

export default async function PurchaseQueuePage() {
  const { items, error } = await getPurchaseQueueItems();

  if (error) {
    console.error("[purchase-queue-page]", error);
  }

  return <PurchaseQueueView initialItems={items} />;
}
