import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getStyleRequestDetail } from "@/lib/styleRequestAdmin";
import { StyleRequestDetailView } from "@/components/admin/StyleRequestDetailView";

export const metadata: Metadata = {
  title: "Style request — Lockette admin",
};

export default async function AdminStyleRequestDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { detail, error } = await getStyleRequestDetail(id);

  if (error || !detail) {
    console.error("[admin-style-request-detail-page]", error);
    notFound();
  }

  return <StyleRequestDetailView detail={detail} />;
}
