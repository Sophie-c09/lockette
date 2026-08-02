// Internal-tool endpoint for /admin/import, called from ImportListingView.tsx.
//
// Also owns the Supabase write for each imported listing, via the
// service-role client (createAdminClient) — the client-side bulk-import
// loop only ever calls this route through fetch(); it never calls a
// Server Action directly. That used to happen via a separate saveListing
// Server Action called from ImportListingView.tsx in a loop, which caused
// a "Cannot read properties of undefined (reading 'apply')" runtime error
// (see ImportListingView.tsx for the full explanation) — consolidating
// the write in here removes that code path entirely.
//
// This route lives under /api/, not /admin/ — src/app/admin/layout.tsx's
// shared auth gate only covers page routes, not API routes, so the admin
// check below is this route's own, real enforcement boundary (not
// decorative), same convention as /api/bulk-import/discover and every
// other /api/admin-scraper/* route. This was previously missing here —
// an unauthenticated caller could write directly to `listings` via the
// service-role client below, bypassing RLS entirely.
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isCurrentUserAdmin } from "@/lib/admin";
import { extractListingFromUrl } from "@/lib/listing-extraction";
import { enrichListing } from "@/lib/listing-enrichment";
import { generateAndSaveListingEmbedding } from "@/lib/listing-embeddings";
import { scoreListingQuality } from "@/lib/listing-quality";
import { flagListing } from "@/lib/inventory/listing-flagging";
import { checkForDuplicate } from "@/lib/inventory/duplicate-detection";
import { createAdminClient } from "@/lib/supabase/admin";
import type { ListingsDatabase } from "@/lib/supabase/listings.types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// Marketplace-charged shipping default, applied at import time — not
// something the extractor can read off the page, so it's a per-platform
// business rule rather than extracted data. Any platform without a known
// rule (including null/unrecognized) defaults to 0.
const SHIPPING_COST_BY_PLATFORM: Record<string, number> = {
  Depop: 2,
  Vinted: 0,
};

function shippingCostForPlatform(platform: string | null): number {
  if (!platform) return 0;
  return SHIPPING_COST_BY_PLATFORM[platform] ?? 0;
}

// Columns from schema.sql migrations that may not have been applied to a
// given database yet — writing any of these keys fails the *entire*
// insert/update with a "column does not exist" error, which would
// silently break every import rather than just leaving the new fields
// unpopulated. Retrying once with all of them stripped keeps imports
// working (per the "never block an import over missing metrics"
// requirement). `shipping_cost` is included here too — confirmed live
// that it can be absent even though it's one of the older additions to
// this table, so it gets the same defensive treatment as the newer
// Hot Item engagement columns.
const SOURCE_ENGAGEMENT_KEYS = [
  "source_likes_count",
  "source_views_count",
  "source_comments_count",
  "shipping_cost",
  "quality_score",
  "quality_reason",
  "quality_breakdown",
] as const;

// Two different error shapes can mean "this column doesn't exist yet,"
// depending on where the failure is caught: PostgREST rejects an unknown
// insert/update key itself (PGRST204, "Could not find the 'x' column of
// 'listings' in the schema cache") before the query ever reaches Postgres,
// while a raw Postgres error (from other query shapes) reads "column ...
// does not exist" — matching both, verified live against the real error
// PostgREST returns for this exact scenario rather than guessed.
function isMissingColumnError(error: { code?: string; message: string }): boolean {
  return error.code === "PGRST204" || /column .* does not exist/i.test(error.message);
}

