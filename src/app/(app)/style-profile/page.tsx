import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { generateStyleDna } from "@/lib/style-dna";
import { StyleProfileView } from "@/components/style-profile/StyleProfileView";

export const metadata: Metadata = {
  title: "Your Style DNA — Lockette",
};

export default async function StyleProfilePage() {
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
      "style_tags, favorite_brands, favorite_categories, favorite_colors, size_preference, budget_max, onboarding_completed_at",
    )
    .eq("user_id", user.id)
    .maybeSingle();

  if (!styleProfile?.onboarding_completed_at) {
    redirect("/onboarding");
  }

  const aesthetics: string[] = styleProfile.style_tags ?? [];
  const brands: string[] = styleProfile.favorite_brands ?? [];
  const categories: string[] = styleProfile.favorite_categories ?? [];
  const colors: string[] = styleProfile.favorite_colors ?? [];
  const size: string | null = styleProfile.size_preference ?? null;
  const budgetMax: number | null = styleProfile.budget_max ?? null;

  const styleDna = generateStyleDna({
    aesthetics,
    brands,
    categories,
    colors,
    size,
    budgetMax,
  });

  return (
    <StyleProfileView
      styleDna={styleDna}
      aesthetics={aesthetics}
      brands={brands}
      categories={categories}
      colors={colors}
      size={size}
      budgetMax={budgetMax}
    />
  );
}
