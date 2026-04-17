/**
 * Claims Backflow — enriches plan_covered_services with bill-observed costs.
 *
 * When a bill is processed and claims are persisted, this module takes the
 * actual amounts from claim_line_items and writes them back to the user's
 * plan_covered_services records. This fills gaps for users who uploaded
 * bills but not SBCs, and also enriches the canonical plan for all users.
 *
 * Source = "bill_observed", confidence = 0.4 (lower than SBC data at 0.5+).
 */

import type { SupabaseClient } from "@supabase/supabase-js";

interface BackflowLineItem {
  service_slug: string | null;
  patient_owes: number | null;
  billed_amount: number | null;
}

export async function backflowBillCosts(
  supabase: SupabaseClient,
  params: {
    userId: string;
    insurancePlanId: string | null;
    lineItems: BackflowLineItem[];
  }
): Promise<{ updated: number; errors: string[] }> {
  const { insurancePlanId, lineItems } = params;
  const errors: string[] = [];
  let updated = 0;

  if (!insurancePlanId) return { updated: 0, errors: [] };

  // Filter to line items with a service_slug and a patient cost
  const eligible = lineItems.filter(
    (li) => li.service_slug && li.patient_owes != null && li.patient_owes > 0
  );

  if (eligible.length === 0) return { updated: 0, errors: [] };

  for (const li of eligible) {
    try {
      // Look up service_catalog entry by slug
      const { data: svc } = await supabase
        .from("service_catalog")
        .select("id")
        .eq("slug", li.service_slug!)
        .single();

      if (!svc) continue;

      // Upsert into plan_covered_services with bill-observed cost
      const { data: existing } = await supabase
        .from("plan_covered_services")
        .select("id, bill_observed_cost, bill_observed_count")
        .eq("insurance_plan_id", insurancePlanId)
        .eq("service_id", svc.id)
        .maybeSingle();

      if (existing) {
        // Running average
        const prevCount = existing.bill_observed_count || 0;
        const prevCost = existing.bill_observed_cost || 0;
        const newCount = prevCount + 1;
        const newCost = (prevCost * prevCount + li.patient_owes!) / newCount;

        await supabase
          .from("plan_covered_services")
          .update({
            bill_observed_cost: Math.round(newCost * 100) / 100,
            bill_observed_count: newCount,
            bill_observed_source: "bill_observed",
            bill_observed_updated_at: new Date().toISOString(),
          })
          .eq("id", existing.id);
      } else {
        // Create new record with bill-observed data only
        await supabase.from("plan_covered_services").insert({
          insurance_plan_id: insurancePlanId,
          service_id: svc.id,
          bill_observed_cost: li.patient_owes,
          bill_observed_count: 1,
          bill_observed_source: "bill_observed",
          bill_observed_updated_at: new Date().toISOString(),
          confidence: 0.4,
          source: "bill_observed",
        });
      }

      updated++;
    } catch (err) {
      errors.push(`Backflow failed for ${li.service_slug}: ${err}`);
    }
  }

  // Also enrich canonical plan if linked
  try {
    const { data: plan } = await supabase
      .from("insurance_plans")
      .select("matched_catalog_plan_id")
      .eq("id", insurancePlanId)
      .single();

    if (plan?.matched_catalog_plan_id) {
      await backflowToCanonical(supabase, plan.matched_catalog_plan_id, eligible);
    }
  } catch {
    // Non-blocking — canonical enrichment is best-effort
  }

  if (updated > 0) {
    console.log(`[backflow] Updated ${updated} plan_covered_services from bill data`);
  }

  return { updated, errors };
}

/**
 * Enrich canonical_plan_services with bill-observed costs.
 * Lower confidence (0.3) than user-specific backflow (0.4).
 */
async function backflowToCanonical(
  supabase: SupabaseClient,
  canonicalPlanId: string,
  lineItems: BackflowLineItem[]
): Promise<void> {
  for (const li of lineItems) {
    if (!li.service_slug || li.patient_owes == null) continue;

    try {
      const { data: existing } = await supabase
        .from("canonical_plan_services")
        .select("id, copay, confidence")
        .eq("canonical_plan_id", canonicalPlanId)
        .eq("service_slug", li.service_slug)
        .maybeSingle();

      // Only update canonical if no SBC data exists (confidence < 0.4)
      // or if the row doesn't exist at all
      if (!existing) {
        await supabase.from("canonical_plan_services").insert({
          canonical_plan_id: canonicalPlanId,
          service_slug: li.service_slug,
          copay: li.patient_owes,
          is_covered: true,
          confidence: 0.3,
          source: "bill_observed",
        });
      } else if (existing.confidence != null && existing.confidence < 0.4) {
        // Only overwrite very low confidence data
        await supabase
          .from("canonical_plan_services")
          .update({
            copay: li.patient_owes,
            confidence: 0.3,
            source: "bill_observed",
          })
          .eq("id", existing.id);
      }
    } catch {
      // Best-effort per item
    }
  }
}
