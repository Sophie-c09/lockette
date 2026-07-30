// AI-Powered Outfit Creation — Part 6: bundle pricing. Pure arithmetic,
// no I/O — mirrors styled_bundles' own item_subtotal/mavelle_fee/
// total_price columns (supabase/schema.sql) exactly, so a caller can
// write this function's output straight into an insert/update with no
// remapping.
export const MAVELLE_FEE_RATE = 0.2;

export interface BundlePricing {
  itemSubtotal: number;
  mavelleFee: number;
  totalPrice: number;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Sums the given item prices, adds Lockette's 20% creation fee on top of
 * that subtotal, and returns all three figures rounded to cents.
 *
 * Example (this feature's own spec): [20, 35, 40] -> subtotal 95,
 * fee 19, total 114.
 */
export function calculateBundlePricing(itemPrices: number[]): BundlePricing {
  const itemSubtotal = round2(itemPrices.reduce((sum, price) => sum + price, 0));
  const mavelleFee = round2(itemSubtotal * MAVELLE_FEE_RATE);
  const totalPrice = round2(itemSubtotal + mavelleFee);

  return { itemSubtotal, mavelleFee, totalPrice };
}
