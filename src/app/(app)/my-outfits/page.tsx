import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getMyOutfitRecreations } from "@/app/actions/outfit-recreations";
import { MyOutfitsView } from "@/components/outfit/MyOutfitsView";

export const metadata: Metadata = {
  title: "My outfit recreations — Lockette",
};

export default async function MyOutfitsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const { recreations, error } = await getMyOutfitRecreations();

  if (error) {
    console.error("[my-outfits-page]", error);
  }

  return <MyOutfitsView recreations={recreations} />;
}
