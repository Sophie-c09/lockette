import type { Metadata } from "next";
import { AiDebugView } from "@/components/admin/AiDebugView";

// Part 7 of the recommendation-integration architecture — internal tool,
// same "not linked from anywhere in the app's nav" posture as
// /admin/orders, gated by src/app/admin/layout.tsx's shared admin check.
export const metadata: Metadata = {
  title: "AI Debug — Lockette admin",
};

export default function AiDebugPage() {
  return <AiDebugView />;
}
