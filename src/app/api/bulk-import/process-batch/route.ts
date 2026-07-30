// Second phase of the bulk-import flow: given one chunk of candidate URLs
// (the client sends these in groups of ~25 — see ImportListingView.tsx),
// runs src/lib/bulk-import.ts's full extract -> enrich -> dedupe -> insert
// pipeline for that chunk and reports back what happened. Called once per
// chunk rather than once for the whole 100-listing run so no single
// request has to stay open for the entire multi-minute operation — each
// call only has to survive ~25 listings' worth of work.
//
// Same reasoning as discover/route.ts for why this checks admin status
// itself: /api/ routes aren't covered by src/app/admin/layout.tsx.
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isCurrentUserAdmin } from "@/lib/admin";
import {
  processBulkImportBatch,
  type CategoryCounts,
  type PriceMode,
  type SelectedCategory,
  type SelectedBrand,
} from "@/lib/bulk-import";
import { SELECTED_CATEGORY_OPTIONS, SELECTED_BRAND_OPTIONS } from "@/lib/marketplace-discovery";

// A chunk of ~25 URLs, each a real fetch (possibly a full Playwright
// render) plus two OpenAI calls, comfortably fits inside a few minutes but
// not inside a default serverless timeout.
export const maxDuration = 200;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

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

  const urls =
    isRecord(body) && Array.isArray(body.urls)
      ? body.urls.filter((url): url is string => typeof url === "string")
      : [];

  if (urls.length === 0) {
    return NextResponse.json({ error: "No URLs provided." }, { status: 400 });
  }

  // Category counts/running total are threaded through by the client (see
  // ImportListingView.tsx) from the previous batch's response so quota
  // enforcement in processBulkImportBatch sees the whole run, not just
  // this one chunk of ~25 URLs.
  const categoryCountsSoFar: CategoryCounts =
    isRecord(body) && isRecord(body.categoryCounts) ? (body.categoryCounts as CategoryCounts) : {};
  const totalInsertedSoFar =
    isRecord(body) && typeof body.totalInsertedSoFar === "number" ? body.totalInsertedSoFar : 0;
  const priceMode = parsePriceMode(isRecord(body) ? body.priceMode : undefined);
  const selectedCategories = parseSelectedCategories(isRecord(body) ? body.selectedCategories : undefined);
  const selectedBrands = parseSelectedBrands(isRecord(body) ? body.selectedBrands : undefined);

  try {
    const result = await processBulkImportBatch(
      urls,
      categoryCountsSoFar,
      totalInsertedSoFar,
      priceMode,
      selectedCategories,
      selectedBrands,
    );

    return NextResponse.json(result);
  } catch (error) {
    // Same reasoning as discover/route.ts's own try/catch — an unhandled
    // throw here would return Next's generic HTML error page instead of
    // JSON, breaking the client's response.json() parse in an unreadable
    // way instead of surfacing a real message.
    console.error("[bulk-import-process-batch] Batch processing failed:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "This batch failed. Please try again." },
      { status: 500 },
    );
  }
}
