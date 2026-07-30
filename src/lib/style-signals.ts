// Fixed style archetypes the admin scraper (src/lib/admin-scraper-filter.ts)
// scores candidates against — distinct from aesthetic_tags' own
// #Y2K/#Vintage/etc. vocabulary (src/lib/aesthetic-categories.ts), which
// stays populated by the real AI classification pipeline. These are an
// admin-facing curation signal, not a replacement for it.
export interface StyleSignal {
  required_any: string[];
  preferred_colors?: string[];
  preferred_items?: string[];
  brands?: string[];
}

export const STYLE_SIGNALS: Record<string, StyleSignal> = {
  boho_y2k: {
    required_any: ["lace", "chiffon", "flowy", "ruffle", "sheer", "low rise", "layered", "cropped"],
    preferred_colors: ["brown", "cream", "ivory", "olive", "dusty pink"],
    preferred_items: ["maxi skirt", "mini skirt", "cami", "tank", "cardigan"],
    brands: ["free people", "urban outfitters"],
  },

  soft_feminine: {
    required_any: ["lace", "silk", "chiffon", "delicate", "fitted"],
    preferred_colors: ["pink", "white", "light blue"],
    preferred_items: ["blouse", "cami", "baby tee"],
    brands: ["hollister", "abercrombie", "aeropostale"],
  },

  y2k_casual: {
    required_any: ["low rise", "baby tee", "fitted", "ribbed"],
    preferred_items: ["jeans", "mini skirt", "tank"],
    brands: ["hollister", "abercrombie", "american eagle"],
  },
};
