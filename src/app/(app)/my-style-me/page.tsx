import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getMyStyleMeRequests } from "@/app/actions/style-me";
import { MyStyleMeView } from "@/components/style-me/MyStyleMeView";

export const metadata: Metadata = {
  title: "My Style Me bundles — Lockette",
};

export default async function MyStyleMePage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const { requests, error } = await getMyStyleMeRequests();

  if (error) {
    console.error("[my-style-me-page]", error);
  }

  return <MyStyleMeView requests={requests} />;
}
