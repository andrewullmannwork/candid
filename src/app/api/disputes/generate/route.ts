// POST /api/disputes/generate
// Generates a dispute letter from an audit report's findings
// Optionally enriches with plan benefit evidence when insurancePlanId is provided

import { NextRequest, NextResponse } from "next/server";
import { generateDisputeLetter, generateItemizedBillRequest } from "@/lib/disputes";
import type { PlanBenefitEvidence } from "@/lib/disputes";
import { persistDisputeLetter } from "@/lib/disputes/persist";
import { createServerClient } from "@/lib/supabase/server";
import type { AuditReport, DisputeLetterType } from "@/lib/billing/types";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();

    // Case 1: Generate from audit report findings
    if (body.auditReport && body.findingIds) {
      const { auditReport, findingIds, letterType, insurancePlanId } = body as {
        auditReport: AuditReport;
        findingIds: string[];
        letterType?: DisputeLetterType;
        insurancePlanId?: string;
      };

      if (!findingIds.length) {
        return NextResponse.json(
          { error: "At least one finding ID is required" },
          { status: 400 }
        );
      }

      // Fetch plan benefit evidence if insurancePlanId provided
      let planEvidence: PlanBenefitEvidence[] | undefined;
      if (insurancePlanId) {
        try {
          const supabaseForEvidence = createServerClient();
          // Get service slugs from the selected findings' line items
          const selectedFindings = auditReport.findings.filter((f) => findingIds.includes(f.id));
          const lineNumbers = new Set(selectedFindings.flatMap((f) => f.lineItems));
          const serviceSlugs = new Set<string>();
          for (const item of auditReport.parsedBill.lineItems) {
            if (lineNumbers.has(item.lineNumber) && item.category) {
              serviceSlugs.add(item.category);
            }
          }

          // Look up coverage for those service slugs
          if (serviceSlugs.size > 0) {
            const { data: covered } = await supabaseForEvidence
              .from("plan_covered_services")
              .select("covered, in_copay, in_coinsurance, source, service_catalog!inner(slug, name)")
              .eq("insurance_plan_id", insurancePlanId);

            if (covered) {
              planEvidence = covered
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                .filter((s) => serviceSlugs.has((s.service_catalog as any)?.slug))
                .map((s) => ({
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  serviceSlug: (s.service_catalog as any)?.slug || "",
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  serviceName: (s.service_catalog as any)?.name || (s.service_catalog as any)?.slug?.replace(/_/g, " ") || "",
                  copay: s.in_copay,
                  coinsurance: s.in_coinsurance,
                  covered: s.covered !== false,
                  source: s.source,
                }));
            }
          }
        } catch (err) {
          console.error("[disputes] Plan evidence lookup failed (non-fatal):", err);
        }
      }

      const letter = generateDisputeLetter(auditReport, findingIds, letterType, planEvidence);

      // Persist dispute to database (feature-flagged)
      let disputeId: string | null = null;
      try {
        const { isFeatureEnabled } = await import("@/lib/config/product-flags");
        const disputeTrackingEnabled = await isFeatureEnabled("dispute_tracking");
        if (!disputeTrackingEnabled) throw new Error("feature_disabled");

        const supabase = createServerClient();
        const selectedFindings = auditReport.findings.filter((f) => findingIds.includes(f.id));
        const totalDisputed = selectedFindings.reduce((sum, f) => sum + f.estimatedOvercharge, 0);

        const result = await persistDisputeLetter(supabase, {
          userId: auditReport.userId,
          claimId: body.claimId || undefined,
          claimLineItemIds: body.claimLineItemIds || undefined,
          letterType: letterType || "overcharge",
          amountDisputed: totalDisputed,
        });
        disputeId = result?.disputeId || null;
      } catch (err) {
        if (err instanceof Error && err.message !== "feature_disabled") {
          console.error("[disputes] Failed to persist dispute (non-fatal):", err);
        }
      }

      return NextResponse.json({ success: true, letter, disputeId });
    }

    // Case 2: Generate itemized bill request (no audit needed)
    if (body.type === "itemized_request") {
      const { patientName, providerName, serviceDate, accountNumber } = body;

      if (!patientName || !providerName || !serviceDate) {
        return NextResponse.json(
          { error: "patientName, providerName, and serviceDate are required" },
          { status: 400 }
        );
      }

      const letter = generateItemizedBillRequest({
        patientName,
        providerName,
        serviceDate,
        accountNumber,
      });
      return NextResponse.json({ success: true, letter });
    }

    // Case 3: Generate negotiation letter (uninsured / self-pay)
    if (body.type === "negotiation") {
      const { patientName, providerName, serviceName, serviceDate, billedAmount, medicareBenchmark, communityMedian, suggestedRate, communityReportCount } = body;

      if (!patientName || !providerName || !serviceName || !suggestedRate) {
        return NextResponse.json(
          { error: "patientName, providerName, serviceName, and suggestedRate are required" },
          { status: 400 }
        );
      }

      const { generateNegotiationLetter } = await import("@/lib/disputes/negotiation-template");
      const letter = generateNegotiationLetter({
        patientName,
        providerName,
        serviceName,
        serviceDate,
        billedAmount,
        medicareBenchmark: medicareBenchmark ?? null,
        communityMedian: communityMedian ?? null,
        suggestedRate,
        communityReportCount: communityReportCount ?? 0,
      });
      return NextResponse.json({ success: true, letter });
    }

    return NextResponse.json(
      { error: "Invalid request — provide auditReport + findingIds, type: 'itemized_request', or type: 'negotiation'" },
      { status: 400 }
    );
  } catch (error) {
    console.error("Dispute letter generation error:", error);
    return NextResponse.json(
      { error: "Letter generation failed. Please try again." },
      { status: 500 }
    );
  }
}
