// Hand-written types for the `marketplace_listings` table
// (supabase/schema.sql) — same "scoped to one table, shaped like real
// codegen output" convention as src/lib/supabase/listings.types.ts.
export interface MarketplaceListingsDatabase {
  public: {
    Tables: {
      marketplace_listings: {
        Row: {
          id: string;
          source_platform: string;
          external_id: string;
          title: string;
          description: string | null;
          images: string[];
          price: number | null;
          category: string | null;
          brand: string | null;
          url: string;
          availability: "available" | "unavailable";
          searchable_text: string | null;
          detected_category: string | null;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          garment_attributes: Record<string, any> | null;
          image_embedding: number[] | null;
          embedding_generated_at: string | null;
          last_ingested_at: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          source_platform: string;
          external_id: string;
          title: string;
          description?: string | null;
          images?: string[];
          price?: number | null;
          category?: string | null;
          brand?: string | null;
          url: string;
          availability?: "available" | "unavailable";
          searchable_text?: string | null;
          detected_category?: string | null;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          garment_attributes?: Record<string, any> | null;
          image_embedding?: number[] | null;
          embedding_generated_at?: string | null;
          last_ingested_at?: string;
          created_at?: string;
        };
        Update: {
          id?: string;
          source_platform?: string;
          external_id?: string;
          title?: string;
          description?: string | null;
          images?: string[];
          price?: number | null;
          category?: string | null;
          brand?: string | null;
          url?: string;
          availability?: "available" | "unavailable";
          searchable_text?: string | null;
          detected_category?: string | null;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          garment_attributes?: Record<string, any> | null;
          image_embedding?: number[] | null;
          embedding_generated_at?: string | null;
          last_ingested_at?: string;
          created_at?: string;
        };
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
  };
}

export type MarketplaceListingRow =
  MarketplaceListingsDatabase["public"]["Tables"]["marketplace_listings"]["Row"];
export type MarketplaceListingInsert =
  MarketplaceListingsDatabase["public"]["Tables"]["marketplace_listings"]["Insert"];
export type MarketplaceListingUpdate =
  MarketplaceListingsDatabase["public"]["Tables"]["marketplace_listings"]["Update"];
