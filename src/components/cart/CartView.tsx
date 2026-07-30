"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { ImageOff, ShoppingBag, X } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { Badge, type TagVariant } from "@/components/ui/Badge";
import { Button, LinkButton } from "@/components/ui/Button";
import { useCart } from "@/components/CartProvider";
import { removeListingFromCart } from "@/app/actions/cart";
import { calculateCartTotal } from "@/lib/pricing";
import type { Listing } from "@/lib/supabase/listings.types";

// shipping_cost deliberately excluded — /cart's query doesn't select it
// (see cart/page.tsx's comment: the column isn't on the live DB yet).
export type CartListing = Pick<
  Listing,
  "id" | "title" | "price" | "image_url" | "brand" | "platform" | "product_url" | "status"
>;

// Stable per-platform color, not a rotating cycle — the badge is meant to
// identify the marketplace at a glance, not just add visual variety.
function platformBadgeVariant(platform: string | null | undefined): TagVariant {
  if (platform === "Depop") return "teal";
  if (platform === "Vinted") return "pink";
  return "yellow";
}

export function CartView({ initialCartListings }: { initialCartListings: CartListing[] }) {
  const router = useRouter();
  const { cart, addToCart, removeFromCart } = useCart();

  // The cart itself (CartProvider) is client-only/in-memory, so it resets
  // on every refresh — this hydrates it from what's actually persisted in
  // cart_items whenever /cart loads, deduped against whatever's already in
  // `cart` this session (e.g. an item super-liked moments ago), so refresh
  // never drops previously super-liked/added items.
  useEffect(() => {
    const existingIds = new Set(cart.map((item) => item.id));
    for (const listing of initialCartListings) {
      if (existingIds.has(listing.id)) continue;
      addToCart({
        id: listing.id,
        name: listing.title,
        image: listing.image_url,
        price: listing.price ?? 0,
        brand: listing.brand,
        platform: listing.platform,
        productUrl: listing.product_url,
        status: listing.status,
        // shipping_cost isn't selected here (see CartListing above) —
        // omitted rather than passing a stale 0; CartItem.shippingCost is
        // optional and the reduce below already coalesces it.
      });
    }
    // Only re-run when the server-fetched snapshot itself changes — not on
    // every `cart`/`addToCart` change, which this effect's own calls cause.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialCartListings]);

  function handleRemove(index: number) {
    const item = cart[index];
    removeFromCart(index);
    if (item) {
      removeListingFromCart(item.id).catch(() => {});
    }
  }

  // The order itself isn't created here anymore — Buy All just hands off
  // to /checkout, which creates it (via createOrder) once the shopper
  // submits their shipping info there.
  function handleBuyAll() {
    router.push("/checkout");
  }

  // Sold/unavailable items stay visible in the list (with a "Sold" badge,
  // rendered below) but are excluded from the checkout-preview total — the
  // customer shouldn't see a price they can no longer pay. status is
  // undefined for items hydrated before this feature (or if the column
  // isn't on the live DB yet), which is treated the same as "active".
  const sellableCart = cart.filter((item) => !item.status || item.status === "active");

  const shipping = sellableCart.reduce((sum, item) => sum + (item.shippingCost ?? 0), 0);
  // Lockette's own fee, isolated in src/lib/pricing.ts — applied ONCE to the
  // cart's combined subtotal, not once per item (a $10 item and a $12 item
  // pay one $2 minimum fee on their $22 combined subtotal, not $2 each).
  const { subtotal: itemTotal, fee: serviceFee, total: subtotalWithFee } = calculateCartTotal(sellableCart);
  const total = subtotalWithFee + shipping;

  return (
    <div className="min-h-[calc(100vh-137px)] scroll-smooth px-6 pt-12">
      <div className="mx-auto max-w-3xl">
        <div className="mb-8 text-center">
          <span className="font-display text-sm tracking-[0.2em] text-oxblood uppercase">
            Cart
          </span>
          <h1 className="mt-2 font-display text-3xl font-semibold text-ink sm:text-4xl">
            Your superliked finds
          </h1>
          <p className="mt-2 text-sm text-ink-soft">
            Lockette helps you discover thrifted pieces — purchases happen
            with the original seller.
          </p>
        </div>

        {cart.length > 0 ? (
          <div className="flex flex-col gap-4">
            {cart.map((item, index) => {
              const isSold = Boolean(item.status) && item.status !== "active";

              return (
              <Card
                key={`${item.id}-${index}`}
                className={`flex gap-4 p-4 ${isSold ? "opacity-50 grayscale" : ""}`}
              >
                <div className="relative h-28 w-28 shrink-0 overflow-hidden rounded-card bg-inner sm:h-32 sm:w-32">
                  {item.image ? (
                    // eslint-disable-next-line @next/next/no-img-element -- arbitrary external marketplace domain, not known in advance
                    <img
                      src={item.image}
                      alt={item.name}
                      className="absolute inset-0 h-full w-full object-cover"
                    />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center">
                      <ImageOff className="h-8 w-8 text-muted" strokeWidth={1.5} />
                    </div>
                  )}
                </div>

                <div className="flex flex-1 flex-col gap-1.5">
                  <div className="flex items-start justify-between gap-2">
                    <h3 className="font-display text-sm font-semibold leading-tight text-ink sm:text-base">
                      {item.name}
                    </h3>
                    <button
                      type="button"
                      onClick={() => handleRemove(index)}
                      aria-label={`Remove ${item.name} from cart`}
                      className="flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-full text-ink-soft transition-colors hover:bg-inner hover:text-oxblood"
                    >
                      <X className="h-3.5 w-3.5" strokeWidth={2.5} />
                    </button>
                  </div>

                  {item.brand && <p className="text-xs text-ink-soft">{item.brand}</p>}

                  <div className="flex flex-wrap items-center gap-2">
                    {item.platform && (
                      <Badge variant={platformBadgeVariant(item.platform)} className="text-[11px]">
                        {item.platform}
                      </Badge>
                    )}
                    {isSold && (
                      <Badge variant="pink" className="text-[11px]">
                        Sold
                      </Badge>
                    )}
                    <span className="font-display text-sm font-semibold text-oxblood">
                      ${item.price.toFixed(2)}
                    </span>
                  </div>

                  <p className="text-xs text-ink-soft">
                    {item.shippingCost
                      ? `+ $${item.shippingCost.toFixed(2)} shipping`
                      : "Free shipping"}
                  </p>

                  <div className="mt-auto pt-2">
                    {isSold ? (
                      <p className="text-xs font-medium text-ink-soft">
                        No longer available
                      </p>
                    ) : item.productUrl ? (
                      <LinkButton
                        href={item.productUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        variant="primary"
                        className="w-full sm:w-auto"
                      >
                        Buy on {item.platform ?? "marketplace"}
                      </LinkButton>
                    ) : (
                      <p className="text-xs text-ink-soft/70">
                        Original listing link unavailable
                      </p>
                    )}
                  </div>
                </div>
              </Card>
              );
            })}

            <div className="mt-4 flex flex-col gap-2 border-t border-border/60 pt-6">
              {sellableCart.length < cart.length && sellableCart.length > 0 && (
                <p className="rounded-card bg-highlight-cream px-3 py-2 text-xs text-highlight-cream-ink">
                  Some items are no longer available — they won&apos;t be included when you check out.
                </p>
              )}

              <span className="font-display text-xs uppercase tracking-[0.15em] text-ink-soft">
                Checkout preview
              </span>
              <div className="flex items-center justify-between text-sm text-ink-soft">
                <span>Item</span>
                <span>${itemTotal.toFixed(2)}</span>
              </div>
              <div className="flex items-center justify-between text-sm text-ink-soft">
                <span>Shipping</span>
                <span>{shipping > 0 ? `$${shipping.toFixed(2)}` : "Free"}</span>
              </div>
              <div className="flex items-center justify-between text-sm text-ink-soft">
                <span>Lockette fee</span>
                <span>${serviceFee.toFixed(2)}</span>
              </div>
              <div className="mt-2 flex items-center justify-between border-t border-border/60 pt-3 font-display text-lg font-semibold text-ink">
                <span>Total</span>
                <span>${total.toFixed(2)}</span>
              </div>

              <Button
                type="button"
                onClick={handleBuyAll}
                disabled={sellableCart.length === 0}
                className="mt-3 w-full"
              >
                Buy All
              </Button>

              <p className="mt-1 text-xs text-ink-soft/70">
                {sellableCart.length === 0
                  ? "Everything in your cart is no longer available — remove sold items to keep shopping."
                  : "Buy All places a single Lockette order for everything in your cart. You can still buy an item directly with its original seller via its own Buy button above."}
              </p>
            </div>
          </div>
        ) : (
          <div className="mx-auto flex max-w-md flex-col items-center gap-4 rounded-card bg-highlight-cream px-8 py-16 text-center">
            <ShoppingBag className="h-8 w-8 text-oxblood" strokeWidth={1.5} />
            <p className="text-sm text-ink-soft">No items in your cart yet</p>
            <p className="-mt-2 text-sm text-ink-soft">
              Double tap items to save them here 💖
            </p>
            <LinkButton href="/match">Go to Match</LinkButton>
          </div>
        )}
      </div>
    </div>
  );
}
