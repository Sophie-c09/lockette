// First phase of the bulk-import flow (/admin/import's "Import 100
// Listings" button): finds candidate product URLs by crawling marketplace
// search results (src/lib/marketplace-discovery.ts). Doesn't extract or
// write anything yet — that's process-batch/route.ts, called once per
// chunk of the URLs this returns.
//
// This route lives under /api/, not /admin/ — src/app/admin/layout.tsx's
// shared auth gate only covers page routes, not API routes, so the admin
// check below is this route's own, real enforcement boundary (not
// decorative).
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isCurrentUserAdmin } from "@/lib/admin";
import {
  discoverListingUrls,
  SELECTED_CATEGORY_OPTIONS,
  SELECTED_BRAND_OPTIONS,
  type PriceMode,
  type SelectedCategory,
  type SelectedBrand,
} from "@/lib/marketplace-discovery";
import { createAdminClient } from "@/lib/supabase/admin";

const VALID_PRICE_MODES: PriceMode[] = ["under10", "under20", "any"];

function parsePriceMode(value: unknown): PriceMode {
  return typeof value === "string" && (VALID_PRICE_MODES as string[]).includes(value)
    ? (value as PriceMode)
    : "any";
}

const VALID_SELECTED_CATEGORIES: SelectedCategory[] = SELECTED_CATEGORY_OPTIONS.map((option) => option.value);

function parseSelectedCategories(value: unknown): SelectedCategory[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is SelectedCategory =>
    (VALID_SELECTED_CATEGORIES as string[]).includes(entry),
  );
}

const VALID_SELECTED_BRANDS: SelectedBrand[] = SELECTED_BRAND_OPTIONS.map((option) => option.value);

function parseSelectedBrands(value: unknown): SelectedBrand[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is SelectedBrand => (VALID_SELECTED_BRANDS as string[]).includes(entry));
}

// Crawling ~15 search terms across 3 platforms, each a real page load, can
// legitimately take a couple of minutes — and /admin/import's "Import 500
// Listings" button now asks for a much larger discoveryBuffer than before,
// which can mean visiting every (term, platform) combination
// (src/lib/marketplace-discovery.ts's own MAX_PAGES_TO_VISIT) rather than
// stopping early. This is a route-config bump, not a scraper-behavior
// change — that module's own per-page timeouts and visit budget are
// untouched. Even at 300s there's no hard guarantee a worst-case 45-page
// crawl finishes in time on every hosting plan; a discovery run that
// legitimately can't find enough candidates in the time available simply
// returns however many it found, same as it already does today.
export const maxDuration = 300;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user || !(await isCurrentUserAdmin(supabase, user.id))) {
    return NextResponse.json({ error: "Not authorized." }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  // Cap matches the largest bulk-import size (/admin/import's "Import 500
  // Listings" button) times its largest discovery buffer multiplier (2.0x,
  // for a strict "Under $10" run — see ImportListingView.tsx) — raising the
  // cap without raising it to match that buffer would silently truncate
  // the largest tier's candidate pool below what it actually asks for.
  const targetCount =
    isRecord(body) && typeof body.targetCount === "number" && body.targetCount > 0
      ? Math.min(body.targetCount, 1000)
      : 100;

  const priceMode = parsePriceMode(isRecord(body) ? body.priceMode : undefined);
  const selectedCategories = parseSelectedCategories(isRecord(body) ? body.selectedCategories : undefined);
  const selectedBrands = parseSelectedBrands(isRecord(body) ? body.selectedBrands : undefined);

  // Existing product_urls, so discovery never spends a page visit's worth
  // of nothing on a listing that's already been imported before.
  const adminSupabase = createAdminClient();
  const { data: existingRows, error: existingError } = await adminSupabase
    .from("listings")
    .select("product_url");

  if (existingError) {
    console.error("[bulk-import-discover] Failed to fetch existing product_urls:", existingError);
  }

  const excludeUrls = new Set(
    (existingRows ?? []).map((row) => row.product_url).filter((url): url is string => Boolean(url)),
  );

  try {
    const urls = await discoverListingUrls(targetCount, excludeUrls, priceMode, selectedCategories, selectedBrands);
    return NextResponse.json({ urls });
  } catch (error) {
    // Without this, an unexpected throw here (e.g. a Playwright launch
    // failure, a missing env var) would produce Next's generic HTML error
    // page instead of JSON — the client's response.json() call would then
    // throw on invalid JSON too, surfacing as an opaque failure instead of
    // a readable message.
    console.error("[bulk-import-discover] Discovery failed:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to find listings. Please try again." },
      { status: 500 },
    );
  }
}
