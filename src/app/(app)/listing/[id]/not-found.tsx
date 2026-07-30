import { PackageSearch } from "lucide-react";
import { LinkButton } from "@/components/ui/Button";

export default function ListingNotFound() {
  return (
    <div className="flex min-h-[calc(100vh-137px)] items-center justify-center px-6">
      <div className="mx-auto flex max-w-md flex-col items-center gap-4 rounded-card bg-highlight-cream px-8 py-16 text-center">
        <PackageSearch className="h-8 w-8 text-oxblood" strokeWidth={1.5} />
        <p className="text-sm text-ink-soft">
          This listing doesn&apos;t exist or may have been removed.
        </p>
        <LinkButton href="/discover">Back to Discover</LinkButton>
      </div>
    </div>
  );
}
