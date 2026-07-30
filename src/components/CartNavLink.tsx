"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCart } from "@/components/CartProvider";
import { isActivePath } from "@/lib/nav";

// tabRef: lets a parent nav (NavTabs) register this link's DOM node too, so
// it can measure Cart's position/width for the sliding active-tab
// underline — composed alongside cartLinkRef (used elsewhere for the
// fly-to-cart animation) via a merged callback ref, since a single element
// can only take one `ref` prop.
export function CartNavLink({
  tabRef,
}: {
  tabRef?: (el: HTMLAnchorElement | null) => void;
}) {
  const { cart, cartLinkRef } = useCart();
  const pathname = usePathname();
  const isActive = isActivePath(pathname, "/cart");
  const [bump, setBump] = useState(false);
  const bumpTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevCartLengthRef = useRef(cart.length);

  useEffect(() => {
    return () => {
      if (bumpTimeoutRef.current) clearTimeout(bumpTimeoutRef.current);
    };
  }, []);

  useEffect(() => {
    if (cart.length > prevCartLengthRef.current) {
      setBump(true);
      if (bumpTimeoutRef.current) clearTimeout(bumpTimeoutRef.current);
      bumpTimeoutRef.current = setTimeout(() => setBump(false), 200);
    }
    prevCartLengthRef.current = cart.length;
  }, [cart.length]);

  function setRefs(el: HTMLAnchorElement | null) {
    cartLinkRef.current = el;
    tabRef?.(el);
  }

  return (
    <Link
      href="/cart"
      ref={setRefs}
      className={`inline-flex items-center gap-1.5 rounded-pill px-3 py-1.5 text-sm font-medium transition-colors duration-200 ease-in-out hover:text-ink ${
        isActive ? "font-semibold text-ink" : "text-teal"
      }`}
    >
      Cart
      {cart.length > 0 && (
        <span
          className={`inline-flex h-4 min-w-4 items-center justify-center rounded-pill bg-oxblood px-1 text-[10px] font-semibold leading-none text-parchment transition-transform duration-200 ${
            bump ? "scale-110" : "scale-100"
          }`}
        >
          {cart.length}
        </span>
      )}
    </Link>
  );
}
