import Link from "next/link";
import Image from "next/image";
import { Globe, Heart, ShoppingBag, Shirt, X } from "lucide-react";
import { LinkButton } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { AESTHETIC_CATEGORIES } from "@/lib/aesthetic-categories";

// Copy deliberately makes no mention of messaging/chatting/negotiating
// with sellers — Lockette buys the item on the shopper's behalf rather than
// connecting them directly with whoever listed it, so "chat with sellers"
// (an earlier version of this copy) described a flow the product doesn't
// actually have.
const STEPS = [
  { icon: Globe, text: "Browse curated pieces from across the internet" },
  { icon: Heart, text: "Save or pick what you love" },
  { icon: ShoppingBag, text: "We handle the buying for you" },
];

// `meta` is size/context only — price is its own field (rendered
// separately, right after meta) specifically so a card can opt out of
// showing it via `hidePrice` without needing to string-parse/strip a
// price back out of a combined line. `price: null` (not an empty string)
// means "no price to show at all," distinct from `hidePrice: true` (a
// real price exists but this specific card shouldn't display it) — the
// featured Depop card below sets both, but a future listing could have a
// real price and still set hidePrice on its own.
const PREVIEW_CARDS = [
  {
    title: "Hollister Longline Ruffle Icon Tunic",
    meta: "Size S · Hollister · Depop Find",
    // Real price from the listing's own JSON-LD ($35.00) — kept here, not
    // null, so the data is accurate to the source; hidePrice is what
    // actually suppresses it on this card (per this task's own
    // requirement), not the absence of a real value.
    price: "$35" as string | null,
    // This is a real, specific Depop listing (not one of this file's
    // other illustrative mock cards) — https://www.depop.com/products/
    // skandillo6s-hollister-longline-ruffle-icon-tunic-e0aa/ — featured
    // first in the swiper by request, with its price intentionally
    // hidden on this card.
    hidePrice: true,
    tags: ["Coquette", "New In"],
    art: false,
    // Depop blocks the product PAGE itself against every automated fetch
    // method available here (plain curl, WebFetch, and this project's own
    // admin scraper all get a 403 — confirmed directly) but NOT its image
    // CDN (media-photos.depop.com) — a direct curl against the listing's
    // own og:image URL succeeded (200, real JPEG). Downloaded once and
    // stored locally rather than hotlinked, same "real photo, storage-
    // stable copy" convention as teal-statement-top.jpg below — this file
    // is a byte-for-byte copy of that CDN image, not a re-creation.
    image: "/homepage/hollister-longline-ruffle-tunic.jpg",
  },
  {
    title: "Pink Archive Holster Top",
    meta: "Size S · Archive Resale",
    price: "$220" as string | null,
    hidePrice: false,
    tags: ["Y2K", "Coquette", "Archive", "Statement Piece", "Designer"],
    art: true,
    image: undefined as string | undefined,
  },
  {
    title: "Vintage Teal Statement Top",
    meta: "Size S · Going-Out Resale",
    price: "$185" as string | null,
    hidePrice: false,
    tags: ["Y2K", "Coquette", "Going Out", "Archive", "Trending"],
    art: false,
    // Real product-style photo (not an icon/illustration) — a genuine
    // teal lace-trim corset top, cropped tight on the garment. Served
    // from /public rather than hotlinked: every marketplace source we
    // tried (Depop, Pinterest, Unsplash search, Pexels search pages) 403s
    // or blocks scripted fetches, so a local, storage-stable copy is the
    // only way this card's image doesn't eventually rot into a broken
    // link. Source: a CC0 Pexels photo (pexels-photo-19906623), cropped
    // to isolate the top and re-hosted here under Pexels' license terms.
    image: "/homepage/teal-statement-top.jpg",
  },
  {
    title: "Satin Slip Dress",
    meta: "Size 6 · 90s Era",
    price: "$34" as string | null,
    hidePrice: false,
    tags: ["Vintage", "Evening"],
    art: false,
    image: undefined as string | undefined,
  },
];

