/**
 * Systemic Insurer Pattern Detection
 *
 * When 3+ users on the same canonical plan show the same discrepancy for the
 * same service, this is likely INSURER behavior (systematically underpaying),
 * NOT plan data error. Our plan data has multiple verification layers.
 *
 * What we do:
 * 1. Mark affected discrepancies as is_systemic=true
 * 2. Flag as "High Priority Dispute" (strongest evidence base)
 * 3. Notify admin via Slack
 * 4. Store pattern evidence in metadata for dispute letters + class action routing
 *
 * What we do NOT do:
 * - Auto-trigger plan corrections (plan data is likely correct)
 * - Assume the plan data is wrong
 */

import type { SupabaseClient } from "@supabase/supabase-js";

const SYSTEMIC_USER_THRESHOLD = 3;

interface SystemicPattern {
  serviceSlug: string;
  field: string;
  expectedValue: string;
  affectedUserCount: number;
  affectedDiscrepancyIds: string[];
}

/**
 * After discrepancies are persisted for a claim, check if there's a systemic
 * pattern across users on the same canonical plan.
 */
export async function detectSystemicPatterns(
  supabase: SupabaseClient,
  params: {
    canonicalPlanId: string;
    serviceSlugs: string[];
    claimId: string;
  }
): Promise<SystemicPattern[]> {
  const { canonicalPlanId, serviceSlugs } = params;
  const patterns: SystemicPattern[] = [];

  if (serviceSlugs.length === 0) return [];

  // Find all insurance plans linked to this canonical
  const { data: linkedPlans } = await supabase
    .from("insurance_plans")
    .select("id")
    .eq("matched_catalog_plan_id", canonicalPlanId);

  if (!linkedPlans || linkedPlans.length < SYSTEMIC_USER_THRESHOLD) return [];

  const planIds = linkedPlans.map((p) => p.id);

  // For each service slug, check if 3+ users have discrepancies
  for (const slug of serviceSlugs) {
    // Get all active discrepancies for this service across users on this plan
    const { data: discrepancies } = await supabase
      .from("claim_discrepancies")
      .select("id, user_id, field, expected_value, claims!inner(insurance_plan_id)")
      .eq("service_slug", slug)
      .in("status", ["flagged", "verifying", "disputed"])
      .in("claims.insurance_plan_id", planIds);

    if (!discrepancies || discrepancies.length === 0) continue;

    // Group by (field, expected_value) to find matching discrepancy patterns
    const groups = new Map<string, { userIds: Set<string>; ids: string[]; field: string; expectedValue: string }>();

    for (const d of discrepancies) {
      const key = `${d.field}::${d.expected_value}`;
      if (!groups.has(key)) {
        groups.set(key, { userIds: new Set(), ids: [], field: d.field, expectedValue: d.expected_value });
      }
      const group = groups.get(key)!;
      group.userIds.add(d.user_id);
      group.ids.push(d.id);
    }

    // Check each group for systemic threshold
    for (const group of groups.values()) {
      if (group.userIds.size >= SYSTEMIC_USER_THRESHOLD) {
        patterns.push({
          serviceSlug: slug,
          field: group.field,
          expectedValue: group.expectedValue,
          affectedUserCount: group.userIds.size,
          affectedDiscrepancyIds: group.ids,
        });

        // Mark all affected discrepancies as systemic
        await supabase
          .from("claim_discrepancies")
          .update({
            is_systemic: true,
            systemic_user_count: group.userIds.size,
            updated_at: new Date().toISOString(),
          })
          .in("id", group.ids);
      }
    }
  }

  if (patterns.length > 0) {
    console.log(`[systemic-detection] Found ${patterns.length} systemic patterns for canonical plan ${canonicalPlanId}`);
  }

  return patterns;
}
