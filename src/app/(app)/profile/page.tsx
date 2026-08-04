import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { generateStyleDna } from "@/lib/style-dna";
import { ProfileView } from "@/components/profile/ProfileView";
import { RetryButton } from "@/components/ui/RetryButton";

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

  const [
    { data: profile, error: profileError },
    { data: styleProfile, error: styleProfileError },
  ] = await Promise.all([
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

  // Pre-launch polish fix (item 4) — a failed query here used to leave
  // profile/styleProfile as undefined, which the check right below this
  // used to read as "never finished onboarding" and silently redirect to
  // /profile/setup — a real fetch failure masquerading as a stale account.
  // Surfacing it here as a genuine error state (with a retry) keeps that
  // redirect meaning what it says: identity genuinely isn't set up yet.
  if (profileError || styleProfileError) {
    return (
      <div className="flex min-h-[calc(100vh-137px)] items-center justify-center px-6 text-center">
        <div className="mx-auto flex max-w-md flex-col items-center gap-4 rounded-card bg-highlight-cream px-8 py-16 text-center">
          <p className="text-sm text-ink-soft">Something went wrong loading your profile.</p>
          <RetryButton />
        </div>
      </div>
    );
  }

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
