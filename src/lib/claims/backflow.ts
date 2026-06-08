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

  // F2 (thesaurus Phase 1a): the bill-observed → canonical_plan_services direct
  // write (backflowToCanonical) was REMOVED. Bills lack the verified excerpts the
  // corroboration evaluator requires, so they must not promote to canonical
  // (Rule #10/#14) — canonical stays plan-document-grounded + corroborated. The
  // user-scoped enrichment above stays. (claims_backflow OFF → was inert anyway.)

  if (updated > 0) {
    console.log(`[backflow] Updated ${updated} plan_covered_services from bill data`);
  }

  return { updated, errors };
}
