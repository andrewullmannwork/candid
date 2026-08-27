/**
 * letter-access-state — the ONE loader for the user's state as consumed by the
 * letter-access geo gate (S324). Kept out of letter-access.ts so that module
 * stays pure (no Supabase import) and fixture-testable.
 *
 * Reads profiles.state through userScoped (B9 layer). Returns null when the
 * profile row or the state is absent — which the geo gate treats as FAIL
 * CLOSED for geo-gated letter types (gateUnknownState).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { userScoped } from "@/lib/security/user-scoped";

export async function loadUserStateForLetterAccess(
  supabase: SupabaseClient,
  userId: string,
): Promise<string | null> {
  const { data, error } = await userScoped(supabase, userId)
    .table("profiles")
    .select("state")
    .maybeSingle();
  if (error) {
    // Fail closed: a read error must not open a geo-gated letter type.
    console.error("[letter-access-state] profiles.state read failed:", error);
    return null;
  }
  return (data?.state as string | null) ?? null;
}
