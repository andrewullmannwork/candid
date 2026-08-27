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

/**
 * S326 (Rule 8) — the claim's litigation screening answer, the ONE reader for
 * the litigation-hold gate's input. The answer is a guide-step attestation
 * (the S297 checklist mechanic — no new route, no new table): stepId
 * `screening:litigation`, the yes/no riding `note` exactly like
 * `packA:phone-outcome`. Returns:
 *   true  — the member attested a lawsuit / service of process ("yes")
 *   false — answered "no"
 *   null  — never asked (legacy claims; the gate is inert on null)
 * A read ERROR returns true-side-safe null? No — null (gate inert) would open
 * the gate on a transient failure for a claim that answered "yes". Litigation
 * is the one gate where we hold on error: a read error returns true (refuse),
 * matching the geo gate's fail-closed posture; the member re-tries and the
 * next read succeeds.
 */
export const LITIGATION_STEP_ID = "screening:litigation";

export async function loadClaimLitigationAttested(
  supabase: SupabaseClient,
  userId: string,
  claimId: string | null | undefined,
): Promise<boolean | null> {
  if (!claimId) return null;
  const { data, error } = await userScoped(supabase, userId)
    .table("claims")
    .select("metadata")
    .eq("id", claimId)
    .maybeSingle();
  if (error) {
    console.error("[letter-access-state] litigation screening read failed:", error);
    return true; // fail closed — a read error must not compose past a possible hold
  }
  const meta = (data?.metadata as Record<string, unknown> | null) ?? null;
  const steps = (meta?.guideSteps as Record<string, { note?: unknown }> | undefined) ?? {};
  const note = steps[LITIGATION_STEP_ID]?.note;
  if (note === "yes") return true;
  if (note === "no") return false;
  return null;
}
