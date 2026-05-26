/**
 * Discrepancy Engine — three-tier detection for billing discrepancies.
 *
 * Tier 1: Audit findings (overcharge, duplicate, etc.) — already handled by audit engine.
 * Tier 2: Coverage status — "Is this service even covered by the plan?"
 *   - Works from day one with just plan data (no cost data needed).
 *   - Flags: unknown service, not covered, covered but $0 paid.
 * Tier 3a: Cost comparison — "You were charged $60, plan says $30."
 *   - Requires plan cost data with confidence >= 0.5.
 * Tier 3b: Code substitution — "Code X denied 70%, but Code Y for same service paid 85%."
 *   - Uses billing_code_mappings + billing_code_plan_outcomes from code-intelligence.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeCoinsurancePct } from "@/lib/billing/coinsurance";

// Thresholds
const COST_DIFF_PERCENT_THRESHOLD = 0.15; // 15%
const COST_DIFF_DOLLAR_THRESHOLD = 25; // $25
const MIN_PLAN_CONFIDENCE = 0.5;
const CODE_DENIAL_RATE_THRESHOLD = 0.5; // Flag if code denied >50% of the time

export interface DetectedDiscrepancy {
  claimLineItemId: string;
  serviceSlug: string;
  tier: 1 | 2 | 3;
  field: string;
  expectedValue: string;
  actualValue: string;
  expectedSource: string;
  expectedConfidence: number;
  metadata?: Record<string, unknown>;
}

/**
 * Detect discrepancies for a processed claim.
 * Returns discrepancies to be persisted in claim_discrepancies table.
 */
