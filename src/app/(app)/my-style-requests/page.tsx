import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getMyStyleRequests } from "@/app/actions/style-requests";
import { MyStyleRequestsView } from "@/components/style-request/MyStyleRequestsView";

export const metadata: Metadata = {
  title: "My style requests — Lockette",
};

export default async function MyStyleRequestsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const { requests, error } = await getMyStyleRequests();

  if (error) {
    console.error("[my-style-requests-page]", error);
  }

  return <MyStyleRequestsView requests={requests} />;
}
