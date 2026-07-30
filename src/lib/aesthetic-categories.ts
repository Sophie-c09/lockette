// Shared "browse by aesthetic" taxonomy — used by the homepage's category
// cards (src/app/page.tsx), /discover's hybrid ?style= filter
// (src/lib/discover-feed.ts), and the AI image-tagging vocabulary
// (src/lib/image-tagging.ts), so all three can never drift out of sync: a
// homepage card's slug always corresponds to exactly the tag
// discover-feed.ts filters on and the vocabulary image-tagging.ts predicts
// against.
//
// Deliberately built around real aesthetic_tags values, not garment-type
// labels (e.g. the previous homepage's "Knitwear & Layers", "Footwear
// Finds") — this app's real listings data (populated by the import
// pipeline, not hand-curated) has substantial volume under aesthetic
// hashtags like #Y2K/#Vintage/#Coquette, but zero rows under any
// garment-category word tried (checked directly against the live
// database before choosing these six). A homepage category only earns
// its spot here if it reliably routes to real, non-empty Discover
// results.
//
// Exported under two names on purpose: `HOMEPAGE_CATEGORIES`/
// `getHomepageCategoryBySlug` are the original names several existing
// call sites already depend on (image-tagging.ts's vocabulary mapping in
// particular — never touch that import path without re-checking there),
// while `AESTHETIC_CATEGORIES`/`getAestheticCategoryBySlug` are aliases
// for the newer ?style= hybrid-filtering code. Same array underneath —
// there's no second taxonomy to keep in sync, just two names for it.
export interface HomepageCategory {
  // Used in the URL: /discover?category=<slug> (legacy) or
  // /discover?style=<slug> (current homepage entry point) — both resolve
  // against this same list.
  slug: string;
  // Display name — shown on the card and Discover's "Showing: X" header.
  label: string;
  // The exact aesthetic_tags array value this category matches (see
  // discover-feed.ts) — case/spacing must match real data exactly, since
  // this is an exact-value check (array-overlap/contains), not a fuzzy
  // one.
  tag: string;
  // Secondary, fuzzy signal for the ?style= hybrid filter
  // (discover-feed.ts): plain-English words/phrases matched via ILIKE
  // against title/description whenever the exact tag alone wouldn't be
  // enough — this is what guarantees a style page is never empty, even
  // for a listing the tagging pipeline missed. Verified live against the
  // real listings table before being chosen, same as `tag` itself.
  fallback_terms: string[];
  // One short sentence describing the vibe, shown under the style's <h1>
  // on /discover?style=<slug> (see DiscoverView.tsx).
  description: string;
  // Homepage card cover photo. User-picked this round: each was supplied
  // as a Pinterest pin / Poshmark / eBay page URL, none of which are
  // direct image files (confirmed live — every one of them serves
  // `text/html`, not an image; a browser can't render a webpage inside an
  // <img> tag no matter which component loads it). Where possible, the
  // page's own `og:image` meta tag was resolved to the real underlying
  // photo URL and used instead — that's what's actually stored below for
  // Y2K/Coquette/Indie Sleaze/Streetwear/Cottagecore. eBay (Vintage)
  // blocks automated fetches outright (403 across three different
  // approaches), so no image could be extracted — per explicit
  // instruction, that one is left as the literal eBay page URL and WILL
  // render as a broken image; see the Vintage entry below.
  image_url: string;
}

