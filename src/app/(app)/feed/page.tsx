import { redirect } from "next/navigation";

// /feed and /discover were merged into a single unified browsing page
// (see src/lib/discover-feed.ts's own comment) — this route is kept only
// as a redirect so old links/bookmarks/browser history still land
// somewhere real instead of a bare 404.
export default function FeedPage() {
  redirect("/discover");
}
