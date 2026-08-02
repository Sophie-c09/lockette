// Hand-written types for the `listings` table (supabase/schema.sql).
// Scoped to this one table rather than the whole database — the project has
// no generated Database type yet, and typing every existing table here
// would risk drifting out of sync with the real schema. Shaped the same way
// `supabase gen types typescript` output looks, so it slots in cleanly if
// full codegen is introduced later.
import type { QualityScoreBreakdown } from "@/lib/listing-quality";
import type { VisualListingAnalysis } from "@/lib/ai/visual-listing-analysis";

export type ListingStatus =
  | "active"
  | "sold"
  | "unavailable"
  | "pending"
  | "flagged"
  | "rejected"
  | "removed"
  | "expired";

export interface ListingsDatabase {
  public: {
    Tables: {
      listings: {
        Row: {
          id: string;
          title: string;
          description: string | null;
          price: number | null;
          image_url: string | null;
          // Optional (unlike the other fields, which every existing query
          // already selects in full): discover/feed deliberately don't
          // select this column to avoid loading full galleries into list
          // views, so it's genuinely absent from those results at runtime,
          // not just unset — only present when a query explicitly selects it.
          images?: string[];
          product_url: string | null;
          platform: string | null;
          brand: string | null;
          // Optional, same reasoning as images above — the listing detail
          // page's restored query doesn't select category/color (not part
          // of what it displays), so these are genuinely absent there.
          category?: string | null;
          size: string | null;
          color?: string | null;
          aesthetic_tags: string[];
          // Optional, same reasoning as images above — only Listing
          // detail/Cart/Match actually need this, so other list queries
          // (Discover/Feed) don't select it.
          shipping_cost?: number;
          // Optional — only the listing detail page selects these (to
          // decide whether to show the "someone is securing this" state);
          // Discover/Feed/Match instead filter reserved listings out of
          // their queries entirely (see src/lib/reservations.ts) rather
          // than needing to read these columns per-row.
          reserved_by_order_id?: string | null;
          reserved_at?: string | null;
          reservation_expires_at?: string | null;
          // Engagement counts from the ORIGINAL marketplace listing (see
          // src/lib/hot-score.ts) — optional/nullable since most imports
          // never populate these (the extractor can only capture them when
          // a source page happens to publish schema.org interactionStatistic
          // data, which is rare). null means "unknown," never "zero."
          source_likes_count?: number | null;
          source_views_count?: number | null;
          source_comments_count?: number | null;
          // Permanent availability state (see supabase/schema.sql) —
          // optional since not every query selects it (Discover/Feed/Match
          // filter status='active' server-side instead of reading this
          // per-row; Likes/Cart/listing-detail select it to render a
          // "Sold" state). Only ever written by service-role clients.
          status?: ListingStatus;
          // Populated only when status is 'flagged' (see
          // src/lib/inventory/listing-flagging.ts) — a comma-joined list
          // of every reason flagListing() found, null otherwise.
          flag_reason?: string | null;
          last_checked_at?: string | null;
          // P0 launch-readiness dead-listing cleanup — see
          // check-listing-status/route.ts and that migration's own comment.
          last_available_at?: string | null;
          availability_check_count?: number;
          consecutive_unavailable_checks?: number;
          removal_reason?: string | null;
          // AI quality score (src/lib/listing-quality.ts), 0-100 — computed
          // for every scraped listing before insert. Optional/nullable:
          // not every query selects it, and a row from before this feature
          // existed genuinely has no score at all (null, not 0).
          quality_score?: number | null;
          quality_reason?: string | null;
          quality_breakdown?: QualityScoreBreakdown | null;
          // Owner of a user-submitted listing (see src/app/actions/listings.ts)
          // — null for every scraped listing, which has no owner. Optional
          // since not every existing query selects it (Discover/Feed/Match
          // don't need it unless rendering the owner-only edit/delete menu).
          user_id?: string | null;
          // Style-Aware Admin Scraper's own archetype match (see
          // src/lib/admin-scraper-filter.ts) — deliberately separate from
          // aesthetic_tags, which stays populated by the real AI
          // classification pipeline. Only rows imported through that
          // scraper have these set; null for everything else.
          style_score?: number | null;
          matched_style?: string | null;
          // Image-based outfit-potential scoring (src/lib/image-score.ts)
          // — same "this scraper's own signal" reasoning as style_score/
          // matched_style above. image_score is the FINAL score after
          // tag/presentation adjustments, not the vision model's raw
          // output. Only rows imported through this scraper have these
          // set; null for everything else.
          image_score?: number | null;
          image_tags?: string[] | null;
          fit_type?: string | null;
          visual_aesthetic?: string[] | null;
          // Style-relevance ranking score (src/lib/listing-score.ts) —
          // the admin scraper's scoring-and-ranking architecture: rather
          // than rejecting low-scoring candidates, every one that clears
          // the minimal quality gate is imported with this attached, and
          // Discover orders by it (see discover-feed.ts). Null for a
          // listing imported before this feature existed, or by any path
          // that doesn't compute one — never a real 0.
          score?: number | null;
          // Admin-Only Listing Removal's non-destructive alternative
          // (src/lib/adminListingRemoval.ts's markListingLowQuality) —
          // the listing stays 'active', just deprioritized in Discover/
          // Feed ranking. Optional since not every query selects it.
          is_low_quality?: boolean;
          // Visual Similarity Search Foundation (src/lib/image-similarity.ts)
          // — both null for every row until a real embedding pipeline
          // exists (see supabase/schema.sql's own column comment); optional
          // since not every existing query selects them.
          image_embedding?: number[] | null;
          embedding_generated_at?: string | null;
          // Inventory Intelligence Layer (Parts 7-12) — see
          // supabase/schema.sql's own column comments for what each of
          // these is and why it's distinct from the older columns above.
          visual_analysis?: VisualListingAnalysis | null;
          visual_embedding?: number[] | null;
          image_hash?: string | null;
          inventory_quality_score?: number | null;
          last_verified_at?: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          title: string;
          description?: string | null;
          price?: number | null;
          image_url?: string | null;
          images?: string[];
          product_url?: string | null;
          platform?: string | null;
          brand?: string | null;
          category?: string | null;
          size?: string | null;
          color?: string | null;
          aesthetic_tags?: string[];
          shipping_cost?: number;
          source_likes_count?: number | null;
          source_views_count?: number | null;
          source_comments_count?: number | null;
          status?: ListingStatus;
          // Populated only when status is 'flagged' (see
          // src/lib/inventory/listing-flagging.ts) — a comma-joined list
          // of every reason flagListing() found, null otherwise.
          flag_reason?: string | null;
          last_checked_at?: string | null;
          // P0 launch-readiness dead-listing cleanup — see
          // check-listing-status/route.ts and that migration's own comment.
          last_available_at?: string | null;
          availability_check_count?: number;
          consecutive_unavailable_checks?: number;
          removal_reason?: string | null;
          quality_score?: number | null;
          quality_reason?: string | null;
          quality_breakdown?: QualityScoreBreakdown | null;
          user_id?: string | null;
          style_score?: number | null;
          matched_style?: string | null;
          image_score?: number | null;
          image_tags?: string[] | null;
          fit_type?: string | null;
          visual_aesthetic?: string[] | null;
          score?: number | null;
          is_low_quality?: boolean;
          image_embedding?: number[] | null;
          embedding_generated_at?: string | null;
          // Inventory Intelligence Layer (Parts 7-12) — see
          // supabase/schema.sql's own column comments for what each of
          // these is and why it's distinct from the older columns above.
          visual_analysis?: VisualListingAnalysis | null;
          visual_embedding?: number[] | null;
          image_hash?: string | null;
          inventory_quality_score?: number | null;
          last_verified_at?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          title?: string;
          description?: string | null;
          price?: number | null;
          image_url?: string | null;
          images?: string[];
          product_url?: string | null;
          platform?: string | null;
          brand?: string | null;
          category?: string | null;
          size?: string | null;
          color?: string | null;
          aesthetic_tags?: string[];
          shipping_cost?: number;
          source_likes_count?: number | null;
          source_views_count?: number | null;
          source_comments_count?: number | null;
          status?: ListingStatus;
          // Populated only when status is 'flagged' (see
          // src/lib/inventory/listing-flagging.ts) — a comma-joined list
          // of every reason flagListing() found, null otherwise.
          flag_reason?: string | null;
          last_checked_at?: string | null;
          // P0 launch-readiness dead-listing cleanup — see
          // check-listing-status/route.ts and that migration's own comment.
          last_available_at?: string | null;
          availability_check_count?: number;
          consecutive_unavailable_checks?: number;
          removal_reason?: string | null;
          quality_score?: number | null;
          quality_reason?: string | null;
          quality_breakdown?: QualityScoreBreakdown | null;
          user_id?: string | null;
          style_score?: number | null;
          matched_style?: string | null;
          image_score?: number | null;
          image_tags?: string[] | null;
          fit_type?: string | null;
          visual_aesthetic?: string[] | null;
          score?: number | null;
          is_low_quality?: boolean;
          image_embedding?: number[] | null;
          embedding_generated_at?: string | null;
          // Inventory Intelligence Layer (Parts 7-12) — see
          // supabase/schema.sql's own column comments for what each of
          // these is and why it's distinct from the older columns above.
          visual_analysis?: VisualListingAnalysis | null;
          visual_embedding?: number[] | null;
          image_hash?: string | null;
          inventory_quality_score?: number | null;
          last_verified_at?: string | null;
          created_at?: string;
        };
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: {
      // Part 10's pgvector KNN search (supabase/schema.sql) — takes the
      // plain JS number[] embedding directly; PostgREST casts it into
      // the function's `vector(1536)` parameter.
      match_listings_by_embedding: {
        Args: {
          query_embedding: number[];
          match_count?: number;
          filter_category?: string | null;
          max_price?: number | null;
        };
        Returns: { id: string; similarity: number }[];
      };
    };
  };
}

export type Listing = ListingsDatabase["public"]["Tables"]["listings"]["Row"];
export type ListingInsert =
  ListingsDatabase["public"]["Tables"]["listings"]["Insert"];
export type ListingUpdate =
  ListingsDatabase["public"]["Tables"]["listings"]["Update"];
