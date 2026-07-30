"use server";

// Admin side of the Personal Style Request feature — reviewing a user's
// inspiration, running the scraper, and curating a styled bundle. Mirrors
// src/lib/listingModeration.ts's shape/placement: a local requireAdmin()
// per file (not a shared import, matching that file's own convention),
// reads through the plain session client (RLS's is_admin() branch already
// permits admin reads), writes through createAdminClient() since there's
// no authenticated-role write policy on any of these tables.
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isCurrentUserAdmin } from "@/lib/admin";
import { createNotification } from "@/lib/notifications";
import { getSignedStyleRequestImageUrls } from "@/lib/style-request-photo";
import { generateBundleForRequest, saveGeneratedBundle, type GeneratedBundle } from "@/lib/bundle-generation";
import type { Listing } from "@/lib/supabase/listings.types";

async function requireAdmin(): Promise<{ error?: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user || !(await isCurrentUserAdmin(supabase, user.id))) {
    return { error: "Not authorized." };
  }

  return {};
}

export interface StyleRequestQueueItem {
  id: string;
  user_id: string;
  inspo_text: string | null;
  budget: number | null;
  categories: string[];
  status: "pending" | "in_progress" | "completed";
  created_at: string;
}

/** For /admin/style-requests — pending + in_progress requests, oldest first. */
export async function getStyleRequestsQueue(): Promise<{ items: StyleRequestQueueItem[]; error?: string }> {
  const authCheck = await requireAdmin();
  if (authCheck.error) return { items: [], error: authCheck.error };

  const supabase = await createClient();

  const { data, error } = await supabase
    .from("style_requests")
    .select("id, user_id, inspo_text, budget, categories, status, created_at")
    .in("status", ["pending", "in_progress"])
    .order("created_at", { ascending: true });

  if (error) {
    console.error("[style-request-admin] Failed to fetch queue:", error);
    return { items: [], error: error.message };
  }

  return { items: data ?? [] };
}

export interface StyleRequestDetail {
  id: string;
  inspoText: string | null;
  inspoImageUrls: string[];
  budget: number | null;
  categories: string[];
  status: "pending" | "in_progress" | "completed";
  bundle: { id: string; title: string; description: string | null; items: Listing[] } | null;
}

/**
 * For /admin/style-requests/[id]. As a side effect, flips a still-'pending'
 * request to 'in_progress' the first time an admin opens it — a natural
 * "someone's working on this" signal, idempotent (no-op past pending),
 * requiring no separate button/action.
 */
export async function getStyleRequestDetail(
  requestId: string,
): Promise<{ detail: StyleRequestDetail | null; error?: string }> {
  const authCheck = await requireAdmin();
  if (authCheck.error) return { detail: null, error: authCheck.error };

  const supabase = await createClient();

  const { data: request, error } = await supabase
    .from("style_requests")
    .select("id, inspo_text, inspo_images, budget, categories, status")
    .eq("id", requestId)
    .maybeSingle();

  if (error || !request) {
    return { detail: null, error: "Style request not found." };
  }

  if (request.status === "pending") {
    const adminSupabase = createAdminClient();
    const { error: statusError } = await adminSupabase
      .from("style_requests")
      .update({ status: "in_progress" })
      .eq("id", requestId)
      .eq("status", "pending");
    if (statusError) {
      console.error("[style-request-admin] Failed to flip status to in_progress:", statusError);
    } else {
      request.status = "in_progress";
    }
  }

  const inspoImageUrls = await getSignedStyleRequestImageUrls(supabase, request.inspo_images ?? []);

  let bundle: StyleRequestDetail["bundle"] = null;

  const { data: bundleRow } = await supabase
    .from("styled_bundles")
    .select("id, title, description")
    .eq("request_id", requestId)
    .maybeSingle();

  if (bundleRow) {
    const { data: itemRows } = await supabase
      .from("styled_bundle_items")
      .select("listing_id, listings(*)")
      .eq("bundle_id", bundleRow.id);

    const items = (itemRows ?? []).map((item) => item.listings as unknown as Listing).filter(Boolean);
    bundle = { id: bundleRow.id, title: bundleRow.title, description: bundleRow.description, items };
  }

  return {
    detail: {
      id: request.id,
      inspoText: request.inspo_text,
      inspoImageUrls,
      budget: request.budget,
      categories: request.categories ?? [],
      status: request.status as StyleRequestDetail["status"],
      bundle,
    },
  };
}

// Strips characters PostgREST's `.or()` filter-string grammar treats as
// syntax — same reasoning/approach as discover-feed.ts's
// sanitizeSearchQuery (not imported from there since that file has no
// exported search-filter builder to reuse; this is the same small, local
// helper shape every query-builder in this codebase already uses).
function sanitizeSearchQuery(raw: string): string {
  return raw.replace(/[,()]/g, "").trim();
}

/**
 * Admin's listing picker search — reuses Discover's exact query mechanics
 * (title/description ilike + aesthetic_tags overlap) restricted to
 * `status = 'active'` listings only, since only already-approved listings
 * should ever be picked into a bundle (see the plan's "never bypass
 * moderation" invariant). Plain session client — listings' select policy
 * is public.
 */
