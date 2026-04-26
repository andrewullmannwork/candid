/**
 * Billing Code Intelligence — builds community-sourced code databases.
 *
 * Every bill processed grows two tables:
 * 1. billing_code_mappings: code→slug mapping (eventually replaces Haiku for known codes)
 * 2. billing_code_plan_outcomes: per-code paid/denied tracking per canonical plan
 *
 * This is OUR data, community-sourced from user bills. Not AMA data.
 * CPT copyright compliant: we store code numbers and provider descriptions only.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

interface CodeLineItem {
  billing_code: string | null;
  billing_code_type: string | null;
  service_slug: string | null;
  description: string | null;
  insurance_paid: number | null;
  billed_amount: number | null;
  adjustment_reason_code: string | null;
}

/**
 * Update billing_code_mappings with code→slug observations from this bill.
 * Each observation increases confidence for that mapping.
 */
export async function updateCodeMappings(
  supabase: SupabaseClient,
  lineItems: CodeLineItem[]
): Promise<{ updated: number }> {
  let updated = 0;

  const eligible = lineItems.filter(
    (li) => li.billing_code && li.billing_code_type && li.service_slug
  );

  for (const li of eligible) {
    try {
      const { data: existing } = await supabase
        .from("billing_code_mappings")
        .select("id, observation_count, confidence, provider_descriptions")
        .eq("billing_code", li.billing_code!)
        .eq("billing_code_type", li.billing_code_type!)
        .eq("service_slug", li.service_slug!)
        .maybeSingle();

      if (existing) {
        const newCount = existing.observation_count + 1;
        // Confidence scales with observations: 0.5 base, +0.05 per observation, max 0.95
        const newConfidence = Math.min(0.95, 0.5 + newCount * 0.05);

        // Append description if unique (cap at 10 descriptions)
        const descriptions: string[] = existing.provider_descriptions || [];
        if (
          li.description &&
          descriptions.length < 10 &&
          !descriptions.includes(li.description)
        ) {
          descriptions.push(li.description);
        }

        await supabase
          .from("billing_code_mappings")
          .update({
            observation_count: newCount,
            confidence: Math.round(newConfidence * 100) / 100,
            provider_descriptions: descriptions,
            last_seen_at: new Date().toISOString(),
          })
          .eq("id", existing.id);
      } else {
        await supabase.from("billing_code_mappings").insert({
          billing_code: li.billing_code!,
          billing_code_type: li.billing_code_type!,
          service_slug: li.service_slug!,
          confidence: 0.5,
          observation_count: 1,
          provider_descriptions: li.description ? [li.description] : [],
        });
      }

      updated++;
    } catch {
      // Non-blocking per item
    }
  }

  if (updated > 0) {
    console.log(`[code-intelligence] Updated ${updated} code mappings`);
  }

  return { updated };
}

/**
 * Track paid vs denied outcomes per billing code per canonical plan.
 * Builds the data needed for code substitution detection.
 */
export async function updateCodeOutcomes(
  supabase: SupabaseClient,
  lineItems: CodeLineItem[],
  canonicalPlanId: string | null,
  planYear: number | null = null
): Promise<{ updated: number }> {
  if (!canonicalPlanId) return { updated: 0 };

  let updated = 0;

  const eligible = lineItems.filter(
    (li) => li.billing_code && li.billing_code_type
  );

  for (const li of eligible) {
    try {
      const isPaid = li.insurance_paid != null && li.insurance_paid > 0;

      const query = supabase
        .from("billing_code_plan_outcomes")
        .select("id, total_claims, paid_count, denied_count, avg_paid_amount, avg_billed_amount, common_denial_reasons")
        .eq("billing_code", li.billing_code!)
        .eq("billing_code_type", li.billing_code_type!)
        .eq("canonical_plan_id", canonicalPlanId);
      const { data: existing } = await (planYear != null
        ? query.eq("plan_year", planYear)
        : query.is("plan_year", null)
      ).maybeSingle();

      if (existing) {
        const newTotal = existing.total_claims + 1;
        const newPaid = existing.paid_count + (isPaid ? 1 : 0);
        const newDenied = existing.denied_count + (isPaid ? 0 : 1);

        // Running average for paid amount
        let newAvgPaid = existing.avg_paid_amount;
        if (isPaid && li.insurance_paid != null) {
          const prevPaidTotal = (existing.avg_paid_amount || 0) * existing.paid_count;
          newAvgPaid = newPaid > 0 ? (prevPaidTotal + li.insurance_paid) / newPaid : null;
        }

        // Running average for billed amount
        let newAvgBilled = existing.avg_billed_amount;
        if (li.billed_amount != null) {
          const prevBilledTotal = (existing.avg_billed_amount || 0) * existing.total_claims;
          newAvgBilled = (prevBilledTotal + li.billed_amount) / newTotal;
        }

        // Track denial reasons (cap at 10)
        const reasons: string[] = existing.common_denial_reasons || [];
        if (!isPaid && li.adjustment_reason_code && !reasons.includes(li.adjustment_reason_code)) {
          if (reasons.length < 10) reasons.push(li.adjustment_reason_code);
        }

        await supabase
          .from("billing_code_plan_outcomes")
          .update({
            total_claims: newTotal,
            paid_count: newPaid,
            denied_count: newDenied,
            avg_paid_amount: newAvgPaid != null ? Math.round(newAvgPaid * 100) / 100 : null,
            avg_billed_amount: newAvgBilled != null ? Math.round(newAvgBilled * 100) / 100 : null,
            common_denial_reasons: reasons,
            updated_at: new Date().toISOString(),
          })
          .eq("id", existing.id);
      } else {
        await supabase.from("billing_code_plan_outcomes").insert({
          billing_code: li.billing_code!,
          billing_code_type: li.billing_code_type!,
          canonical_plan_id: canonicalPlanId,
          plan_year: planYear,
          total_claims: 1,
          paid_count: isPaid ? 1 : 0,
          denied_count: isPaid ? 0 : 1,
          avg_paid_amount: isPaid && li.insurance_paid != null ? li.insurance_paid : null,
          avg_billed_amount: li.billed_amount || null,
          common_denial_reasons: !isPaid && li.adjustment_reason_code ? [li.adjustment_reason_code] : [],
        });
      }

      updated++;
    } catch {
      // Non-blocking per item
    }
  }

  if (updated > 0) {
    console.log(`[code-intelligence] Tracked ${updated} code outcomes for canonical plan`);
  }

  return { updated };
}

/**
 * Look up a cached code→slug mapping from billing_code_mappings.
 * Returns the mapping if confidence >= threshold and observation_count >= minObservations.
 * Used by service-mapper to skip Haiku for known codes.
 */
export async function getCachedCodeMapping(
  supabase: SupabaseClient,
  billingCode: string,
  billingCodeType: string,
  options?: { minConfidence?: number; minObservations?: number }
): Promise<{ serviceSlug: string; confidence: number } | null> {
  const minConf = options?.minConfidence ?? 0.8;
  const minObs = options?.minObservations ?? 5;

  const { data } = await supabase
    .from("billing_code_mappings")
    .select("service_slug, confidence, observation_count")
    .eq("billing_code", billingCode)
    .eq("billing_code_type", billingCodeType)
    .gte("confidence", minConf)
    .gte("observation_count", minObs)
    .order("confidence", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (data) {
    return { serviceSlug: data.service_slug, confidence: data.confidence };
  }

  return null;
}
