import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { MOCK_CLOTHING, type ClothingItem } from "@/lib/mock-clothing";
import { SearchView } from "@/components/search/SearchView";

export const metadata: Metadata = {
  title: "Search — Lockette",
};

export default async function SearchPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // /search stays public (no login required), so only fetch likes when
  // there's a signed-in user to fetch them for — same query as /likes.
  let likedItems: ClothingItem[] = [];

  if (user) {
    const { data: savedRows } = await supabase
      .from("saved_items")
      .select("item_id, created_at")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false });

    likedItems = (savedRows ?? [])
      .map((row) => MOCK_CLOTHING.find((item) => item.id === row.item_id))
      .filter((item): item is ClothingItem => Boolean(item));
  }

  return <SearchView likedItems={likedItems} />;
}