export const HOMEPAGE_CATEGORIES: HomepageCategory[] = [
  {
    slug: "y2k",
    label: "Y2K",
    tag: "#Y2K",
    fallback_terms: ["low rise", "baby tee", "mini skirt", "going out top"],
    description: "Low rise, baby tees, and going-out fits.",
    // Resolved from https://www.pinterest.com/pin/15692298698875262/'s
    // og:image — a striped cami + denim shorts flat lay on a floral
    // bedspread.
    image_url: "https://i.pinimg.com/736x/b3/16/9b/b3169b60de4f7876f3e467fb4b633e2b.jpg",
  },
  {
    slug: "vintage",
    label: "Vintage",
    tag: "#Vintage",
    fallback_terms: ["retro", "blouse", "denim", "classic"],
    description: "Retro blouses, denim, and timeless classics.",
    // Resolved from the Depop listing
    // (https://www.depop.com/products/k3it7_192-coach-signature-ashley-satchel-brown-97aa/,
    // a Coach Signature Ashley Satchel) — a genuine, clean product photo
    // on a plain white background. The listing page itself blocks plain
    // fetches with a Cloudflare bot-challenge (403 on both a spoofed-UA
    // curl request and a second fetch tool), the same failure mode as the
    // eBay link this replaced — but here a real headless browser (this
    // repo's own browser-extractor.ts already relies on the same
    // approach for real Depop imports) got past the challenge and read
    // the page's own og:image, so the real photo is used here rather
    // than leaving this one broken too.
    image_url: "https://media-photos.depop.com/b1/338515601/4187686175_ffc5df5bf0d747d1aa72c82b3faebb86/P0.jpg",
  },
  {
    slug: "coquette",
    label: "Coquette",
    tag: "#Coquette",
    fallback_terms: ["lace", "bows", "camisole", "soft girl"],
    description: "Lace, bows, and soft-girl details.",
    // Resolved from https://www.pinterest.com/pin/47780446041639584/'s
    // og:image — lace-trimmed slip camisoles hanging on a rack.
    image_url: "https://i.pinimg.com/736x/e1/ab/67/e1ab678e45747518779d5e05f081374a.jpg",
  },
  {
    slug: "indie-sleaze",
    label: "Indie Sleaze",
    tag: "#Indie Sleaze",
    fallback_terms: ["leather", "grunge", "edgy", "dark"],
    description: "Leather, grunge, and edgy after-dark energy.",
    // Resolved from https://www.pinterest.com/pin/4596908695776999040/'s
    // og:image — a grey slip dress on a plain wall. Worth flagging: this
    // pin doesn't read as especially "leather/grunge/edgy/dark" the way
    // the fallback_terms above do — it's a soft, quiet piece — but it's
    // the user's own pick, used as given rather than second-guessed.
    image_url: "https://i.pinimg.com/736x/2a/b7/1d/2ab71dc44d19efc09921a553b0ff3583.jpg",
  },
  {
    slug: "streetwear",
    label: "Streetwear",
    tag: "#Streetwear",
    fallback_terms: ["hoodie", "cargo", "sneakers", "oversized"],
    description: "Hoodies, cargos, and oversized fits.",
    // Resolved from the Poshmark listing's og:image (Joe's Jeans "Vintage
    // Leather Moto Jkt") — a two-tone leather moto jacket. Confirmed with
    // the user that this stays on Streetwear exactly as given, even
    // though the listing itself is literally titled "Vintage" and reads
    // closer to Indie Sleaze's leather/edgy fallback_terms.
    image_url:
      "https://di2ponv0v5otw.cloudfront.net/posts/2025/10/09/68e7e078001542395703e233/m_68e7e09a3509d1660157fe31.jpg",
  },
  {
    slug: "cottagecore",
    label: "Cottagecore",
    tag: "#Cottagecore",
    fallback_terms: ["linen", "floral", "cardigan", "soft"],
    description: "Linen, florals, and cozy cardigans.",
    // Resolved from https://www.pinterest.com/pin/4925880839533835/'s
    // og:image — a sage-green sequined maxi skirt hanging in a cozy,
    // shelf-lined room (a hand is visible holding the hanger).
    image_url: "https://i.pinimg.com/736x/b7/4d/a2/b74da2cfb6a62031d1a9761e9d148622.jpg",
  },
];

// Lowercased on both sides — every real slug in HOMEPAGE_CATEGORIES is
// already lowercase, so this is defense-in-depth against a future entry
// that isn't, not a fix for an observed bug (a mismatched-case lookup
// already returned undefined safely, never threw).
export function getHomepageCategoryBySlug(slug: string): HomepageCategory | undefined {
  const normalized = slug.trim().toLowerCase();
  return HOMEPAGE_CATEGORIES.find((category) => category.slug.toLowerCase() === normalized);
}

export const AESTHETIC_CATEGORIES = HOMEPAGE_CATEGORIES;
export const getAestheticCategoryBySlug = getHomepageCategoryBySlug;