export async function searchActiveListings(query: string): Promise<{ listings: Listing[]; error?: string }> {
  const authCheck = await requireAdmin();
  if (authCheck.error) return { listings: [], error: authCheck.error };

  const supabase = await createClient();
  const safe = sanitizeSearchQuery(query);

  if (!safe) {
    return { listings: [] };
  }

  const { data, error } = await supabase
    .from("listings")
    .select(
      "id, title, description, price, image_url, product_url, platform, brand, category, size, color, aesthetic_tags, created_at",
    )
    .eq("status", "active")
    .or(`title.ilike.%${safe}%,description.ilike.%${safe}%`)
    .order("created_at", { ascending: false })
    .limit(40);

  if (error) {
    console.error("[style-request-admin] Search failed:", error);
    return { listings: [], error: error.message };
  }

  return { listings: (data as Listing[]) ?? [] };
}

/**
 * Curates the final bundle: inserts styled_bundles + styled_bundle_items,
 * marks the request completed, and notifies the requesting user. All
 * writes go through createAdminClient() since there's no authenticated
 * write policy on any of these tables (see supabase/schema.sql).
 */
export async function createBundleForRequest(
  requestId: string,
  input: { title: string; description: string; listingIds: string[] },
): Promise<{ error?: string; bundleId?: string }> {
  const authCheck = await requireAdmin();
  if (authCheck.error) return authCheck;

  if (!input.title.trim()) {
    return { error: "Give the bundle a title." };
  }
  if (input.listingIds.length === 0) {
    return { error: "Pick at least one listing for the bundle." };
  }

  const adminSupabase = createAdminClient();

  const { data: request, error: requestError } = await adminSupabase
    .from("style_requests")
    .select("user_id")
    .eq("id", requestId)
    .maybeSingle();

  if (requestError || !request) {
    return { error: "Style request not found." };
  }

  const { data: bundle, error: bundleError } = await adminSupabase
    .from("styled_bundles")
    .insert({ request_id: requestId, title: input.title.trim(), description: input.description.trim() || null })
    .select("id")
    .single();

  if (bundleError || !bundle) {
    return { error: bundleError?.message ?? "Couldn't create the bundle." };
  }

  const { error: itemsError } = await adminSupabase
    .from("styled_bundle_items")
    .insert(input.listingIds.map((listingId) => ({ bundle_id: bundle.id, listing_id: listingId })));

  if (itemsError) {
    await adminSupabase.from("styled_bundles").delete().eq("id", bundle.id);
    return { error: itemsError.message };
  }

  const { error: statusError } = await adminSupabase
    .from("style_requests")
    .update({ status: "completed" })
    .eq("id", requestId);

  if (statusError) {
    console.error("[style-request-admin] Failed to mark request completed:", statusError);
  }

  await createNotification({
    userId: request.user_id,
    type: "style_request_completed",
    title: "Your outfit is ready!",
    message: `We put together "${input.title.trim()}" just for you.`,
  });

  return { bundleId: bundle.id };
}

export interface GeneratedBundlePreview {
  bundle: GeneratedBundle;
  requestUserId: string;
}

/**
 * Runs the AI generation pipeline (src/lib/bundle-generation.ts) and
 * hands back the result WITHOUT saving it — lets an admin see what the
 * AI would produce (items, pricing, delivery estimate) before committing
 * to it, same "review before it's real" spirit as the existing manual
 * flow's own search-then-create-bundle two-step. Call
 * confirmGeneratedBundle below to actually persist it.
 */
export async function previewAIBundle(requestId: string): Promise<{ preview?: GeneratedBundlePreview; error?: string }> {
  const authCheck = await requireAdmin();
  if (authCheck.error) return { error: authCheck.error };

  const supabase = await createClient();
  const { data: request, error: requestError } = await supabase
    .from("style_requests")
    .select("user_id")
    .eq("id", requestId)
    .maybeSingle();

  if (requestError || !request) {
    return { error: "Style request not found." };
  }

  const result = await generateBundleForRequest(requestId);
  if (result.error || !result.bundle) {
    return { error: result.error ?? "Couldn't generate a bundle from this request's inspiration." };
  }

  return { preview: { bundle: result.bundle, requestUserId: request.user_id } };
}

/**
 * Persists a bundle already produced by previewAIBundle — the
 * AI-generated counterpart to createBundleForRequest above, writing to
 * the exact same styled_bundles/styled_bundle_items tables (plus the new
 * pricing/delivery/preview/position/category/replacement_group columns
 * that feature added — see supabase/schema.sql), so both bundle-creation
 * paths produce rows the rest of the app (BundleCard, cart, etc.) reads
 * identically.
 */
export async function confirmAIBundle(
  requestId: string,
  preview: GeneratedBundlePreview,
): Promise<{ error?: string; bundleId?: string }> {
  const authCheck = await requireAdmin();
  if (authCheck.error) return authCheck;

  const result = await saveGeneratedBundle(requestId, preview.requestUserId, preview.bundle.analysis.outfitDescription.slice(0, 80) || "Your Lockette Bundle", preview.bundle);

  if (result.error) return { error: result.error };

  await createNotification({
    userId: preview.requestUserId,
    type: "style_request_completed",
    title: "Your outfit is ready!",
    message: "Your AI-styled Lockette bundle is ready to view.",
  });

  return { bundleId: result.bundleId };
}
