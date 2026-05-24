import { createServerClient } from "@/lib/supabase/server";

/**
 * Profile dashboard rollout flag (S121 B2.1).
 *
 * Defaults ON when the `profile_dashboard_v1` row is absent from
 * `feature_flag_rules` — per Andrew direction at S121: "have the flag on and I
 * will do the migration as needed." To roll back, seed/update the flag row with
 * enabled=false via migration; the check then respects the explicit state.
 *
 * Distinct from the generic `isFeatureEnabled` helper (which defaults to false
 * on missing row). The "default ON when missing" semantic is specific to this
 * flag and is appropriate because (a) we're pre-launch (no real users to
 * shield), (b) the rollback path is a single SQL UPDATE, and (c) requiring a
 * mig before the new behavior appears would block fast PROD iteration.
 */
export async function isProfileDashboardEnabled(): Promise<boolean> {
  const supabase = createServerClient();
  const { data } = await supabase
    .from("feature_flag_rules")
    .select("enabled")
    .eq("flag_key", "profile_dashboard_v1")
    .maybeSingle();
  if (!data) return true;
  return data.enabled;
}
