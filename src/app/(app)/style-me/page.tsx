import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { StyleMeForm } from "@/components/style-me/StyleMeForm";

export const metadata: Metadata = {
  title: "Style Me — Lockette",
};

export default async function StyleMePage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  return <StyleMeForm />;
}
