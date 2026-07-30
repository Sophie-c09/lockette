// Read-only customer-facing analytics — never writes anything. Powers
// /orders/[id]'s "usually secured within X minutes" estimate.
import { createClient } from "@/lib/supabase/server";

/**
 * Average minutes between an item entering "securing" and being marked
 * purchased, across every order on the platform (not just the current
 * user's own orders) — calls the average_securing_minutes() SQL function
 * (security definer, see supabase/schema.sql) rather than querying
 * order_items directly, since a plain RLS-scoped query here would only
 * ever see the current user's own rows. Returns null if there isn't
 * enough history yet to estimate from.
 */
export async function getAverageSecuringMinutes(): Promise<number | null> {
  const supabase = await createClient();

  const { data, error } = await supabase.rpc("average_securing_minutes");

  if (error) {
    console.error("[order-analytics-error]", error);
    return null;
  }

  const minutes = Number(data ?? NaN);
  return Number.isFinite(minutes) ? minutes : null;
}
