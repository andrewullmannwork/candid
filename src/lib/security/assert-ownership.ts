import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * App-layer ownership gate for request-supplied resource ids. Returns { id } iff
 * `id` exists in `table` AND belongs to `userId`, else null (caller returns 404).
 * createServerClient() is service-role (RLS bypassed), so this app-layer check is
 * the enforcement. Fails closed: a DB error or malformed id yields null → 404.
 *
 * ONLY for tables with a direct `user_id` column (claims, insurance_plans, …).
 * Child tables scoped via a parent (claim_line_items, plan_covered_services) use
 * B1's parent-join, not this helper. When B1 lands, this delegates to
 * userScoped(supabase, userId) so there is a single ownership-filter codepath.
 */
export async function assertOwnership(
  supabase: SupabaseClient,
  table: string,
  id: string,
  userId: string,
): Promise<{ id: string } | null> {
  const { data } = await supabase
    .from(table)
    .select("id")
    .eq("id", id)
    .eq("user_id", userId)
    .maybeSingle();
  return data ? { id: data.id as string } : null;
}