// Product-listing-style illustration for the "Pink Archive Holster Top"
// preview card — inline SVG rather than a hotlinked photo so the homepage
// never depends on an external image host actually having (or continuing
// to host) a matching product shot. Rendered edge-to-edge inside the
// card's existing image slot, like a real resale listing's cover photo.
function HolsterTopArt() {
  return (
    <svg
      viewBox="0 0 240 200"
      preserveAspectRatio="xMidYMid slice"
      className="h-full w-full"
      role="img"
      aria-label="Pink Archive Holster Top, centered on a blush studio backdrop"
    >
      <defs>
        <linearGradient id="holster-backdrop" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#fff6fa" />
          <stop offset="100%" stopColor="#f7e4ec" />
        </linearGradient>
        <linearGradient id="holster-fabric" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#e7b8c8" />
          <stop offset="100%" stopColor="#8b3a5e" />
        </linearGradient>
        <radialGradient id="holster-hardware" cx="35%" cy="35%" r="75%">
          <stop offset="0%" stopColor="#e8caa0" />
          <stop offset="100%" stopColor="#a9803e" />
        </radialGradient>
      </defs>

      <rect width="240" height="200" fill="url(#holster-backdrop)" />
      <ellipse cx="120" cy="176" rx="66" ry="9" fill="rgba(15,42,31,0.08)" />

      {/* Fitted bandeau bodice */}
      <path
        d="M90,68 C90,52 150,52 150,68 L146,112 C146,124 94,124 94,112 Z"
        fill="url(#holster-fabric)"
      />

      {/* Halter neck ties */}
      <path
        d="M100,68 L118,20"
        stroke="#73304c"
        strokeWidth="3"
        strokeLinecap="round"
        fill="none"
      />
      <path
        d="M140,68 L122,20"
        stroke="#73304c"
        strokeWidth="3"
        strokeLinecap="round"
        fill="none"
      />
      <circle cx="120" cy="18" r="4" fill="url(#holster-hardware)" />

      {/* Crisscross holster straps */}
      <path
        d="M84,54 L156,128"
        stroke="#73304c"
        strokeWidth="10"
        strokeLinecap="round"
        opacity="0.95"
      />
      <path
        d="M156,54 L84,128"
        stroke="#73304c"
        strokeWidth="10"
        strokeLinecap="round"
        opacity="0.95"
      />
      <circle cx="120" cy="91" r="8" fill="url(#holster-hardware)" />
      <circle cx="120" cy="91" r="3.2" fill="#fff6fa" />

      {/* Shoulder hardware */}
      <rect x="93" y="65" width="11" height="6" rx="2" fill="url(#holster-hardware)" />
      <rect x="136" y="65" width="11" height="6" rx="2" fill="url(#holster-hardware)" />

      {/* Hanging archive tag */}
      <path d="M142,98 L152,108" stroke="#8b3a5e" strokeWidth="1.5" fill="none" />
      <rect
        x="140"
        y="106"
        width="44"
        height="16"
        rx="3"
        fill="#fff6fa"
        stroke="#8b3a5e"
        strokeWidth="1.2"
      />
      <text
        x="162"
        y="116.5"
        textAnchor="middle"
        fontSize="6"
        letterSpacing="0.2"
        fill="#73304c"
        fontFamily="var(--font-display), serif"
      >
        ARCHIVE
      </text>
    </svg>
  );
}

