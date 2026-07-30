"use client";

import {
  createContext,
  useContext,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";

// Normalized shape both the mock catalog (ClothingItem) and real Supabase
// listings (Listing) can satisfy, so the cart doesn't need to know which
// source an item came from. ClothingItem already has every field here with
// compatible types, so existing call sites (e.g. MatchView's superlike)
// need no changes; adding a real Listing just means mapping title ->
// name / image_url -> image / price ?? 0 at the call site. platform/
// productUrl back the "Buy on {platform}" external link on /cart — a
// listing bought through Lockette is actually purchased on the original
// marketplace, not here.
export interface CartItem {
  id: string;
  name: string;
  image: string | null;
  price: number;
  brand?: string | null;
  platform?: string | null;
  productUrl?: string | null;
  // Marketplace-charged shipping (see the import route) — defaults to 0 at
  // every call site, same as price, so cart totals never need a null check.
  shippingCost?: number;
  // Permanent availability/moderation state (see supabase/schema.sql) —
  // only ever populated from a fresh server read (cart/page.tsx's
  // hydration), never set true optimistically at the moment of adding.
  // Undefined/"active" both mean "buyable"; anything else (including
  // "pending", which in practice should never reach a cart — only
  // 'active' listings are ever surfaced to add one) renders as
  // unavailable in CartView and is excluded from Buy All. "removed"
  // (Admin-Only Listing Removal) behaves the same as "rejected"/
  // "unavailable" here — an admin pulling a listing an item is already
  // in someone's cart for should make it just as unbuyable as any other
  // non-active status.
  status?: "active" | "sold" | "unavailable" | "pending" | "flagged" | "rejected" | "removed" | "expired";
}

type CartContextValue = {
  cart: CartItem[];
  addToCart: (item: CartItem) => void;
  removeFromCart: (index: number) => void;
  // Empties the local mirror after a successful "Buy All" checkout
  // (createOrder already deleted the persisted cart_items rows) — without
  // this, the in-memory cart would keep showing already-ordered items
  // until a full page refresh re-hydrates from the now-empty server state.
  clearCart: () => void;
  // Points at the Cart link rendered in the top nav, so features like the
  // Discover fly-to-cart animation know where to animate toward without
  // needing a direct parent/child relationship to that link.
  cartLinkRef: RefObject<HTMLAnchorElement | null>;
};

const CartContext = createContext<CartContextValue | null>(null);

// Client-side-only cart: holds superliked/added items so the top nav and
// /cart can share the same in-session state without a backend (the
// persisted source of truth is the cart_items table — see
// src/app/actions/cart.ts — this just mirrors it for instant UI feedback).
export function CartProvider({ children }: { children: ReactNode }) {
  const [cart, setCart] = useState<CartItem[]>([]);
  const cartLinkRef = useRef<HTMLAnchorElement>(null);

  function addToCart(item: CartItem) {
    setCart((prev) => [...prev, item]);
  }

  function removeFromCart(index: number) {
    setCart((prev) => prev.filter((_, i) => i !== index));
  }

  function clearCart() {
    setCart([]);
  }

  return (
    <CartContext.Provider
      value={{
        cart,
        addToCart,
        removeFromCart,
        clearCart,
        cartLinkRef,
      }}
    >
      {children}
    </CartContext.Provider>
  );
}

export function useCart(): CartContextValue {
  const context = useContext(CartContext);
  if (!context) {
    throw new Error("useCart must be used within a CartProvider");
  }
  return context;
}
