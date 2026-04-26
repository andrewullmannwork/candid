/**
 * Claim plan-year resolver (T3.7)
 *
 * When a user uploads a historical bill (e.g. a 2025 EOB in 2026, after plan-year
 * rollover), the claim must be linked to the plan that was active on the bill's
 * date of service — NOT the user's currently-active plan.
 *
 * Resolution order:
 *   1. Match by coverage_period_start/end window against the bill's DOS.
 *   2. Match by plan_year = EXTRACT(YEAR FROM DOS).
 *   3. Fall back to the user's active_insurance_plan_id.
 *   4. Return `{ planId: null, planYear: null }` if no plan exists at all.
 *
 * Returned `planYear` is denormalized onto claims + claim_line_items so
 * downstream code (discrepancy engine, dispute-letter resolver, evidence
 * compiler) can scope reads without a join.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export interface ClaimPlanContext {
  planId: string | null;
  planYear: number | null;
}

export async function resolveClaimPlanContext(
  supabase: SupabaseClient,
  params: {
    userId: string;
    dateOfService: string | null;
    fallbackActivePlanId?: string | null;
  }
): Promise<ClaimPlanContext> {
  const { userId, dateOfService, fallbackActivePlanId } = params;

  // No DOS + no fallback → nothing to resolve.
  if (!dateOfService && !fallbackActivePlanId) {
    return { planId: null, planYear: null };
  }

  // 1. Coverage-window match. Most precise — handles mid-year plan switches.
  if (dateOfService) {
    const { data: windowMatch } = await supabase
      .from("insurance_plans")
      .select("id, plan_year")
      .eq("user_id", userId)
      .lte("coverage_period_start", dateOfService)
      .gte("coverage_period_end", dateOfService)
      .order("coverage_period_start", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (windowMatch?.id) {
      return {
        planId: windowMatch.id,
        planYear: windowMatch.plan_year ?? extractYear(dateOfService),
      };
    }
  }

  // 2. Plan-year match. Catches plans without coverage window dates.
  if (dateOfService) {
    const year = extractYear(dateOfService);
    if (year !== null) {
      const { data: yearMatch } = await supabase
        .from("insurance_plans")
        .select("id, plan_year")
        .eq("user_id", userId)
        .eq("plan_year", year)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (yearMatch?.id) {
        return { planId: yearMatch.id, planYear: yearMatch.plan_year ?? year };
      }
    }
  }

  // 3. Active plan fallback. Lets us still record a plan link for users who
  //    haven't uploaded historical plans yet — the dispute-letter resolver
  //    will flag the year mismatch via `missingForYear`.
  if (fallbackActivePlanId) {
    const { data: activePlan } = await supabase
      .from("insurance_plans")
      .select("id, plan_year")
      .eq("id", fallbackActivePlanId)
      .maybeSingle();

    if (activePlan?.id) {
      return {
        planId: activePlan.id,
        planYear: activePlan.plan_year ?? extractYear(dateOfService),
      };
    }
  }

  // 4. No resolution — let application code treat as "unknown year".
  return {
    planId: fallbackActivePlanId ?? null,
    planYear: extractYear(dateOfService),
  };
}

function extractYear(iso: string | null): number | null {
  if (!iso) return null;
  const m = iso.match(/^(\d{4})/);
  return m ? parseInt(m[1], 10) : null;
}
