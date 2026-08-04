export interface AestheticOption {
  id: string;
  name: string;
  description: string;
  image: string;
}

export const AESTHETICS: AestheticOption[] = [
  {
    id: "Vintage Americana",
    name: "Vintage Americana",
    description: "Denim, flannel, and heirloom pieces with all-American nostalgia.",
    image: "https://loremflickr.com/600/800/vintage,americana/all?lock=1",
  },
  {
    id: "Old Money",
    name: "Old Money",
    description: "Quiet luxury — tailored tweed, cashmere, and equestrian polish.",
    image: "https://loremflickr.com/600/800/tweed,blazer/all?lock=3",
  },
  {
    id: "Y2K",
    name: "Y2K",
    description: "Low-rise, rhinestones, and early-2000s maximalism.",
    image: "https://loremflickr.com/600/800/tinted,sunglasses/all?lock=1",
  },
  {
    id: "Indie Sleaze",
    name: "Indie Sleaze",
    description: "Flash-lit, grungy, and unapologetically messy glamour.",
    image: "https://loremflickr.com/600/800/flash,party/all?lock=1",
  },
  {
    id: "Dark Academia",
    name: "Dark Academia",
    description: "Tweed blazers, oxford shoes, and a well-worn paperback.",
    image: "https://loremflickr.com/600/800/old,books/all?lock=1",
  },
  {
    id: "Cottagecore",
    name: "Cottagecore",
    description: "Puff sleeves, florals, and a life lived slower.",
    image: "https://loremflickr.com/600/800/cottage,garden/all?lock=1",
  },
  {
    id: "Streetwear",
    name: "Streetwear",
    description: "Oversized fits, sneakers, and logo-forward layering.",
    image: "https://loremflickr.com/600/800/streetwear,style/all?lock=1",
  },
  {
    id: "Minimalist",
    name: "Minimalist",
    description: "Clean lines, neutral tones, and considered basics.",
    image: "https://loremflickr.com/600/800/minimalist,fashion/all?lock=1",
  },
  {
    id: "Balletcore",
    name: "Balletcore",
    description: "Wrap tops, tulle, and soft, dancer-inspired silhouettes.",
    image: "https://loremflickr.com/600/800/ballet,studio/all?lock=1",
  },
  {
    id: "Coastal",
    name: "Coastal",
    description: "Linen, salt-air texture, and effortless seaside ease.",
    image: "https://loremflickr.com/600/800/coastal,style/all?lock=1",
  },
];

export interface BrandOption {
  id: string;
  name: string;
  color: string;
}

// P0 first-60-seconds fix (item 9) — "user must choose at least five
// brands." Shared (not defined in StepBrands.tsx, a "use client"
// component) so the real server-side enforcement in
// src/app/actions/onboarding.ts's saveOnboarding can import the exact
// same number without reaching into a client component's own module.
export const MIN_BRANDS_REQUIRED = 5;