export async function detectDiscrepancies(
  supabase: SupabaseClient,
  params: {
    claimId: string;
    userId: string;
    insurancePlanId: string | null;
  }
): Promise<DetectedDiscrepancy[]> {
  const { claimId, userId, insurancePlanId } = params;
  const discrepancies: DetectedDiscrepancy[] = [];

  if (!insurancePlanId) return [];

  // Fetch claim line items
  const { data: lineItems } = await supabase
    .from("claim_line_items")
    .select("id, service_slug, billing_code, billing_code_type, description, billed_amount, allowed_amount, insurance_paid, patient_owes")
    .eq("claim_id", claimId);

  if (!lineItems || lineItems.length === 0) return [];

  // Fetch user's plan coverage (keyed by service_slug)
  const userCoverage = await fetchUserCoverage(supabase, insurancePlanId);

  // Get canonical plan ID for code substitution detection
  const { data: plan } = await supabase
    .from("insurance_plans")
    .select("matched_catalog_plan_id")
    .eq("id", insurancePlanId)
    .single();
  const canonicalPlanId = plan?.matched_catalog_plan_id || null;

  // Check each line item
  for (const item of lineItems) {
    if (!item.service_slug) continue;

    const coverage = userCoverage.get(item.service_slug);

    // ── Tier 2: Coverage status checks ──────────────────────────────────

    if (!coverage) {
      // No plan_covered_services row → unknown service
      discrepancies.push({
        claimLineItemId: item.id,
        serviceSlug: item.service_slug,
        tier: 2,
        field: "unknown_service",
        expectedValue: "Unknown — upload your SBC to check",
        actualValue: `Billed $${item.billed_amount || 0}`,
        expectedSource: "user_plan",
        expectedConfidence: 0,
      });
      continue;
    }

    if (coverage.covered === false) {
      // Plan says not covered
      discrepancies.push({
        claimLineItemId: item.id,
        serviceSlug: item.service_slug,
        tier: 2,
        field: "coverage_status",
        expectedValue: "Not covered by plan",
        actualValue: `Billed $${item.billed_amount || 0}`,
        expectedSource: coverage.source || "user_plan",
        expectedConfidence: coverage.confidence || 0.5,
      });
      continue;
    }

    if (item.insurance_paid === null || item.insurance_paid === 0) {
      // Covered but insurance paid $0 — potential denial
      discrepancies.push({
        claimLineItemId: item.id,
        serviceSlug: item.service_slug,
        tier: 2,
        field: "coverage_status",
        expectedValue: `Covered (${formatCostExpectation(coverage)})`,
        actualValue: "Insurance paid $0",
        expectedSource: coverage.source || "user_plan",
        expectedConfidence: coverage.confidence || 0.5,
      });

      // Also run Tier 3b code substitution check for denied claims
      if (item.billing_code && item.billing_code_type && canonicalPlanId) {
        const codeSub = await detectCodeSubstitution(
          supabase,
          item.billing_code,
          item.billing_code_type,
          item.service_slug,
          canonicalPlanId
        );
        if (codeSub) {
          discrepancies.push({
            claimLineItemId: item.id,
            serviceSlug: item.service_slug,
            tier: 3,
            field: "code_substitution",
            expectedValue: codeSub.expectedValue,
            actualValue: codeSub.actualValue,
            expectedSource: "code_intelligence",
            expectedConfidence: codeSub.confidence,
            metadata: codeSub.metadata,
          });
        }
      }
      continue;
    }

    // ── Tier 3a: Cost comparison ────────────────────────────────────────

    if (coverage.confidence != null && coverage.confidence >= MIN_PLAN_CONFIDENCE) {
      const expectedCost = computeExpectedCost(coverage, item.billed_amount);
      const actualCost = item.patient_owes;

      if (expectedCost != null && actualCost != null && actualCost > 0) {
        const diff = actualCost - expectedCost;
        const pctDiff = expectedCost > 0 ? diff / expectedCost : 0;

        if (diff > COST_DIFF_DOLLAR_THRESHOLD || pctDiff > COST_DIFF_PERCENT_THRESHOLD) {
          discrepancies.push({
            claimLineItemId: item.id,
            serviceSlug: item.service_slug,
            tier: 3,
            field: coverage.copay != null ? "copay" : coverage.coinsurance != null ? "coinsurance" : "other",
            expectedValue: `$${expectedCost.toFixed(2)} (${formatCostExpectation(coverage)})`,
            actualValue: `$${actualCost.toFixed(2)}`,
            expectedSource: coverage.source || "user_plan",
            expectedConfidence: coverage.confidence,
          });
        }
      }
    }
  }

  // Persist discrepancies
  if (discrepancies.length > 0) {
    const inserts = discrepancies.map((d) => ({
      claim_id: claimId,
      claim_line_item_id: d.claimLineItemId,
      user_id: userId,
      service_slug: d.serviceSlug,
      tier: d.tier,
      field: d.field,
      expected_value: d.expectedValue,
      actual_value: d.actualValue,
      expected_source: d.expectedSource,
      expected_confidence: d.expectedConfidence,
      status: "flagged",
      metadata: d.metadata || {},
    }));

    const { error } = await supabase.from("claim_discrepancies").insert(inserts);
    if (error) {
      console.error("[discrepancy-engine] Failed to persist discrepancies:", error.message);
    } else {
      console.log(`[discrepancy-engine] Detected ${discrepancies.length} discrepancies for claim ${claimId}`);
    }

    // Run systemic insurer pattern detection across canonical plan users
    if (canonicalPlanId) {
      try {
        const { detectSystemicPatterns } = await import("./systemic-detection");
        const { notifySystemicPattern } = await import("@/lib/notifications");
        const uniqueSlugs = [...new Set(discrepancies.map((d) => d.serviceSlug))];

        const patterns = await detectSystemicPatterns(supabase, {
          canonicalPlanId,
          serviceSlugs: uniqueSlugs,
          claimId,
        });

        // Notify admin for each new systemic pattern
        for (const pattern of patterns) {
          // Get insurer + plan name for notification
          let insurerName: string | undefined;
          let planName: string | undefined;
          try {
            const { data: canonical } = await supabase
              .from("canonical_plans")
              .select("plan_name, insurers!inner(name)")
              .eq("id", canonicalPlanId)
              .single();
            if (canonical) {
              planName = canonical.plan_name || undefined;
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              insurerName = (canonical.insurers as any)?.name || undefined;
            }
          } catch { /* best-effort */ }

          notifySystemicPattern({
            serviceSlug: pattern.serviceSlug,
            field: pattern.field,
            expectedValue: pattern.expectedValue,
            affectedUserCount: pattern.affectedUserCount,
            canonicalPlanId,
            insurerName,
            planName,
          }).catch(() => {}); // Non-blocking
        }
      } catch (err) {
        console.error("[discrepancy-engine] Systemic detection failed (non-fatal):", err);
      }
    }
  }

  return discrepancies;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

interface CoverageData {
  covered: boolean | null;
  copay: number | null;
  coinsurance: number | null;
  deductible_applies: boolean | null;
  confidence: number | null;
  source: string | null;
  bill_observed_cost: number | null;
}

async function fetchUserCoverage(
  supabase: SupabaseClient,
  insurancePlanId: string
): Promise<Map<string, CoverageData>> {
  const map = new Map<string, CoverageData>();

  const { data } = await supabase
    .from("plan_covered_services")
    .select("covered, in_copay, in_coinsurance, in_deductible_applies, confidence, source, bill_observed_cost, service_catalog!inner(slug)")
    .eq("insurance_plan_id", insurancePlanId);

  if (data) {
    for (const row of data) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const slug = (row.service_catalog as any)?.slug as string | undefined;
      if (slug) {
        map.set(slug, {
          covered: row.covered,
          copay: row.in_copay,
          coinsurance: row.in_coinsurance,
          deductible_applies: row.in_deductible_applies,
          confidence: row.confidence,
          source: row.source,
          bill_observed_cost: row.bill_observed_cost,
        });
      }
    }
  }

  return map;
}

