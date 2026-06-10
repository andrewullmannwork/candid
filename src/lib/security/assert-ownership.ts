import type { SupabaseClient } from "@supabase/supabase-js";
import { userScoped, type DirectUserOwnedTable } from "./user-scoped";

/**
 * App-layer ownership gate for request-supplied resource ids. Returns { id } iff
 * `id` exists in `table` AND belongs to `userId`, else null (caller returns 404).
 * createServerClient() is service-role (RLS bypassed), so this app-layer check is
 * the enforcement. Fails closed: a DB error or malformed id yields null → 404.
 *
 * Backed by userScoped() (B1) so there is a SINGLE ownership-filter codepath.
 * ONLY for tables with a direct `user_id` column (DirectUserOwnedTable). Child
 * tables scoped via a parent (claim_line_items, plan_covered_services) use
 * selectOwnedParentIds(), not this helper.
 */
export async function assertOwnership(
  supabase: SupabaseClient,
  table: DirectUserOwnedTable,
  id: string,
  userId: string,
): Promise<{ id: string } | null> {
  const { data } = await userScoped(supabase, userId)
    .table(table)
    .select("id")
    .eq("id", id)
    .maybeSingle();
  return data ? { id: data.id as string } : null;
}
