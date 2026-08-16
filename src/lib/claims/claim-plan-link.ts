import type { SupabaseClient } from "@supabase/supabase-js";
import { userScoped } from "@/lib/security/user-scoped";
import { emitCaseEvents } from "@/lib/case/case-events";

/**
 * claim-plan-link — THE claim↔plan write (S315; the S291 "claim_plan" repin
 * semantic, extracted to one derivation).
 *
 * WHY: claims stamp insurance_plan_id from the ACTIVE plan at parse time
 * (process-chunk fallbackActivePlanId). Any bill parsed while no plan is
 * active — the /check flow's whole shape, and any authed bill-before-plan
 * upload — persists an UNLINKED claim, and every plan-scoped surface
 * (corrections, plan-priced findings) 409s on it forever. The fix lives at
 * the seam where truth changes: when a plan becomes ACTIVE, the user's
 * unlinked claims adopt it (adoptUnlinkedClaims, called from the four
 * activation seams). Linked claims are NEVER touched — mid-year plan-change
 * pinning (dispute_plan_pinning_v1 semantics) stays intact, and every
 * adoption emits the existing `plan_repinned` case event (Rule #10) so the
 * history is auditable and the user can re-pin per claim with the existing
 * UI. Prior-year claims adopting a current plan is the labeled-proxy case
 * the S313 plan_year_authority machinery already handles downstream.
 */

/** Link ONE claim to a plan the user owns. Ownership-checked on the TARGET
 *  plan (the override route's S291 rule — without it a caller could pin a
 *  claim to a foreign plan id and read its coverage back through the audit).
 *  Returns false when the plan isn't owned or the update fails. */
export async function linkClaimToPlan(
  supabase: SupabaseClient,
  userId: string,
  claimId: string,
  planId: string,
): Promise<boolean> {
  const { data: target } = await userScoped(supabase, userId)
    .table("insurance_plans")
    .select("id")
    .eq("id", planId)
    .maybeSingle();
  if (!target) return false;
  const { error } = await userScoped(supabase, userId)
    .table("claims")
    .update({ insurance_plan_id: planId })
    .eq("id", claimId);
  if (error) return false;
  await emitCaseEvents(supabase, userId, [
    { claimId, kind: "plan_repinned", payload: { toPlanId: planId } },
  ]);
  return true;
}

/**
 * Adopt every UNLINKED claim (insurance_plan_id IS NULL) the user owns onto
 * the plan that just became active. NULL-only by design; fail-soft (an
 * activation must never 500 because adoption hiccupped); returns the count
 * adopted (0 on any failure).
 */
export async function adoptUnlinkedClaims(
  supabase: SupabaseClient,
  userId: string,
  planId: string,
): Promise<number> {
  try {
    const { data: target } = await userScoped(supabase, userId)
      .table("insurance_plans")
      .select("id")
      .eq("id", planId)
      .maybeSingle();
    if (!target) return 0;
    const { data: orphans, error: selErr } = await userScoped(supabase, userId)
      .table("claims")
      .select("id")
      .is("insurance_plan_id", null);
    if (selErr || !orphans || orphans.length === 0) return 0;
    const ids = orphans.map((o: { id: string }) => o.id);
    const { error: updErr } = await userScoped(supabase, userId)
      .table("claims")
      .update({ insurance_plan_id: planId })
      .in("id", ids);
    if (updErr) {
      console.warn("[claim-plan-link] adoption update failed:", updErr.message);
      return 0;
    }
    await emitCaseEvents(
      supabase,
      userId,
      ids.map((claimId: string) => ({
        claimId,
        kind: "plan_repinned",
        payload: { toPlanId: planId, via: "activation_adoption" },
      })),
    );
    console.log(`[claim-plan-link] adopted ${ids.length} unlinked claim(s) → plan ${planId} for user ${userId}`);
    return ids.length;
  } catch (err) {
    console.warn("[claim-plan-link] adoption failed soft:", err instanceof Error ? err.message : err);
    return 0;
  }
}
