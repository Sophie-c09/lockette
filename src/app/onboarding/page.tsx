import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { OnboardingFlow } from "@/components/onboarding/OnboardingFlow";

export const metadata: Metadata = {
  title: "Find your style — Lockette",
};

export default async function OnboardingPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const { data: styleProfile } = await supabase
    .from("style_profiles")
    .select(
      "style_tags, favorite_brands, size_preference, budget_max, favorite_categories, favorite_colors",
    )
    .eq("user_id", user.id)
    .maybeSingle();

  return (
    <OnboardingFlow
      defaults={{
        aesthetics: styleProfile?.style_tags ?? [],
        brands: styleProfile?.favorite_brands ?? [],
        size: styleProfile?.size_preference ?? null,
        budgetMax: styleProfile?.budget_max ?? null,
        categories: styleProfile?.favorite_categories ?? [],
        colors: styleProfile?.favorite_colors ?? [],
      }}
    />
  );
}
