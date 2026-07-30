import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { Card } from "@/components/ui/Card";
import { ProfileForm } from "@/components/profile/ProfileForm";

export const metadata: Metadata = {
  title: "Complete your profile — Lockette",
};

export default async function ProfileSetupPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("username, display_name, bio, avatar_url")
    .eq("id", user.id)
    .maybeSingle();

  return (
    <div className="px-6 py-16">
      <div className="mx-auto max-w-3xl">
        <div className="mb-8 text-center">
          <h1 className="font-display text-2xl font-semibold text-ink">
            Complete your profile
          </h1>
          <p className="mt-1 text-sm text-ink-soft">
            Let&apos;s get the basics set up before you build your style DNA.
          </p>
        </div>

        <Card className="p-8">
          <ProfileForm
            defaultValues={{
              username: profile?.username ?? "",
              displayName: profile?.display_name ?? "",
              bio: profile?.bio ?? "",
              avatarUrl: profile?.avatar_url ?? null,
            }}
          />
        </Card>
      </div>
    </div>
  );
}
