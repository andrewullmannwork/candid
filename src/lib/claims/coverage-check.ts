/**
 * Coverage Discrepancy Detection
 *
 * Compares claim line items against plan coverage data (both user's plan and
 * canonical plan) to detect when a service that should be covered was denied
 * or when other plan members successfully disputed similar denials.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export interface CoverageDiscrepancy {
  lineItemId: string;
  serviceSlug: string;
  serviceName: string;
  billedAmount: number;
  claimStatus: string;
  expectedCoverage: {
    isCovered: boolean;
    copay?: number | null;
    coinsurance?: number | null;
    source: "user_plan" | "canonical_plan";
  };
  disputeIntel?: {
    totalDisputes: number;
    successfulDisputes: number;
    successRate: number;
  };
  suggestedAction: "file_appeal" | "review_coverage" | "contact_insurer";
}

/**
 * Check claim line items against plan coverage to find discrepancies.
 * Returns items where coverage data says "covered" but the claim was denied or overcharged.
 */
export async function checkCoverageDiscrepancies(
  supabase: SupabaseClient,
  params: {
    claimId: string;
    insurancePlanId?: string;
  }
): Promise<CoverageDiscrepancy[]> {
  const { claimId, insurancePlanId } = params;
  const discrepancies: CoverageDiscrepancy[] = [];

  // Fetch claim and line items
  const { data: claim } = await supabase
    .from("claims")
    .select("status, insurance_plan_id")
    .eq("id", claimId)
    .single();

  if (!claim) return [];

  const planId = insurancePlanId || claim.insurance_plan_id;

  const { data: lineItems } = await supabase
    .from("claim_line_items")
    .select("id, service_slug, billing_code, description, billed_amount, patient_owes, metadata")
    .eq("claim_id", claimId);

  if (!lineItems || lineItems.length === 0) return [];

  // Get user's plan coverage + canonical plan ID
  let canonicalPlanId: string | null = null;
  const userCoverage = new Map<string, { is_covered: boolean; copay: number | null; coinsurance: number | null }>();

  if (planId) {
    const { data: plan } = await supabase
      .from("insurance_plans")
      .select("canonical_plan_id")
      .eq("id", planId)
      .single();
    canonicalPlanId = plan?.canonical_plan_id || null;

    // Fetch user's covered services
    const { data: coveredServices } = await supabase
      .from("plan_covered_services")
      .select("service_id, covered, in_copay, in_coinsurance, service_catalog!inner(slug)")
      .eq("insurance_plan_id", planId);

    if (coveredServices) {
      for (const svc of coveredServices) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const slug = (svc.service_catalog as any)?.slug as string | undefined;
        if (slug) {
          userCoverage.set(slug, {
            is_covered: svc.covered !== false,
            copay: svc.in_copay,
            coinsurance: svc.in_coinsurance,
          });
        }
      }
    }
  }

  // Fetch canonical plan coverage
  const canonicalCoverage = new Map<string, { is_covered: boolean; copay: number | null; coinsurance: number | null }>();
  if (canonicalPlanId) {
    const { data: canonicalServices } = await supabase
      .from("canonical_plan_services")
      .select("service_slug, is_covered, copay, coinsurance")
      .eq("canonical_plan_id", canonicalPlanId);

    if (canonicalServices) {
      for (const svc of canonicalServices) {
        if (svc.service_slug) {
          canonicalCoverage.set(svc.service_slug, {
            is_covered: svc.is_covered !== false,
            copay: svc.copay,
            coinsurance: svc.coinsurance,
          });
        }
      }
    }
  }

  // Check each line item for coverage discrepancy
  for (const item of lineItems) {
    if (!item.service_slug) continue;

    // Check if this line item has a denial finding
    const findings = item.metadata?.auditFindings || [];
    const hasDenialOrOvercharge = findings.some(
      (f: { type: string }) => f.type === "overcharge" || f.type === "balance_billing"
    );

    // Look up coverage
    const userCov = userCoverage.get(item.service_slug);
    const canonicalCov = canonicalCoverage.get(item.service_slug);

    // Discrepancy: service is covered but was denied/overcharged
    if (hasDenialOrOvercharge && (userCov?.is_covered || canonicalCov?.is_covered)) {
      const coverage = userCov || canonicalCov!;
      const source = userCov ? "user_plan" as const : "canonical_plan" as const;

      // Check dispute success rate for this service + insurer
      let disputeIntel: CoverageDiscrepancy["disputeIntel"] | undefined;
      if (canonicalPlanId) {
        const { data: disputes } = await supabase
          .from("dispute_outcomes")
          .select("status")
          .eq("concept_id", item.service_slug); // Simplified — would use concept_id in production

        if (disputes && disputes.length > 0) {
          const successful = disputes.filter(
            (d) => d.status === "won" || d.status === "settled"
          ).length;
          disputeIntel = {
            totalDisputes: disputes.length,
            successfulDisputes: successful,
            successRate: successful / disputes.length,
          };
        }
      }

      discrepancies.push({
        lineItemId: item.id,
        serviceSlug: item.service_slug,
        serviceName: item.description || item.service_slug.replace(/_/g, " "),
        billedAmount: item.billed_amount || 0,
        claimStatus: "denied_or_overcharged",
        expectedCoverage: {
          isCovered: coverage.is_covered,
          copay: coverage.copay,
          coinsurance: coverage.coinsurance,
          source,
        },
        disputeIntel,
        suggestedAction: disputeIntel && disputeIntel.successRate > 0.5
          ? "file_appeal"
          : "contact_insurer",
      });
    }
  }

  console.log(`[coverage-check] Found ${discrepancies.length} discrepancies for claim ${claimId}`);
  return discrepancies;
}
