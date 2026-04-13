/**
 * County-Resolved Premium Lookup
 *
 * Given a canonical_plan_id and user's county_fips, find the county-specific
 * premium from plan_catalog via the plan_catalog_canonical_map join table.
 * Falls back to canonical_plans.premium_monthly if no county match.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export interface CountyPremiumResult {
  premium: number | null;
  source: "county_specific" | "canonical_fallback" | "none";
  county_fips?: string;
  county_name?: string;
}

/**
 * Look up the county-specific premium for a canonical plan.
 *
 * 1. Query plan_catalog_canonical_map for all plan_catalog entries linked to this canonical
 * 2. Filter by county FIPS
 * 3. Return county-specific premium_individual
 * 4. Fallback to canonical's premium_monthly if no county match
 */
export async function getCountyPremium(
  supabase: SupabaseClient,
  canonicalPlanId: string,
  countyFips: string | null
): Promise<CountyPremiumResult> {
  // If we have a county FIPS, try county-specific lookup
  if (countyFips) {
    const { data: mappings } = await supabase
      .from("plan_catalog_canonical_map")
      .select("plan_catalog_id")
      .eq("canonical_plan_id", canonicalPlanId);

    if (mappings && mappings.length > 0) {
      const catalogIds = mappings.map((m) => m.plan_catalog_id);

      const { data: countyPlan } = await supabase
        .from("plan_catalog")
        .select("premium_individual, county, fips_code")
        .in("id", catalogIds)
        .eq("fips_code", countyFips)
        .limit(1)
        .single();

      if (countyPlan?.premium_individual != null) {
        return {
          premium: countyPlan.premium_individual,
          source: "county_specific",
          county_fips: countyFips,
          county_name: countyPlan.county || undefined,
        };
      }
    }
  }

  // Fallback: use canonical plan's premium_monthly
  const { data: canonical } = await supabase
    .from("canonical_plans")
    .select("premium_monthly")
    .eq("id", canonicalPlanId)
    .single();

  if (canonical?.premium_monthly != null) {
    return {
      premium: canonical.premium_monthly,
      source: "canonical_fallback",
    };
  }

  return { premium: null, source: "none" };
}
