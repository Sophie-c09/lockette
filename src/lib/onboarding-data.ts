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

export const BRANDS: BrandOption[] = [
  { id: "Ralph Lauren", name: "Ralph Lauren", color: "#101b33" },
  { id: "Levi's", name: "Levi's", color: "#1c3d63" },
  { id: "Free People", name: "Free People", color: "#8a4a30" },
  { id: "Anthropologie", name: "Anthropologie", color: "#5c3350" },
  { id: "Patagonia", name: "Patagonia", color: "#1f3d2c" },
  { id: "Nike", name: "Nike", color: "#181818" },
  { id: "Urban Outfitters", name: "Urban Outfitters", color: "#2b2b2b" },
  { id: "Carhartt", name: "Carhartt", color: "#4a3423" },
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
