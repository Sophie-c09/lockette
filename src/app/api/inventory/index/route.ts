// Admin-triggered entry point for the inventory indexer (Part 3). Same
// after()-based "return immediately, keep working in the background"
// shape as /api/admin-scraper/run and /api/admin-scraper/large-scale —
// Part 14: never block a request on AI work. One call runs one bounded
// round of both indexer stages (indexNewListings + processEnrichmentBatch,
// see inventory-indexer.ts's own runInventoryIndexer); call it again (or
// wire it to a schedule) to keep working through the backlog, same
// "repeat the bounded batch" shape the large-scale scraper already uses.
import { NextResponse, after } from "next/server";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { isCurrentUserAdmin } from "@/lib/admin";
import { runInventoryIndexer, runFullInventoryEmbeddingBackfill } from "@/lib/inventory/inventory-indexer";

export const maxDuration = 300;

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
    body = {};
  }

  const input = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  const fetchBatchSize = typeof input.fetchBatchSize === "number" ? input.fetchBatchSize : undefined;
  const processBatchSize = typeof input.processBatchSize === "number" ? input.processBatchSize : undefined;
  // Opt-in — default (false) preserves this route's existing "one bounded
  // round" behavior exactly. When true, runs runFullInventoryEmbeddingBackfill
  // instead: the same bounded-batch stages, just looped until the catalog
  // actually converges (see that function's own doc comment), for
  // "generate embeddings for all inventory" in one click instead of
  // clicking this button repeatedly.
  const fullBackfill = input.fullBackfill === true;

  after(async () => {
    try {
      const result = fullBackfill
        ? await runFullInventoryEmbeddingBackfill({ fetchBatchSize, processBatchSize })
        : await runInventoryIndexer({ fetchBatchSize, processBatchSize });
      console.log("[inventory-index-route] Round complete:", result);
      revalidatePath("/admin/import");
    } catch (error) {
      console.error("[inventory-index-route] Background indexing round failed:", error);
    }
  });

  return NextResponse.json({ started: true });
}
