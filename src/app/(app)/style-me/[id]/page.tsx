import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getStyleMeRequest } from "@/app/actions/style-me";
import { StyleMeRevealView } from "@/components/style-me/StyleMeRevealView";

export const metadata: Metadata = {
  title: "Your Style Me bundle — Lockette",
};

export default async function StyleMeRequestPage({
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
  const { request, error } = await getStyleMeRequest(id);

  if (error || !request) {
    notFound();
  }

  return <StyleMeRevealView initialRequest={request} />;
}