export default function Home() {
  return (
    <>
      <section className="px-6 pb-12 pt-16 sm:pt-20">
        <div className="mx-auto grid max-w-6xl items-center gap-10 lg:grid-cols-[1.1fr_0.9fr]">
          <div>
            <Badge className="mb-6">Secondhand, made for you</Badge>
            <h1 className="font-display text-4xl leading-[1.05] font-medium tracking-tight text-ink sm:text-6xl">
              Swipe your way to a wardrobe that&apos;s actually{" "}
              <span className="italic text-oxblood">yours.</span>
            </h1>
            <p className="mt-7 max-w-lg text-lg text-ink-soft">
              Lockette learns your style, then surfaces one-of-a-kind
              secondhand finds worth swiping right on — no more endless
              scrolling through the wrong sizes and wrong vibes.
            </p>
            <div className="mt-12 flex flex-wrap items-center gap-4">
              <LinkButton href="/signup" className="px-7 py-3.5 text-base">
                Start matching
              </LinkButton>
              <LinkButton
                href="#how-it-works"
                variant="ghost"
                className="px-7 py-3.5 text-base"
              >
                See how it works
              </LinkButton>
            </div>
          </div>

          <div className="relative mx-auto h-[420px] w-full max-w-sm">
            {PREVIEW_CARDS.map((card, index) => (
              <div
                key={card.title}
                className="absolute inset-x-0 mx-auto w-full max-w-xs rounded-card border border-border bg-surface p-6 shadow-card"
                style={{
                  top: `${index * 22}px`,
                  transform: `rotate(${(index - 1) * 4}deg) scale(${1 - index * 0.04})`,
                  zIndex: PREVIEW_CARDS.length - index,
                }}
              >
                <div
                  className={`relative flex h-44 items-center justify-center rounded-2xl bg-teal/10 ${
                    card.art || card.image ? "overflow-hidden" : ""
                  }`}
                >
                  {card.image ? (
                    <Image
                      src={card.image}
                      alt={card.title}
                      fill
                      className="object-cover"
                      sizes="(min-width: 640px) 320px, 90vw"
                    />
                  ) : card.art ? (
                    <HolsterTopArt />
                  ) : (
                    <Shirt className="h-12 w-12 text-teal" strokeWidth={1.25} />
                  )}
                </div>
                <p className="mt-5 font-display text-lg font-semibold text-ink">
                  {card.title}
                </p>
                <p className="mt-1 text-sm text-ink-soft">
                  {card.meta}
                  {card.price && !card.hidePrice ? ` · ${card.price}` : ""}
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {card.tags.map((tag, tagIndex) => (
                    <Badge
                      key={tag}
                      variant={tagIndex === 0 ? "teal" : "pink"}
                    >
                      {tag}
                    </Badge>
                  ))}
                </div>
              </div>
            ))}

            <div className="absolute -bottom-6 left-1/2 flex -translate-x-1/2 gap-4">
              <span className="flex h-12 w-12 items-center justify-center rounded-full border border-border bg-white shadow-soft">
                <X className="h-5 w-5 text-ink-soft" />
              </span>
              <span className="flex h-12 w-12 items-center justify-center rounded-full bg-oxblood shadow-soft">
                <Heart className="h-5 w-5 text-white" />
              </span>
            </div>
          </div>
        </div>
      </section>

      <section id="shop-by-vibe" className="px-6 pt-6 pb-12">
        <div className="mx-auto max-w-6xl">
          <div className="mb-12 flex flex-col gap-2 text-center">
            <span className="font-display text-sm uppercase tracking-[0.2em] text-oxblood">
              Curated categories
            </span>
            <h2 className="font-display text-3xl font-semibold text-ink sm:text-4xl">
              Shop by vibe
            </h2>
          </div>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
            {AESTHETIC_CATEGORIES.map((category) => {
              // Pinterest/eBay/Poshmark/Depop page URLs aren't in (and
              // shouldn't be added to) next.config.ts's remotePatterns
              // allowlist — next/image would hard-error on an
              // unconfigured hostname. Routing those through a plain
              // <img> instead means an unresolvable one degrades to a
              // broken-image icon on just that card rather than crashing
              // the whole section. Note the Vintage card's resolved
              // media-photos.depop.com URL (aesthetic-categories.ts) also
              // matches this "depop.com" check (it's a substring of that
              // hostname too) and so renders via this same plain-<img>
              // path rather than next/image — that's fine, the image
              // itself is real and loads either way.
              const isExternalPage =
                category.image_url.includes("pinterest.com") ||
                category.image_url.includes("ebay.com") ||
                category.image_url.includes("poshmark.com") ||
                category.image_url.includes("depop.com");

              return (
                <Link
                  key={category.slug}
                  href={`/discover?style=${category.slug}`}
                  className="group relative aspect-square overflow-hidden rounded-xl shadow-soft transition-all duration-200 ease-in-out hover:-translate-y-0.5 hover:shadow-card active:scale-[0.98]"
                >
                  {isExternalPage ? (
                    // eslint-disable-next-line @next/next/no-img-element -- raw platform page URL, not resolvable through next/image's remote-pattern allowlist
                    <img
                      src={category.image_url}
                      alt={category.label}
                      className="h-full w-full object-cover transition-transform duration-300 ease-in-out group-hover:scale-105"
                    />
                  ) : (
                    <Image
                      src={category.image_url}
                      alt={category.label}
                      fill
                      className="object-cover transition-transform duration-300 ease-in-out group-hover:scale-105"
                      sizes="(min-width: 640px) 30vw, 45vw"
                    />
                  )}
                  <div className="absolute inset-0 bg-darkgreen/30" />
                  <span className="absolute inset-x-0 bottom-0 p-4 font-display text-lg font-bold leading-snug text-white">
                    {category.label}
                  </span>
                </Link>
              );
            })}
          </div>
        </div>
      </section>

      <section id="how-it-works" className="px-6 pt-6 pb-10">
        <div className="mx-auto max-w-5xl">
          <div className="mb-16 text-center">
            <h2 className="font-display text-3xl font-semibold text-ink sm:text-4xl">
              How it works
            </h2>
          </div>

          <div className="grid gap-6 sm:grid-cols-3">
            {STEPS.map(({ icon: Icon, text }, index) => (
              <Card key={text} className="p-7">
                <span className="font-display text-sm text-gold">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <div className="mt-4 flex h-11 w-11 items-center justify-center rounded-full bg-teal/15">
                  <Icon className="h-5 w-5 text-teal" strokeWidth={1.5} />
                </div>
                <h3 className="mt-5 font-display text-xl font-semibold text-ink">
                  {text}
                </h3>
              </Card>
            ))}
          </div>

          <div className="mt-10 text-center">
            <a
              href="#shop-by-vibe"
              className="font-display text-sm font-semibold text-oxblood hover:underline"
            >
              Start exploring →
            </a>
          </div>
        </div>
      </section>

      <section className="px-6 pb-16">
        <div className="mx-auto max-w-4xl rounded-card bg-ink-strong px-8 py-10 text-center sm:px-16">
          <h2 className="font-display text-3xl font-semibold text-white sm:text-4xl">
            Your closet&apos;s next favorite piece is already thrifted.
          </h2>
          <p className="mx-auto mt-4 max-w-lg text-white/70">
            Build your style profile in minutes and start swiping through
            secondhand finds curated just for you.
          </p>
          <div className="mt-8">
            <LinkButton
              href="/signup"
              variant="accent-pink"
              className="px-7 py-3.5 text-base"
            >
              Create your profile
            </LinkButton>
          </div>
        </div>
      </section>
    </>
  );
}
