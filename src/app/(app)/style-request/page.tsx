import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { StyleRequestForm } from "@/components/style-request/StyleRequestForm";

export const metadata: Metadata = {
  title: "Get Styled — Lockette",
};

export default async function StyleRequestPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  return <StyleRequestForm />;
}