// P0 first-60-seconds fix (item 9) — expanded from 8 to a real,
// alphabetically-sorted spread (~70) of brands actually recognizable to a
// secondhand-fashion shopper, spanning premium/"old money" (Ralph Lauren,
// Burberry), contemporary (Free People, Reformation), streetwear
// (Supreme, Stussy), denim/heritage (Levi's, Carhartt), fast-fashion
// (Zara, H&M — genuinely common in real thrifted inventory even though
// not "premium"), and outdoor/athletic (Patagonia, Nike, Lululemon) —
// matching the actual range of brands this app's own scraped inventory
// spans (see src/lib/listing-quality.ts's TOP_TIER_BRANDS/MID_TIER_BRANDS
// for the same real-world spread this list draws from), not just luxury.
// `color` is a simple accent used only as a small swatch/avatar behind
// each brand's initial in the new searchable chip UI (StepBrands.tsx) —
// no longer a full-tile background now that this is a dense list rather
// than a handful of large cards.
export const BRANDS: BrandOption[] = [
  { id: "Abercrombie & Fitch", name: "Abercrombie & Fitch", color: "#8a2be2" },
  { id: "Adidas", name: "Adidas", color: "#1c1c1c" },
  { id: "Aerie", name: "Aerie", color: "#e88ba0" },
  { id: "Aeropostale", name: "Aeropostale", color: "#1f4287" },
  { id: "Agolde", name: "Agolde", color: "#3d5a6c" },
  { id: "All Saints", name: "All Saints", color: "#161616" },
  { id: "American Eagle", name: "American Eagle", color: "#2e5aa8" },
  { id: "Anthropologie", name: "Anthropologie", color: "#5c3350" },
  { id: "Banana Republic", name: "Banana Republic", color: "#3a3a2f" },
  { id: "Brandy Melville", name: "Brandy Melville", color: "#c9a3c4" },
  { id: "Burberry", name: "Burberry", color: "#8a6a3d" },
  { id: "Calvin Klein", name: "Calvin Klein", color: "#111111" },
  { id: "Carhartt", name: "Carhartt", color: "#4a3423" },
  { id: "Champion", name: "Champion", color: "#8b1e2b" },
  { id: "Coach", name: "Coach", color: "#5a3a2e" },
  { id: "Columbia", name: "Columbia", color: "#274a5e" },
  { id: "Converse", name: "Converse", color: "#1a1a1a" },
  { id: "Diesel", name: "Diesel", color: "#2b2b2b" },
  { id: "Doc Martens", name: "Doc Martens", color: "#c2a02a" },
  { id: "Dolce & Gabbana", name: "Dolce & Gabbana", color: "#1a1a1a" },
  { id: "Everlane", name: "Everlane", color: "#8a8a7a" },
  { id: "Fila", name: "Fila", color: "#c0392b" },
  { id: "Forever 21", name: "Forever 21", color: "#e6b800" },
  { id: "Free People", name: "Free People", color: "#8a4a30" },
  { id: "Gap", name: "Gap", color: "#003b74" },
  { id: "Guess", name: "Guess", color: "#7a1f2b" },
  { id: "H&M", name: "H&M", color: "#c8102e" },
  { id: "Hollister", name: "Hollister", color: "#3f6f9e" },
  { id: "J.Crew", name: "J.Crew", color: "#2f4030" },
  { id: "Jordan", name: "Jordan", color: "#1a1a1a" },
  { id: "Kate Spade", name: "Kate Spade", color: "#2ea3a3" },
  { id: "Lacoste", name: "Lacoste", color: "#1c5c3c" },
  { id: "Levi's", name: "Levi's", color: "#1c3d63" },
  { id: "Lululemon", name: "Lululemon", color: "#7c2d5e" },
  { id: "Madewell", name: "Madewell", color: "#8c6a4a" },
  { id: "Michael Kors", name: "Michael Kors", color: "#5c2a2a" },
  { id: "New Balance", name: "New Balance", color: "#7a1f2b" },
  { id: "Nike", name: "Nike", color: "#181818" },
  { id: "North Face", name: "North Face", color: "#0b3d2e" },
  { id: "Old Navy", name: "Old Navy", color: "#003b6f" },
  { id: "Patagonia", name: "Patagonia", color: "#1f3d2c" },
  { id: "Polo Ralph Lauren", name: "Polo Ralph Lauren", color: "#101b33" },
  { id: "Prada", name: "Prada", color: "#1a1a1a" },
  { id: "Puma", name: "Puma", color: "#1a1a1a" },
  { id: "Ralph Lauren", name: "Ralph Lauren", color: "#101b33" },
  { id: "Reformation", name: "Reformation", color: "#7a3b3b" },
  { id: "Reebok", name: "Reebok", color: "#1a1a1a" },
  { id: "Sézane", name: "Sézane", color: "#c9a68a" },
  { id: "Skims", name: "Skims", color: "#c9a48a" },
  { id: "Stussy", name: "Stussy", color: "#1a1a1a" },
  { id: "Supreme", name: "Supreme", color: "#c8102e" },
  { id: "Tommy Hilfiger", name: "Tommy Hilfiger", color: "#1f2d5c" },
  { id: "Topshop", name: "Topshop", color: "#1a1a1a" },
  { id: "Toteme", name: "Toteme", color: "#8a8a7a" },
  { id: "True Religion", name: "True Religion", color: "#3d2b1f" },
  { id: "Under Armour", name: "Under Armour", color: "#1a1a1a" },
  { id: "Urban Outfitters", name: "Urban Outfitters", color: "#2b2b2b" },
  { id: "Vans", name: "Vans", color: "#1a1a1a" },
  { id: "Versace", name: "Versace", color: "#c9a800" },
  { id: "Victoria's Secret", name: "Victoria's Secret", color: "#b03a5b" },
  { id: "Vince", name: "Vince", color: "#4a4a4a" },
  { id: "Vineyard Vines", name: "Vineyard Vines", color: "#1f4a3d" },
  { id: "Vintage Levi's", name: "Vintage Levi's", color: "#2c4a6e" },
  { id: "Wrangler", name: "Wrangler", color: "#7a2b2b" },
  { id: "Zara", name: "Zara", color: "#1a1a1a" },
];

export const SIZE_OPTIONS = ["XS", "S", "M", "L", "XL", "XXL"];

export const BUDGET_OPTIONS: { label: string; value: number }[] = [
  { label: "Under $25", value: 25 },
  { label: "$25–$50", value: 50 },
  { label: "$50–$100", value: 100 },
  { label: "$100+", value: 250 },
];

export const CATEGORY_OPTIONS = [
  "Tops",
  "Dresses",
  "Denim",
  "Outerwear",
  "Knitwear",
  "Accessories",
  "Shoes",
  "Bags",
];

export const COLOR_OPTIONS: { name: string; hex: string }[] = [
  { name: "Black", hex: "#1a1a1a" },
  { name: "White", hex: "#ffffff" },
  { name: "Cream", hex: "#f0e6d2" },
  { name: "Blush", hex: "#e7cdc2" },
  { name: "Sage", hex: "#9caf88" },
  { name: "Navy", hex: "#1f2d4d" },
  { name: "Burgundy", hex: "#7d2e2a" },
  { name: "Camel", hex: "#c19a6b" },
  { name: "Denim Blue", hex: "#4a6fa5" },
  { name: "Lavender", hex: "#c9b6e4" },
];
