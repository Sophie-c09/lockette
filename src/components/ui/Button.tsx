import Link, { type LinkProps } from "next/link";
import type {
  AnchorHTMLAttributes,
  ButtonHTMLAttributes,
  ReactNode,
} from "react";

type Variant =
  | "primary"
  | "secondary"
  | "ghost"
  | "accent-pink"
  | "accent-teal"
  | "accent-cream";

const variantStyles: Record<Variant, string> = {
  // hover:bg-ink-strong/90 (not hover:bg-ink) — ink-strong is now the
  // brand darkgreen; hovering to ink (body-text near-black) would make
  // the button visibly shift color instead of just darkening/lightening.
  primary: "bg-ink-strong text-white hover:bg-ink-strong/90",
  secondary:
    "border border-border-button bg-white text-ink hover:bg-inner",
  ghost:
    "border border-border-button text-ink hover:border-oxblood hover:text-oxblood",
  "accent-pink": "bg-tag-pink text-tag-pink-ink hover:bg-[#f8d9ea]",
  "accent-teal": "bg-tag-teal text-tag-teal-ink hover:bg-[#dcfaff]",
  "accent-cream":
    "bg-highlight-cream text-highlight-cream-ink hover:bg-[#fef6d9]",
};

// Pre-launch polish fix (item 7) — py-2.5 put this at ~40px tall, just
// under the 44px touch-target guideline; py-3 clears it without changing
// the button's visual weight noticeably.
const baseStyles =
  "inline-flex items-center justify-center gap-2 rounded-pill px-5 py-3 text-sm font-semibold transition-all duration-200 ease-in-out disabled:opacity-50 disabled:pointer-events-none cursor-pointer";

type CommonProps = {
  variant?: Variant;
  className?: string;
  children: ReactNode;
};

export function Button({
  variant = "primary",
  className = "",
  children,
  ...rest
}: CommonProps & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      className={`${baseStyles} ${variantStyles[variant]} ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}

export function LinkButton({
  variant = "primary",
  className = "",
  children,
  href,
  ...rest
}: CommonProps &
  Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & {
    href: LinkProps["href"];
  }) {
  return (
    <Link
      href={href}
      className={`${baseStyles} ${variantStyles[variant]} ${className}`}
      {...rest}
    >
      {children}
    </Link>
  );
}
