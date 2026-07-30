import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { RecreateOutfitForm } from "@/components/outfit/RecreateOutfitForm";

export const metadata: Metadata = {
  title: "Find This Look — Lockette",
};

export default async function RecreateOutfitPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  return <RecreateOutfitForm />;
}
