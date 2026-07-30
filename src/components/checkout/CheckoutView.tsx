"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { Combobox, type ComboboxOption } from "@/components/ui/Combobox";
import { PaymentForm } from "@/components/checkout/PaymentForm";
import { createOrder, createOrderForListing, type ShippingAddress } from "@/lib/createOrder";
import { createClient } from "@/lib/supabase/client";
import { calculateCartTotal } from "@/lib/pricing";
import { COUNTRIES, getStatesForCountry } from "@/lib/location-data";

// Static — COUNTRIES never changes at runtime, so this is computed once
// per module load rather than re-derived on every render.
const COUNTRY_OPTIONS: ComboboxOption[] = COUNTRIES.map((country) => ({
  value: country.code,
  label: country.name,
}));

// No city dataset exists anywhere in this app (see location-data.ts) — the
// City combobox always has an empty option list and relies entirely on its
// `allowFreeText` fallback, same as a country/state this app has no
// state list for.
const CITY_OPTIONS: ComboboxOption[] = [];

export interface CheckoutItem {
  id: string;
  title: string;
  price: number;
  imageUrl: string | null;
  brand: string | null;
  platform: string | null;
}

const EMPTY_ADDRESS: ShippingAddress = {
  fullName: "",
  address: "",
  city: "",
  state: "",
  zip: "",
  country: "",
};

// Same visual language as every other field in this form — kept as one
// shared string so the dropdowns and the plain text inputs stay visually
// identical.
const FIELD_CLASS =
  "rounded-md border border-border bg-surface px-3 py-2 text-sm text-ink disabled:cursor-not-allowed disabled:opacity-60";

