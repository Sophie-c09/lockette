import type { Metadata } from "next";
import { redirect, notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getBundleById } from "@/app/actions/style-requests";
import { BundleOutfitView } from "@/components/style-request/BundleOutfitView";

export const metadata: Metadata = {
  title: "Your Lockette Bundle",
};

// Where a user now lands immediately after submitting a style request
// (src/app/actions/style-requests.ts's submitStyleRequest redirects here
// the moment AI generation finishes — see that file's own comment on why
// admin review is optional now, not required). Also reachable any time
// from /my-style-requests, which links/embeds the same bundle.
export default async function BundlePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const { bundle, error } = await getBundleById(id);

  if (error || !bundle) {
    notFound();
  }

  return (
    <div className="min-h-screen bg-teal-soft">
      <div className="mx-auto max-w-2xl px-6 py-12">
        <BundleOutfitView bundle={bundle} />
      </div>
    </div>
  );
}
