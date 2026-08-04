// Pre-launch polish fix (item 9) — this exact pill (rounded-pill
// bg-darkgreen/45 text-white marking which marketplace a listing came
// from) was hand-copied verbatim across ListingCard, ListingDetailView,
// PurchaseQueueView, and the Likes page. One shared piece so the four
// can't quietly drift apart. `size` covers the two paddings those call
// sites actually used ("sm" on card thumbnails, "md" on larger detail/
// queue images) — positioning (absolute bottom-*/right-*, z-index) stays
// the caller's job via `className`, since that varies with each image's
// own layout.
type PlatformBadgeSize = "sm" | "md";

const sizeStyles: Record<PlatformBadgeSize, string> = {
  sm: "px-2.5 py-1 text-xs",
  md: "px-3 py-1.5 text-xs",
};

export function PlatformBadge({
  platform,
  size = "sm",
  className = "",
}: {
  platform: string;
  size?: PlatformBadgeSize;
  className?: string;
}) {
  return (
    <span className={`rounded-pill bg-darkgreen/45 font-medium text-white ${sizeStyles[size]} ${className}`}>
      {platform}
    </span>
  );
}