// listingId present -> this checkout is a single-item Buy Now; absent ->
// it's Buy All against the user's cart. Same distinction createOrder.ts's
// two functions already draw — this view just decides which one to call.
export function CheckoutView({ items, listingId }: { items: CheckoutItem[]; listingId: string | null }) {
  const router = useRouter();
  // Preserved for as long as this component stays mounted (e.g. the user
  // fixes a validation error and resubmits) — country/state/city/zip all
  // live in this one object exactly as before; only *how* country/state
  // are edited (dropdowns instead of free text) changed.
  const [address, setAddress] = useState<ShippingAddress>(EMPTY_ADDRESS);
  const [placingOrder, setPlacingOrder] = useState(false);
  const [addressError, setAddressError] = useState<string | null>(null);

  // null = this country has no known state/province list -> State falls
  // back to a free-text-capable combobox with no options, instead of a
  // strict "must pick a listed option" one (same rule City always
  // follows, since no city dataset exists at all).
  const statesForCountry = useMemo(() => getStatesForCountry(address.country), [address.country]);
  const stateOptions: ComboboxOption[] = useMemo(
    () => (statesForCountry ?? []).map((state) => ({ value: state.code, label: state.name })),
    [statesForCountry],
  );

  // Fee applies ONCE to the combined subtotal below (calculateCartTotal),
  // not once per item — this is the same shared calculation createOrder.ts
  // uses to build the order's actual total_amount, so what's shown here
  // always matches what's charged. A single-item checkout (Buy Now) is
  // just the one-element case of the same function.
  //
  // Marketplace shipping isn't factored into checkout yet — matches
  // createOrder.ts, which hardcodes shipping_cost to 0 on every order_item.
  const shipping = 0;
  const { subtotal: itemTotal, fee: serviceFee, total: subtotalWithFee } = calculateCartTotal(items);
  const total = subtotalWithFee + shipping;

  function updateField(field: keyof ShippingAddress) {
    return (event: React.ChangeEvent<HTMLInputElement>) => {
      setAddress((prev) => ({ ...prev, [field]: event.target.value }));
    };
  }

  // Changing the country invalidates whatever state was previously
  // selected (a US state code has no meaning once the country becomes,
  // say, Canada) — cleared here rather than left dangling with a value
  // that doesn't match the new country's own list.
  function handleCountryChange(country: string) {
    setAddress((prev) => ({ ...prev, country, state: "" }));
  }

  function handleStateChange(state: string) {
    setAddress((prev) => ({ ...prev, state }));
  }

  function handleCityChange(city: string) {
    setAddress((prev) => ({ ...prev, city }));
  }

  function handlePlaceOrder() {
    if (!address.country || !address.state) {
      setAddressError("Please select a country and state/region before placing your order.");
      return;
    }
    setAddressError(null);

    void submitOrder();
  }

  async function submitOrder() {
    setPlacingOrder(true);
    try {
      const supabase = createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!user) {
        alert("Please sign in to check out.");
        return;
      }

      const orderId = listingId
        ? await createOrderForListing(user.id, listingId, address)
        : await createOrder(user.id, address);

      router.push(`/orders/${orderId}`);
    } catch (error) {
      console.error("[checkout-error]", error);
      alert("Something went wrong placing your order. Please try again.");
    } finally {
      setPlacingOrder(false);
    }
  }

  if (items.length === 0) {
    return (
      <div className="flex min-h-[calc(100vh-137px)] flex-col items-center justify-center gap-3 px-6 text-center">
        <p className="text-sm text-ink-soft">There&apos;s nothing to check out.</p>
      </div>
    );
  }

  return (
    <div className="min-h-[calc(100vh-137px)] px-6 pt-12 pb-16">
      <div className="mx-auto max-w-2xl">
        <div className="mb-8 text-center">
          <span className="font-display text-sm tracking-[0.2em] text-oxblood uppercase">Checkout</span>
          <h1 className="mt-2 font-display text-3xl font-semibold text-ink sm:text-4xl">
            Almost there
          </h1>
        </div>

        <div className="flex flex-col gap-6">
          <div className="flex flex-col gap-3 rounded-card border border-border bg-inner/50 p-4">
            <p className="text-sm font-medium text-ink">Shipping information</p>

            <label className="flex flex-col gap-1 text-xs text-ink-soft">
              Full name
              <input
                type="text"
                value={address.fullName}
                onChange={updateField("fullName")}
                className={FIELD_CLASS}
              />
            </label>

            <label className="flex flex-col gap-1 text-xs text-ink-soft">
              Address
              <input
                type="text"
                value={address.address}
                onChange={updateField("address")}
                className={FIELD_CLASS}
              />
            </label>

            <label className="flex flex-col gap-1 text-xs text-ink-soft">
              Country
              <Combobox
                options={COUNTRY_OPTIONS}
                value={address.country}
                onChange={handleCountryChange}
                placeholder="Type or select a country"
              />
            </label>

            <div className="flex gap-3">
              <label className="flex flex-1 flex-col gap-1 text-xs text-ink-soft">
                State / Region
                <Combobox
                  options={stateOptions}
                  value={address.state}
                  onChange={handleStateChange}
                  disabled={!address.country}
                  allowFreeText={!statesForCountry}
                  placeholder={
                    !address.country
                      ? "Select a country first"
                      : statesForCountry
                        ? "Type or select a state"
                        : "Enter state/region"
                  }
                />
              </label>
              <label className="flex flex-1 flex-col gap-1 text-xs text-ink-soft">
                City
                <Combobox
                  options={CITY_OPTIONS}
                  value={address.city}
                  onChange={handleCityChange}
                  allowFreeText
                  placeholder="Enter city"
                />
              </label>
            </div>

            <label className="flex w-1/2 flex-col gap-1 text-xs text-ink-soft">
              ZIP / Postal code
              <input
                type="text"
                value={address.zip}
                onChange={updateField("zip")}
                className={FIELD_CLASS}
              />
            </label>

            {addressError && <p className="text-xs text-oxblood">{addressError}</p>}
          </div>

          <PaymentForm />

          <div className="flex flex-col gap-1.5 rounded-card border border-border bg-inner/50 p-4 text-sm">
            <p className="mb-1 text-sm font-medium text-ink">Order summary</p>
            {items.map((item) => (
              <div key={item.id} className="flex items-center justify-between text-ink-soft">
                <span>{item.title}</span>
                <span>${item.price.toFixed(2)}</span>
              </div>
            ))}
            <div className="mt-1 flex items-center justify-between border-t border-border/60 pt-2 text-ink-soft">
              <span>Subtotal</span>
              <span>${itemTotal.toFixed(2)}</span>
            </div>
            <div className="flex items-center justify-between text-ink-soft">
              <span>Shipping</span>
              <span>{shipping > 0 ? `$${shipping.toFixed(2)}` : "Free"}</span>
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

          <Button type="button" onClick={handlePlaceOrder} disabled={placingOrder} className="w-full">
            {placingOrder ? "Creating order…" : "Place order"}
          </Button>
        </div>
      </div>
    </div>
  );
}
