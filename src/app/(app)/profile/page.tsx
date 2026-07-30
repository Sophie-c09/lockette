import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { generateStyleDna } from "@/lib/style-dna";
import { ProfileView } from "@/components/profile/ProfileView";

export const metadata: Metadata = {
  title: "Your profile — Lockette",
};

export default async function ProfilePage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const [{ data: profile }, { data: styleProfile }] = await Promise.all([
    supabase
      .from("profiles")
      .select("username, display_name, avatar_url, bio")
      .eq("id", user.id)
      .maybeSingle(),
    supabase
      .from("style_profiles")
      .select(
        "style_tags, favorite_brands, favorite_categories, favorite_colors, size_preference, budget_max, onboarding_completed_at",
      )
      .eq("user_id", user.id)
      .maybeSingle(),
  ]);

  // Basic identity isn't set up yet — finish that before viewing the profile.
  if (!profile?.username || !profile?.display_name) {
    redirect("/profile/setup");
  }

  const initials = profile.display_name
    .split(" ")
    .map((part: string) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  const hasStyleDna = Boolean(styleProfile?.onboarding_completed_at);
  const aesthetics: string[] = styleProfile?.style_tags ?? [];
  const styleDna = hasStyleDna
    ? generateStyleDna({
        aesthetics,
        brands: styleProfile?.favorite_brands ?? [],
        categories: styleProfile?.favorite_categories ?? [],
        colors: styleProfile?.favorite_colors ?? [],
        size: styleProfile?.size_preference ?? null,
        budgetMax: styleProfile?.budget_max ?? null,
      })
    : null;

  return (
    <ProfileView
      displayName={profile.display_name}
      username={profile.username}
      bio={profile.bio}
      initials={initials}
      avatarUrl={profile.avatar_url}
      hasStyleDna={hasStyleDna}
      styleDna={styleDna}
      aesthetics={aesthetics}
    />
  );
}
