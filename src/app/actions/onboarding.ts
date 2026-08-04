"use server";

import { createClient } from "@/lib/supabase/server";
import { mergeDislikedStyleSignals, type DislikedStyles } from "@/lib/disliked-styles";
import { generateAndSaveStyleEmbedding } from "@/lib/style-embedding";
import { MIN_BRANDS_REQUIRED } from "@/lib/onboarding-data";

export interface OnboardingPayload {
  aesthetics: string[];
  brands: string[];
  size: string | null;
  budgetMax: number | null;
  categories: string[];
  colors: string[];
  // Aesthetic tags to actively avoid (distinct from disliked_items, which
  // is about individual listings) — optional since no onboarding step
  // collects this yet. Genuinely omitted (not defaulted to []) when unset,
  // so re-saving onboarding never overwrites disliked_styles' real,
  // accumulated count/last_seen data from actually disliking listings on
  // /match (src/app/actions/dislikes.ts) — see the merge logic below.
  dislikedAesthetics?: string[];
}

export async function saveOnboarding(
  payload: OnboardingPayload,
): Promise<{ error?: string }> {
  const supabase = await createClient();
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError || !user) {
    return { error: "You must be signed in to save your style profile." };
  }

  // P0 first-60-seconds fix (item 9) — "user must choose at least five
  // brands." StepBrands.tsx/OnboardingFlow.tsx already block the client
  // from reaching this call with fewer, but this is the real, load-
  // bearing enforcement (a disabled Continue button is a UX nicety, not
  // a guarantee — a request built by hand or with JS disabled could
  // still reach this action directly).
  if (payload.brands.length < MIN_BRANDS_REQUIRED) {
    return { error: `Please choose at least ${MIN_BRANDS_REQUIRED} brands.` };
  }

  // Fashion preferences live on style_profiles, not profiles — keeps
  // identity data separate from onboarding/quiz data.
  const upsertPayload: Record<string, unknown> = {
    user_id: user.id,
    style_tags: payload.aesthetics,
    favorite_brands: payload.brands,
    size_preference: payload.size,
    budget_max: payload.budgetMax,
    favorite_categories: payload.categories,
    favorite_colors: payload.colors,
    onboarding_completed_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  // Only touch disliked_styles when this call actually supplies some —
  // Supabase's upsert only overwrites columns present in the payload
  // object, so simply never adding the key here (rather than adding it
  // with an empty-array/empty-object fallback) is what keeps a plain
  // "save my onboarding answers" call from wiping out real dislike history
  // it knows nothing about. Merged (not replaced) against whatever's
  // already there, same reasoning as dislikeListing.
  if (payload.dislikedAesthetics && payload.dislikedAesthetics.length > 0) {
    const { data: existingProfile } = await supabase
      .from("style_profiles")
      .select("disliked_styles")
      .eq("user_id", user.id)
      .maybeSingle();

    const existingDislikedStyles: DislikedStyles = existingProfile?.disliked_styles ?? {};
    upsertPayload.disliked_styles = mergeDislikedStyleSignals(
      existingDislikedStyles,
      payload.dislikedAesthetics,
      new Date().toISOString(),
    );
  }

  // Upsert (not update): an `update` matches zero rows and silently no-ops
  // if the signup trigger hasn't created this user's style_profiles row yet,
  // and Supabase's default `Prefer: return=minimal` means that zero-row case
  // reports back exactly like a real success — no error, nothing saved.
  // `.select().single()` forces a representation back so a missing row
  // surfaces as a real, reportable error instead of a silent no-op.
  const { data, error } = await supabase
    .from("style_profiles")
    .upsert(upsertPayload, { onConflict: "user_id" })
    .select("id")
    .single();

  if (error) {
    return { error: error.message };
  }

  if (!data) {
    return {
      error: "Your style profile couldn't be saved. Please try again.",
    };
  }

  // Part 4 of the recommendation-integration architecture — awaited
  // (this is a single embedding call, not a multi-step pipeline, so the
  // added latency is comparable to any other synchronous AI call already
  // in this codebase, e.g. classifyOutfitPhotoForRecreation) but never
  // throws and never fails this save: generateAndSaveStyleEmbedding
  // catches every failure internally and just logs it (see that
  // function's own header comment) — the onboarding save above has
  // already succeeded regardless of what happens here.
  await generateAndSaveStyleEmbedding(user.id);

  return {};
}
