import type { Metadata } from "next";
import { getStyleRequestsQueue } from "@/lib/styleRequestAdmin";
import { StyleRequestsQueueView } from "@/components/admin/StyleRequestsQueueView";

export const metadata: Metadata = {
  title: "Style requests — Lockette admin",
};

export default async function AdminStyleRequestsPage() {
  const { items, error } = await getStyleRequestsQueue();

  if (error) {
    console.error("[admin-style-requests-page]", error);
  }

  return <StyleRequestsQueueView items={items} initialError={error} />;
}
