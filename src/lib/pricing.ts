// Lockette's own service fee, kept isolated here so a future pricing
// change (new tier, new rate, new cap) only ever happens in this one place
// — nothing else in the app should hardcode a fee percentage or amount.
//
// Tiered by item price, deliberately lower than typical marketplace fees
// since Lockette is a discovery layer, not the seller (see
// src/app/actions/cart.ts / the Cart "Buy on {platform}" flow) — cheap
// thrift finds shouldn't be taxed at the same rate as expensive ones. Each
// tier's upper bound is inclusive; the next tier starts strictly above it.
export function calculateServiceFee(price: number): number {
  // Defensive: callers are expected to already pass a real number (see
  // ListingDetailView/CartView, both of which coalesce listing.price ??
  // 0 before calling this), but this function never trusts that on its
  // own — an undefined/null/NaN price falls back to 0 rather than
  // producing a NaN fee.
  const safePrice = typeof price === "number" && Number.isFinite(price) ? price : 0;
  let fee: number;

  if (safePrice <= 25) {
    // $0-$25: flat minimum fee, not a percentage — a rate here would be
    // pocket change on top of an already-cheap item.
    fee = 2;
  } else if (safePrice <= 100) {
    // $25-$100: 5%, but never more than $5 — this is what keeps the
    // "never exceed $5 under $100" requirement true at every price in
    // this tier, not just at its edges.
    fee = Math.min(safePrice * 0.05, 5);
  } else if (safePrice <= 250) {
    fee = safePrice * 0.04;
  } else if (safePrice <= 500) {
    fee = safePrice * 0.03;
  } else {
    fee = safePrice * 0.02;
  }

  return Math.round(fee * 100) / 100;
}

export interface CartTotal {
  subtotal: number;
  fee: number;
  total: number;
}

/**
 * The single source of truth for "what does this cart cost" — subtotal is
 * the sum of every item's price, and the service fee is calculated ONCE
 * against that combined subtotal (fee = f(subtotal)), never per item and
 * summed (sum of f(item)) the way Cart/Checkout/listing detail used to
 * each compute it independently. That per-item approach overcharged small
 * multi-item carts — e.g. two $11 items paid the $2 minimum fee twice
 * ($4 total) instead of once against their $22 combined subtotal.
 *
 * A single-item "cart" (Buy Now — see ListingDetailView.tsx) is just the
 * degenerate one-element case of the same function, per this function's
 * own contract — there's no separate single-item fee path anymore.
 *
 * Deliberately does not include shipping: shipping isn't a fee, and every
 * caller today already tracks it separately (and it's currently always 0
 * — see createOrder.ts). Callers that need a shipping-inclusive grand
 * total should add their own shipping sum to this function's `total`.
 */
export function calculateCartTotal(items: { price: number }[]): CartTotal {
  const subtotal = items.reduce((sum, item) => sum + (Number.isFinite(item.price) ? item.price : 0), 0);
  const fee = calculateServiceFee(subtotal);
  const total = Math.round((subtotal + fee) * 100) / 100;

  return { subtotal, fee, total };
}
