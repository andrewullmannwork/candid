/**
 * Benefits Utilization — auto-marks plan services as "used" from claims data.
 *
 * When bills are processed and claims created with service_slugs, this module
 * updates plan_covered_services to track which benefits the user has actually used.
 * Replaces the localStorage-only manual toggle on dashboard + plan page.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export async function updateBenefitsUsed(
  supabase: SupabaseClient,
  params: {
    userId: string;
    insurancePlanId: string;
    serviceSlugs: string[];
  }
): Promise<{ updated: number }> {
  const { insurancePlanId, serviceSlugs } = params;
  let updated = 0;

  const uniqueSlugs = [...new Set(serviceSlugs.filter(Boolean))];
  if (uniqueSlugs.length === 0) return { updated: 0 };

  const today = new Date().toISOString().split("T")[0];

  for (const slug of uniqueSlugs) {
    try {
      // Look up service_catalog by slug
      const { data: svc } = await supabase
        .from("service_catalog")
        .select("id")
        .eq("slug", slug)
        .single();

      if (!svc) continue;

      // Update plan_covered_services with usage tracking
      const { data: existing } = await supabase
        .from("plan_covered_services")
        .select("id, usage_count")
        .eq("insurance_plan_id", insurancePlanId)
        .eq("service_id", svc.id)
        .maybeSingle();

      if (existing) {
        await supabase
          .from("plan_covered_services")
          .update({
            last_used_date: today,
            usage_count: (existing.usage_count || 0) + 1,
          })
          .eq("id", existing.id);
        updated++;
      }
      // If no plan_covered_services row exists, we don't create one just for usage.
      // The backflow module handles creating rows from bill data.
    } catch {
      // Non-blocking per slug
    }
  }

  if (updated > 0) {
    console.log(`[benefits-utilization] Updated ${updated} service usage records`);
  }

  return { updated };
}