function computeExpectedCost(
  coverage: CoverageData,
  billedAmount: number | null
): number | null {
  // If copay is available, that's the expected patient cost
  if (coverage.copay != null) return coverage.copay;

  // If coinsurance is available, compute from billed amount
  if (coverage.coinsurance != null && billedAmount != null) {
    return billedAmount * coverage.coinsurance;
  }

  // Fall back to bill_observed_cost if available
  if (coverage.bill_observed_cost != null) return coverage.bill_observed_cost;

  return null;
}

function formatCostExpectation(coverage: CoverageData): string {
  const parts: string[] = [];
  if (coverage.copay != null) parts.push(`copay: $${coverage.copay}`);
  if (coverage.coinsurance != null) parts.push(`coinsurance: ${normalizeCoinsurancePct(coverage.coinsurance)}%`);
  if (parts.length === 0 && coverage.covered !== false) parts.push("covered");
  return parts.join(", ");
}

// ── Tier 3b: Code Substitution Detection ─────────────────────────────────────

interface CodeSubstitutionResult {
  expectedValue: string;
  actualValue: string;
  confidence: number;
  metadata: Record<string, unknown>;
}

/**
 * When a covered service is denied (insurance_paid=0), check if the specific
 * billing code is frequently denied while sibling codes for the same service
 * are typically paid. This detects insurer code classification games.
 */
async function detectCodeSubstitution(
  supabase: SupabaseClient,
  billingCode: string,
  billingCodeType: string,
  serviceSlug: string,
  canonicalPlanId: string
): Promise<CodeSubstitutionResult | null> {
  // 1. Check this code's outcome on this plan
  const { data: thisCodeOutcome } = await supabase
    .from("billing_code_plan_outcomes")
    .select("total_claims, paid_count, denied_count")
    .eq("billing_code", billingCode)
    .eq("billing_code_type", billingCodeType)
    .eq("canonical_plan_id", canonicalPlanId)
    .maybeSingle();

  if (!thisCodeOutcome || thisCodeOutcome.total_claims < 2) return null;

  const denialRate = thisCodeOutcome.denied_count / thisCodeOutcome.total_claims;
  if (denialRate < CODE_DENIAL_RATE_THRESHOLD) return null;

  // 2. Find sibling codes that map to the same service_slug
  const { data: siblingMappings } = await supabase
    .from("billing_code_mappings")
    .select("billing_code, billing_code_type, confidence, observation_count")
    .eq("service_slug", serviceSlug)
    .neq("billing_code", billingCode)
    .gte("confidence", 0.6)
    .gte("observation_count", 3);

  if (!siblingMappings || siblingMappings.length === 0) return null;

  // 3. Check sibling codes' outcomes on this plan
  for (const sibling of siblingMappings) {
    const { data: siblingOutcome } = await supabase
      .from("billing_code_plan_outcomes")
      .select("total_claims, paid_count, denied_count")
      .eq("billing_code", sibling.billing_code)
      .eq("billing_code_type", sibling.billing_code_type)
      .eq("canonical_plan_id", canonicalPlanId)
      .maybeSingle();

    if (!siblingOutcome || siblingOutcome.total_claims < 2) continue;

    const siblingPayRate = siblingOutcome.paid_count / siblingOutcome.total_claims;

    // Sibling code is paid significantly more often
    if (siblingPayRate > 0.6 && siblingPayRate - (1 - denialRate) > 0.3) {
      return {
        expectedValue: `Code ${sibling.billing_code} (${sibling.billing_code_type}) for same service is paid ${(siblingPayRate * 100).toFixed(0)}% of the time`,
        actualValue: `Code ${billingCode} (${billingCodeType}) is denied ${(denialRate * 100).toFixed(0)}% of the time`,
        confidence: Math.min(sibling.confidence, 0.9),
        metadata: {
          deniedCode: billingCode,
          deniedCodeType: billingCodeType,
          denialRate,
          siblingCode: sibling.billing_code,
          siblingCodeType: sibling.billing_code_type,
          siblingPayRate,
          serviceSlug,
        },
      };
    }
  }

  return null;
}
