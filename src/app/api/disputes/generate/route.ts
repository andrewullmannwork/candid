// POST /api/disputes/generate
// Generates a dispute letter from an audit report's findings

import { NextRequest, NextResponse } from "next/server";
import { generateDisputeLetter, generateItemizedBillRequest } from "@/lib/disputes";
import { persistDisputeLetter } from "@/lib/disputes/persist";
import { createServerClient } from "@/lib/supabase/server";
import type { AuditReport, DisputeLetterType } from "@/lib/billing/types";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();

    // Case 1: Generate from audit report findings
    if (body.auditReport && body.findingIds) {
      const { auditReport, findingIds, letterType } = body as {
        auditReport: AuditReport;
        findingIds: string[];
        letterType?: DisputeLetterType;
      };

      if (!findingIds.length) {
        return NextResponse.json(
          { error: "At least one finding ID is required" },
          { status: 400 }
        );
      }

      const letter = generateDisputeLetter(auditReport, findingIds, letterType);

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

    return NextResponse.json(
      { error: "Invalid request — provide auditReport + findingIds, or type: 'itemized_request'" },
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
