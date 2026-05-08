// POST /api/disputes/generate
// Generates a dispute letter from an audit report's findings
// Optionally enriches with plan benefit evidence when insurancePlanId is provided

import { NextRequest, NextResponse } from "next/server";
import { generateDisputeLetter, generateItemizedBillRequest } from "@/lib/disputes";
import type { PlanBenefitEvidence } from "@/lib/disputes";
import { resolvePlanContext } from "@/lib/disputes/plan-context";
import { resolveEvidence } from "@/lib/disputes/evidence-resolver";
import { persistDisputeLetter } from "@/lib/disputes/persist";
import { createServerClient } from "@/lib/supabase/server";
import { reparseField } from "@/lib/plan/reparse-field";
import { loadDecorationContext } from "@/lib/plan/analyze-decoration";
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

      const supabase = createServerClient();

      // Phase 1: resolve plan context — insurer name + appeals address from
      // the user's plan matching the bill's date of service.
      let planContext = null;
      try {
        planContext = await resolvePlanContext(supabase, {
          userId: auditReport.userId,
          claimId: body.claimId ?? null,
          dateOfService: auditReport.parsedBill.serviceDate ?? null,
        });
      } catch (err) {
        console.error("[disputes] plan-context resolve failed (non-fatal):", err);
      }

      // Phase 4: resolve structured evidence for the "Why this should be
      // covered" letter block.
      let evidence = null;
      try {
        const claimIds = body.claimId ? [body.claimId as string] : [];
        const lineItemIds = (body.claimLineItemIds as string[] | undefined) ?? undefined;
        if (claimIds.length > 0) {
          evidence = await resolveEvidence(supabase, {
            userId: auditReport.userId,
            claimIds,
            lineItemIds,
            planContext,
            letterType: letterType ?? "overcharge",
            // disputeId not yet known at generate time (persistDisputeLetter
            // runs below). The /api/disputes/[disputeId] GET path re-resolves
            // evidence with the correct disputeId on first load, so any
            // returnTo URLs in EvidenceGaps fix themselves on next fetch.
          });
        }
      } catch (err) {
        console.error("[disputes] evidence resolve failed (non-fatal):", err);
      }

      // CF-20 (Session 73, S71) — cite-grade re-parse-on-flag for dispute letters.
      //
      // Per Display State v3, per-service rows whose `planBenefit.sbcExcerptVerified
      // === false` had Haiku miss the verbatim or fail section verification.
      // Without re-parse, the letter falls into Q-DR-4E-2 LOCK Case 2 (bullet,
      // no blockquote) — losing the strongest dispute signal. CF-20 dispatches
      // a targeted Haiku re-parse on un-searched sections for each affected row;
      // if the re-parse upgrades the row to cite-grade, evidence is re-resolved
      // and the letter ships with the verbatim blockquote (Case 1). If re-parse
      // fails or the cost cap is hit, the letter still generates as before
      // (graceful degradation).
      //
      // Bounded by reparseField's existing cost caps (per-reparse + per-plan
      // daily; admin-tunable via consumer_read_filter_v1.config). Only fires
      // when the consumer-read filter flag is on (gate evaluated below).
      if (evidence && planContext?.plan?.id) {
        try {
          const { isFeatureEnabled: isFlagEnabledForReparse } = await import("@/lib/config/product-flags");
          const flagOn = await isFlagEnabledForReparse("consumer_read_filter_v1");
          if (flagOn) {
            const planIdForReparse: string = planContext.plan.id;
            // Collect distinct (serviceSlug, fieldName) tuples from no-cite rows.
            // Per evidence-resolver primaryField logic: in_copay when copay non-null;
            // else in_coinsurance. Q-P3.2.1-5 LOCK ensures the row's patternP8 is
            // shared, so re-parsing one cost-sharing field upgrades the entire row.
            const targets = new Map<string, { serviceSlug: string; fieldName: string }>();
            for (const claim of evidence.claims) {
              for (const li of claim.lineItemEvidence) {
                if (
                  li.planBenefit &&
                  !li.planBenefit.sbcExcerptVerified &&
                  li.serviceSlug
                ) {
                  const fieldName = li.planBenefit.copay !== null ? "in_copay" : "in_coinsurance";
                  const key = `${li.serviceSlug}|${fieldName}`;
                  if (!targets.has(key)) {
                    targets.set(key, { serviceSlug: li.serviceSlug, fieldName });
                  }
                }
              }
            }

            if (targets.size > 0) {
              const { data: userRow } = await supabase
                .from("users")
                .select("email")
                .eq("id", auditReport.userId)
                .single();
              const decoration = await loadDecorationContext(
                supabase,
                userRow?.email ?? null,
                { canonical_plan_id: planContext.plan.canonicalPlanId ?? null },
              );
              if (decoration) {
                const reparseResults = await Promise.allSettled(
                  Array.from(targets.values()).map((t) =>
                    reparseField(
                      supabase,
                      auditReport.userId,
                      { planId: planIdForReparse, fieldName: t.fieldName, serviceSlug: t.serviceSlug },
                      decoration,
                    ),
                  ),
                );
                const upgrades = reparseResults.filter(
                  (r) => r.status === "fulfilled" && r.value.success,
                ).length;
                console.log(
                  `[disputes] CF-20 re-parse-on-flag: ${targets.size} target(s), ${upgrades} upgraded to cite-grade`,
                );
                if (upgrades > 0) {
                  // Re-resolve evidence so the letter sees the upgraded rows.
                  try {
                    const claimIds = body.claimId ? [body.claimId as string] : [];
                    const lineItemIds = (body.claimLineItemIds as string[] | undefined) ?? undefined;
                    if (claimIds.length > 0) {
                      evidence = await resolveEvidence(supabase, {
                        userId: auditReport.userId,
                        claimIds,
                        lineItemIds,
                        planContext,
                        letterType: letterType ?? "overcharge",
                      });
                    }
                  } catch (reErr) {
                    console.error(
                      "[disputes] CF-20 evidence re-resolve failed (non-fatal):",
                      reErr,
                    );
                  }
                }
              }
            }
          }
        } catch (cf20Err) {
          // Non-fatal — letter still generates with original evidence.
          console.error("[disputes] CF-20 re-parse-on-flag failed (non-fatal):", cf20Err);
        }
      }

      // Fetch plan benefit evidence if insurancePlanId provided (legacy path)
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

      // Phase 4 Task 4-E: when consumer_read_filter_v1 flag is ON, gate
      // letter blockquote rendering by Pattern P-8 cite-grade verification
      // (3-case logic in templates.ts per Q-DR-4E-2 LOCK). Reads flag once
      // per request — userEmail is unavailable here (auditReport.userId is
      // a firebase_uid), so flag falls back to global-only evaluation, which
      // matches the production rollout sequence (admin-only soak via target_users
      // in feature_flag_rules; otherwise global).
      const { isFeatureEnabled: isFlagEnabled } = await import("@/lib/config/product-flags");
      const gateUnverified = await isFlagEnabled("consumer_read_filter_v1");

      const letter = generateDisputeLetter(auditReport, findingIds, letterType, {
        planEvidence,
        planContext,
        evidence,
        gateUnverified,
      });

      // Persist dispute to database (feature-flagged)
      let disputeId: string | null = null;
      let deduplicated = false;
      try {
        const { isFeatureEnabled } = await import("@/lib/config/product-flags");
        const disputeTrackingEnabled = await isFeatureEnabled("dispute_tracking");
        if (!disputeTrackingEnabled) throw new Error("feature_disabled");

        const selectedFindings = auditReport.findings.filter((f) => findingIds.includes(f.id));
        const totalDisputed = selectedFindings.reduce((sum, f) => sum + f.estimatedOvercharge, 0);

        const result = await persistDisputeLetter(supabase, {
          userId: auditReport.userId,
          claimId: body.claimId || undefined,
          claimLineItemIds: body.claimLineItemIds || undefined,
          letterType: letterType || "overcharge",
          amountDisputed: totalDisputed,
          letterContent: letter.body,
        });
        disputeId = result?.disputeId || null;
        deduplicated = result?.deduplicated ?? false;
      } catch (err) {
        if (err instanceof Error && err.message !== "feature_disabled") {
          console.error("[disputes] Failed to persist dispute (non-fatal):", err);
        }
      }

      return NextResponse.json({
        success: true,
        letter,
        disputeId,
        deduplicated,
        missingPlanForYear: planContext?.missingForYear ?? null,
      });
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
