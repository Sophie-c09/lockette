import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getOutfitRecreation } from "@/app/actions/outfit-recreations";
import { OutfitRecreationView } from "@/components/outfit/OutfitRecreationView";

export const metadata: Metadata = {
  title: "Your Recreated Outfit — Lockette",
};

export default async function OutfitRecreationPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const { id } = await params;
  const { recreation, error } = await getOutfitRecreation(id);

  if (error || !recreation) {
    notFound();
  }

  return <OutfitRecreationView recreation={recreation} />;
}
