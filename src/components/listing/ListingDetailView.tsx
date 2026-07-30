"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ShoppingBag, Zap } from "lucide-react";
import { Badge, tagVariantForIndex } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { SaveButton } from "@/components/SaveButton";
import { ImageGallery } from "@/components/listing/ImageGallery";
import { SimilarListingsPanel } from "@/components/listing/SimilarListingsPanel";
import { StyleFeaturesPromo } from "@/components/StyleFeaturesPromo";
import { useCart } from "@/components/CartProvider";
import { addListingToCart } from "@/app/actions/cart";
import { calculateCartTotal } from "@/lib/pricing";
import { isExternallyHot } from "@/lib/hot-score";
import type { Listing } from "@/lib/supabase/listings.types";

// Strips common "sell more at once" seller phrases (bundle upsells, "3 for
// $x" pricing pitches) out of a listing's description before it's shown —
// display-only, never written back to the stored row: distinct from
// src/lib/extraction/clean-description.ts, which cleans raw scraped HTML
// into plain text at IMPORT time. Collapses the double-spaces a removed
// phrase can leave behind (e.g. "Great top! Message me for bundles! Ships
// fast" -> "Great top!  Ships fast" without this) — the extra whitespace
// collapse isn't in this feature's own worked example, but leaving it in
// would read as sloppier, not cleaner, which is the whole point here.
function cleanDescription(text: string | null): string {
  if (!text) return "";

  return text
    .replace(/bundle[s]? (available|only|deal)/gi, "")
    .replace(/message me for bundle[s]?/gi, "")
    .replace(/discount on bundle[s]?/gi, "")
    .replace(/3 for \$/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function ListingDetailView({
  listing,
  initialSaved,
  initialInCart = false,
  reservedByAnotherUser = false,
  isSold = false,
}: {
  listing: Listing;
  initialSaved: boolean;
  // True when this listing is already in the signed-in user's persisted
  // cart_items (see the listing detail page's server query) — read fresh
  // on every load/refresh, so "Add to Cart" correctly starts already
  // showing "In Cart" instead of forgetting a previous session's add.
  initialInCart?: boolean;
  // True when someone else's order currently has this listing on hold
  // (see src/lib/reservations.ts) — Buy Now/Add to Cart are hidden in
  // that case, since offering to buy/save an item mid-purchase-by-someone-
  // else contradicts the whole point of reserving it.
  reservedByAnotherUser?: boolean;
  // True once this listing's status (see supabase/schema.sql) is
  // permanently 'sold' or 'unavailable' — distinct from
  // reservedByAnotherUser's temporary hold: this never clears on its own.
  // Buy Now/Add to Cart are replaced with a "no longer available" card,
  // and the "Selling Fast" banner below is suppressed — showing "may sell
  // fast" on something that's already gone would read as a visible bug.
  isSold?: boolean;
}) {
  const router = useRouter();
  const { addToCart } = useCart();
  const [justAdded, setJustAdded] = useState(false);
  const [inCart, setInCart] = useState(initialInCart);

  // Defensive: images can be null/undefined/absent (older listings saved
  // before the images[] migration, or a query that fell back to the
  // legacy column list) — never assume it's a populated array.
  const images =
    Array.isArray(listing.images) && listing.images.length > 0
      ? listing.images
      : listing.image_url
        ? [listing.image_url]
        : [];

  const description = cleanDescription(listing.description);

  const shippingCost = listing.shipping_cost ?? 0;
  // Buy Now is just a one-item cart — reuse the same shared calculation
  // Cart/Checkout use (calculateCartTotal), rather than a separate
  // single-item fee path, so a $60 item bought here and the same $60 item
  // bought via Buy All always produce the same fee.
  const { subtotal: itemPrice, fee: serviceFee, total: subtotalWithFee } = calculateCartTotal([
    { price: listing.price ?? 0 },
  ]);
  const total = subtotalWithFee + shippingCost;

  function handleAddToCart() {
    addToCart({
      id: listing.id,
      name: listing.title,
      image: listing.image_url,
      price: listing.price ?? 0,
      brand: listing.brand,
      platform: listing.platform,
      productUrl: listing.product_url,
      shippingCost: listing.shipping_cost ?? 0,
    });
    // Fire-and-forget, same reasoning as Match's super-like: the optimistic
    // client-side cart above already gives instant feedback.
    addListingToCart(listing.id).catch(() => {});
    setJustAdded(true);
    setInCart(true);
    setTimeout(() => setJustAdded(false), 1500);
  }

  // Buy Now goes through the real order system (same one Cart's "Buy All"
  // uses) rather than opening the original marketplace listing — it sends
  // the shopper to /checkout for just this one item, independent of
  // whatever's already in the cart; the order itself isn't created until
  // checkout is submitted there.
  function handleBuyNow() {
    router.push(`/checkout?listingId=${listing.id}`);
  }

  return (
    <div className="min-h-[calc(100vh-137px)] px-6 pt-12 pb-16">
      <div className="mx-auto max-w-4xl">
        <div className="grid gap-8 sm:grid-cols-2">
          <ImageGallery
            images={images}
            alt={listing.title}
            overlay={
              <>
                <SaveButton
                  listingId={listing.id}
                  initialSaved={initialSaved}
                  className="absolute left-3 top-3 z-20"
                />

                {listing.platform && (
                  <span className="absolute bottom-3 right-3 z-20 rounded-pill bg-darkgreen/45 px-3 py-1.5 text-xs font-medium text-white">
                    {listing.platform}
                  </span>
                )}
              </>
            }
          />

          <div className="flex flex-col gap-4">
            <div>
              <h1 className="font-display text-2xl font-semibold text-ink sm:text-3xl">
                {listing.title}
              </h1>
              {listing.price != null && (
                <p className="mt-1 font-display text-xl font-semibold text-oxblood">
                  ${listing.price.toFixed(2)}
                </p>
              )}
            </div>

            {!isSold && isExternallyHot(listing) && (
              <div className="flex flex-col gap-2 rounded-card border border-oxblood/20 bg-oxblood/5 p-4">
                <span className="inline-flex w-fit items-center gap-1.5 rounded-pill bg-oxblood px-3 py-1 text-xs font-semibold text-white">
                  🔥 Selling Fast
                </span>
                <p className="text-sm text-ink-soft">
                  This item is getting a lot of attention and may sell on the
                  original site before we can secure it.
                </p>
              </div>
            )}

            {(listing.brand || listing.size) && (
              <p className="text-sm text-ink-soft">
                {[listing.brand, listing.size].filter(Boolean).join(" · ")}
              </p>
            )}

            {description && (
              <p className="text-sm whitespace-pre-line text-ink-soft">
                {description}
              </p>
            )}

            {listing.aesthetic_tags.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {listing.aesthetic_tags.map((tag, index) => (
                  <Badge key={tag} variant={tagVariantForIndex(index)}>
                    {tag}
                  </Badge>
                ))}
              </div>
            )}

            {listing.price != null && (
              <div className="flex flex-col gap-1.5 rounded-card border border-border bg-inner/50 p-4 text-sm">
                <div className="flex items-center justify-between text-ink-soft">
                  <span>Item</span>
                  <span>${itemPrice.toFixed(2)}</span>
                </div>
                <div className="flex items-center justify-between text-ink-soft">
                  <span>Shipping</span>
                  <span>{shippingCost > 0 ? `$${shippingCost.toFixed(2)}` : "Free"}</span>
                </div>
                <div className="flex items-center justify-between text-ink-soft">
                  <span>Lockette fee</span>
                  <span>${serviceFee.toFixed(2)}</span>
                </div>
                <div className="mt-1 flex items-center justify-between border-t border-border/60 pt-2 font-display font-semibold text-ink">
                  <span>Total</span>
                  <span>${total.toFixed(2)}</span>
                </div>
              </div>
            )}

            {isSold ? (
              <div className="mt-2 rounded-card border border-border bg-inner/50 p-4 text-center text-sm text-ink-soft">
                <p className="font-medium text-ink">This item is no longer available</p>
                {listing.aesthetic_tags.length > 0 && (
                  <a
                    href="#find-similar"
                    className="mt-2 inline-block font-display text-sm font-semibold text-oxblood hover:underline"
                  >
                    Find similar items
                  </a>
                )}
              </div>
            ) : reservedByAnotherUser ? (
              <div className="mt-2 rounded-card border border-border bg-inner/50 p-4 text-center text-sm text-ink-soft">
                <p className="font-medium text-ink">Someone is securing this item right now</p>
                <p className="mt-1">Check back soon</p>
              </div>
            ) : (
              <div className="mt-2 flex flex-col gap-3 sm:flex-row">
                <Button
                  type="button"
                  variant="secondary"
                  onClick={handleAddToCart}
                  className="flex-1"
                >
                  <ShoppingBag className="h-4 w-4" strokeWidth={2} />
                  {justAdded ? "Added!" : inCart ? "In Cart" : "Add to Cart"}
                </Button>
                <Button
                  type="button"
                  variant="primary"
                  onClick={handleBuyNow}
                  className="flex-1"
                >
                  <Zap className="h-4 w-4" strokeWidth={2} />
                  Buy Now
                </Button>
              </div>
            )}
          </div>
        </div>

        <StyleFeaturesPromo className="mt-16" />

        {listing.aesthetic_tags.length > 0 && (
          <SimilarListingsPanel
            listingId={listing.id}
            aestheticTags={listing.aesthetic_tags}
            heroImage={images[0] ?? null}
            heroTitle={listing.title}
          />
        )}
      </div>
    </div>
  );
}
