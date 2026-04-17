/**
 * Network Evidence — queries cross-user claims on the same canonical plan.
 *
 * When multiple users share a canonical plan, their claims data can provide
 * evidence about what a service actually costs. This module queries claim
 * line items across all users on the same plan (anonymized, k-anonymity >= 5).
 *
 * Used by: discrepancy detection (strengthening evidence), dispute letters
 * (citing network data), and systemic pattern detection.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

const K_ANONYMITY_THRESHOLD = 5;

export interface NetworkServiceEvidence {
  serviceSlug: string;
  observationCount: number;
  medianPatientOwes: number;
  avgPatientOwes: number;
  minPatientOwes: number;
  maxPatientOwes: number;
  paidCount: number;
  deniedCount: number;
}

/**
 * Query anonymized claims data from all users sharing the same canonical plan.
 * Returns per-service aggregate data with k-anonymity enforcement.
 */
export async function getNetworkEvidence(
  supabase: SupabaseClient,
  params: {
    canonicalPlanId: string;
    serviceSlugs: string[];
    excludeUserId?: string;
  }
): Promise<Map<string, NetworkServiceEvidence>> {
  const { canonicalPlanId, serviceSlugs, excludeUserId } = params;
  const results = new Map<string, NetworkServiceEvidence>();

  if (serviceSlugs.length === 0) return results;

  // Find all insurance_plans linked to this canonical plan
  const { data: linkedPlans } = await supabase
    .from("insurance_plans")
    .select("id, user_id")
    .eq("matched_catalog_plan_id", canonicalPlanId);

  if (!linkedPlans || linkedPlans.length < K_ANONYMITY_THRESHOLD) return results;

  const planIds = linkedPlans.map((p) => p.id);

  // Query claim line items across all users on these plans
  // Group by service_slug for aggregation
  for (const slug of serviceSlugs) {
    const { data: items } = await supabase
      .from("claim_line_items")
      .select("patient_owes, insurance_paid, claims!inner(insurance_plan_id, user_id)")
      .eq("service_slug", slug)
      .in("claims.insurance_plan_id", planIds);

    if (!items || items.length === 0) continue;

    // Filter out the requesting user's data and enforce k-anonymity
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const filtered = excludeUserId
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ? items.filter((i) => (i.claims as any)?.user_id !== excludeUserId)
      : items;

    // Count unique users for k-anonymity
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const uniqueUsers = new Set(filtered.map((i) => (i.claims as any)?.user_id)).size;
    if (uniqueUsers < K_ANONYMITY_THRESHOLD) continue;

    // Compute aggregates
    const costs = filtered
      .map((i) => i.patient_owes)
      .filter((c): c is number => c != null && c > 0)
      .sort((a, b) => a - b);

    if (costs.length === 0) continue;

    const paidCount = filtered.filter((i) => i.insurance_paid != null && i.insurance_paid > 0).length;
    const deniedCount = filtered.filter((i) => i.insurance_paid === null || i.insurance_paid === 0).length;

    results.set(slug, {
      serviceSlug: slug,
      observationCount: costs.length,
      medianPatientOwes: costs[Math.floor(costs.length / 2)],
      avgPatientOwes: costs.reduce((s, c) => s + c, 0) / costs.length,
      minPatientOwes: costs[0],
      maxPatientOwes: costs[costs.length - 1],
      paidCount,
      deniedCount,
    });
  }

  return results;
}