function withoutSourceEngagementFields<T extends Record<string, unknown>>(payload: T): T {
  const clone = { ...payload };
  for (const key of SOURCE_ENGAGEMENT_KEYS) delete clone[key];
  return clone;
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

  const url = isRecord(body) && typeof body.url === "string" ? body.url.trim() : "";

  if (!url) {
    return NextResponse.json(
      { error: "A listing URL is required." },
      { status: 400 },
    );
  }

  let listing;
  try {
    listing = await extractListingFromUrl(url);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to extract listing.";
    return NextResponse.json({ error: message }, { status: 422 });
  }

  // Text classification + AI image tagging — shared with the bulk
  // importer (src/lib/bulk-import.ts) via src/lib/listing-enrichment.ts so
  // both pipelines enrich listings identically. Never blocks an import:
  // enrichListing() already catches its own errors internally.
  const enrichedListing = await enrichListing(listing);

  if (!enrichedListing.title.trim()) {
    return NextResponse.json(
      { error: "This listing is missing a title." },
      { status: 422 },
    );
  }

  // Same quality score the bulk importer uses (src/lib/listing-quality.ts)
  // — stored here too so /admin/listings shows a consistent score
  // regardless of which importer created the listing, but NOT used to
  // reject anything: pasting one specific URL here is a deliberate admin
  // decision, unlike the bulk importer's own no-human-in-the-loop
  // discovery. Never throws — scoreListingQuality already fails open.
  const { qualityScore, qualityReason, breakdown } = await scoreListingQuality(enrichedListing);

  let adminSupabase;
  try {
    adminSupabase = createAdminClient<ListingsDatabase>();
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Server misconfigured.";
    return NextResponse.json({ error: message }, { status: 500 });
  }

  // A listing URL should only ever have one row — re-importing the same
  // URL (common while testing, or re-running a bulk import) updates the
  // existing row with the freshly extracted/enriched data instead of
  // creating a duplicate. Keying off product_url (not id) is what makes
  // this a dedupe check rather than a normal upsert.
  //
  // order + limit(1) rather than a bare .maybeSingle() lookup: if this URL
  // somehow already has more than one row (e.g. duplicates created before
  // this check existed), .maybeSingle() would error on "multiple rows
  // returned" — picking the most recent match to update is a safe,
  // idempotent way to converge back toward one row per URL over time.
  const { data: existingRows } = await adminSupabase
    .from("listings")
    .select("id")
    .eq("product_url", enrichedListing.product_url)
    .order("created_at", { ascending: false })
    .limit(1);

  const existing = existingRows?.[0] ?? null;

  // Same conservative duplicate cascade bulk-import.ts and admin-scraper.ts
  // use (image hash + a title/brand/price/platform/category fallback
  // fingerprint) — an exact product_url match above already means "same
  // URL, refresh it" (handled below), but a DIFFERENT URL for the same
  // physical item (a reseller re-listing, or the same photo re-hosted)
  // must not silently create a second row just because this is a manual
  // single-URL import rather than a scraper batch.
  if (!existing) {
    const duplicate = await checkForDuplicate({
      title: enrichedListing.title,
      product_url: enrichedListing.product_url,
      image_url: enrichedListing.image_url,
      price: enrichedListing.price,
      brand: enrichedListing.brand,
      platform: enrichedListing.platform,
      category: enrichedListing.category,
    });
    if (duplicate.isDuplicate) {
      return NextResponse.json(
        {
          error:
            "This looks like a duplicate of a listing already in the catalog " +
            `(match confidence ${Math.round(duplicate.confidence * 100)}%).`,
          duplicateOfListingId: duplicate.matchedListingId,
        },
        { status: 409 },
      );
    }
  }

  // removal_signal is a transient field the extraction pipeline computes
  // for flagListing() below — it has no matching column on `listings`, so
  // it's destructured out here rather than spread into the DB write
  // payload (which would fail with an "unknown column" type error, or
  // worse, at the actual PostgREST call).
  const { removal_signal: removalSignal, ...enrichedListingForStorage } = enrichedListing;

  const listingToWrite = {
    ...enrichedListingForStorage,
    shipping_cost: shippingCostForPlatform(enrichedListing.platform),
    quality_score: qualityScore,
    quality_reason: qualityReason,
    quality_breakdown: breakdown,
  };

  if (existing) {
    console.warn(`[listing-import] Existing listing found, updating: ${existing.id}`);

    let { data, error } = await adminSupabase
      .from("listings")
      .update(listingToWrite)
      .eq("id", existing.id)
      .select()
      .single();

    if (error && isMissingColumnError(error)) {
      console.warn(
        "[listing-import] source_* engagement columns not found on this database yet — retrying without them. Run the latest supabase/schema.sql to enable Hot Item detection.",
      );
      ({ data, error } = await adminSupabase
        .from("listings")
        .update(withoutSourceEngagementFields(listingToWrite))
        .eq("id", existing.id)
        .select()
        .single());
    }

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ success: true, data });
  }

  // "Scraped listings go live automatically unless flagged" — flagListing()
  // (src/lib/inventory/listing-flagging.ts) is the new lightweight safety
  // net, additive to the AI quality score already computed above; only set
  // on this insert path, not the update-existing-row path above: refreshing
  // an already-reviewed listing's scraped data should never silently
  // re-flag or re-hide something an admin already reviewed.
  const flag = flagListing({
    title: listingToWrite.title,
    description: listingToWrite.description,
    images: listingToWrite.images,
    price: listingToWrite.price,
    category: listingToWrite.category,
    productUrl: listingToWrite.product_url,
    platform: listingToWrite.platform,
    removalSignal,
  });
  const computedStatus = flag.isSafe ? ("active" as const) : ("flagged" as const);
  const computedFlagReason = flag.isSafe ? null : (flag.reasons ?? []).join(", ");

  if (flag.isSafe) {
    console.log("[IMPORT] Auto-live:", listingToWrite.title, listingToWrite.price);
  } else {
    console.log("[IMPORT] Flagged:", flag.reasons);
  }

  let { data, error } = await adminSupabase
    .from("listings")
    .insert({ ...listingToWrite, status: computedStatus, flag_reason: computedFlagReason })
    .select()
    .single();

  if (error && isMissingColumnError(error)) {
    console.warn(
      "[listing-import] source_* engagement columns or shipping_cost not found on this database yet — retrying without them. Run the latest supabase/schema.sql to enable Hot Item detection and the moderation queue.",
    );
    // `status` is deliberately kept IN this retry payload, unlike the
    // other optional fields (including the new flag_reason) — dropping it
    // would let Postgres fall back to the column's own default, which is
    // NOT guaranteed to be anything sensible (confirmed live: it can still
    // be a stale pre-moderation-queue default if schema.sql's own `alter
    // column status set default` hasn't been re-run). A listing silently
    // going live as 'active' without having actually been flag-checked is
    // exactly what this can't risk, so this can't route through
    // withoutSourceEngagementFields' generic delete (which would also
    // widen status off its literal type — see that function's own
    // comment) — a direct destructure that never touches status is used
    // instead.
    /* eslint-disable @typescript-eslint/no-unused-vars -- destructured only to omit these possibly-not-yet-migrated columns */
    const {
      source_likes_count,
      source_views_count,
      source_comments_count,
      shipping_cost,
      quality_score,
      quality_reason,
      quality_breakdown,
      flag_reason,
      ...withoutOptionalFields
    } = {
      ...listingToWrite,
      status: computedStatus,
      flag_reason: computedFlagReason,
    };
    /* eslint-enable @typescript-eslint/no-unused-vars */
    ({ data, error } = await adminSupabase
      .from("listings")
      .insert(withoutOptionalFields)
      .select()
      .single());
  }

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Reassigning `data`/`error` across the retry above (rather than a single
  // destructure) loses TypeScript's "error null implies data non-null"
  // narrowing — this can't actually happen (Postgres wouldn't return a
  // success response with no row), but the check keeps this honest.
  if (!data) {
    return NextResponse.json({ error: "Import succeeded but returned no data." }, { status: 500 });
  }

  console.warn(`[listing-import] New listing created: ${data.id}`);

  // Best-effort, never blocks this import — see
  // generateAndSaveListingEmbedding's own comment
  // (src/lib/listing-embeddings.ts).
  await generateAndSaveListingEmbedding(data.id, data.image_url ?? null);

  return NextResponse.json({ success: true, data });
}
