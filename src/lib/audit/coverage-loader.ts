/**
 * Plan-coverage lookup helper for the audit pipeline.
 *
 * Loads `plan_covered_services` for a given insurance plan and builds a
 * Map<service_slug, PlanCoverageInput> that rules consume to compute should_owe
 * (copay / coinsurance / deductible). Used by:
 *   • process-chunk first-audit (persist.ts caller)
 *   • reaudit.ts view-fetch re-audit (D7)
 *   • admin resolve-type re-classify path
 *   • disputes rerun-audit path
 *
 * Returns null when no plan id is provided (rules see "coverage unknown" and
 * default should_owe to 0 — conservative for recovery framing).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { PlanCoverageInput } from "../claims/recovery-math";

export type PlanCoverageMap = Map<string, PlanCoverageInput>;

export async function loadCoverageMapForPlan(
  supabase: SupabaseClient,
  insurancePlanId: string | null | undefined,
): Promise<PlanCoverageMap | null> {
  if (!insurancePlanId) return null;
  const { data, error } = await supabase
    .from("plan_covered_services")
    .select("covered, in_copay, in_coinsurance, service_catalog!inner(slug)")
    .eq("insurance_plan_id", insurancePlanId);
  if (error) {
    console.warn("[coverage-loader] failed to load coverage for plan", insurancePlanId, error);
    return null;
  }
  const map: PlanCoverageMap = new Map();
  for (const row of data ?? []) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const slug = (row.service_catalog as any)?.slug as string | undefined;
    if (!slug) continue;
    map.set(slug, {
      covered: row.covered as boolean | null,
      copay: row.in_copay as number | null,
      coinsurance: row.in_coinsurance as number | null,
    });
  }
  return map;
}
