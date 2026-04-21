/**
 * GET /api/claims — Fetch user's claims with summary stats.
 * Returns paginated claims with line item counts, totals, and finding counts.
 * Auth: Firebase bearer token.
 */

import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth } from "@/lib/firebase/admin";
import { createServerClient } from "@/lib/supabase/server";
import {
  computeRecovery,
  resolveStillOutstanding,
  type PlanCoverageInput,
} from "@/lib/claims/recovery-math";

async function getAuthUser(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  try {
    return await getAdminAuth().verifyIdToken(authHeader.slice(7));
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest) {
  const decoded = await getAuthUser(req);
  if (!decoded) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createServerClient();

  // Resolve user_id from firebase_uid
  const { data: user } = await supabase
    .from("users")
    .select("id")
    .eq("firebase_uid", decoded.uid)
    .single();

  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  const page = parseInt(req.nextUrl.searchParams.get("page") || "1", 10);
  const limit = Math.min(parseInt(req.nextUrl.searchParams.get("limit") || "20", 10), 50);
  const offset = (page - 1) * limit;

  // Fetch claims with pagination
  const { data: claims, error, count } = await supabase
    .from("claims")
    .select("*", { count: "exact" })
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Collect coverage maps per insurance_plan_id so we can derive "should owe"
  // and potential recovery per line without running N+1 queries.
  const planIds = Array.from(
    new Set(
      (claims || [])
        .map((c) => c.insurance_plan_id as string | null)
        .filter((id): id is string => !!id),
    ),
  );
  const coveragePerPlan = new Map<string, Map<string, PlanCoverageInput>>();
  if (planIds.length > 0) {
    const { data: coveredServices } = await supabase
      .from("plan_covered_services")
      .select("insurance_plan_id, covered, in_copay, in_coinsurance, service_catalog!inner(slug)")
      .in("insurance_plan_id", planIds);
    for (const svc of coveredServices || []) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const slug = (svc.service_catalog as any)?.slug as string | undefined;
      const planId = svc.insurance_plan_id as string | undefined;
      if (!slug || !planId) continue;
      if (!coveragePerPlan.has(planId)) coveragePerPlan.set(planId, new Map());
      coveragePerPlan.get(planId)!.set(slug, {
        covered: svc.covered,
        copay: svc.in_copay,
        coinsurance: svc.in_coinsurance,
      });
    }
  }

  // For each claim, get line item summary + top findings + potential savings + recovery
  const claimsWithSummary = await Promise.all(
    (claims || []).map(async (claim) => {
      const { data: lineItems } = await supabase
        .from("claim_line_items")
        .select("id, service_slug, billing_code, metadata, billed_amount, patient_owes, insurance_paid, description, amount_still_outstanding")
        .eq("claim_id", claim.id);

      const items = lineItems || [];
      const coverageMap =
        claim.insurance_plan_id && coveragePerPlan.get(claim.insurance_plan_id as string);
      const claimTotalBilled = Number(claim.total_billed || 0);
      const claimStillOutstanding =
        claim.amount_still_outstanding != null
          ? Number(claim.amount_still_outstanding)
          : claim.total_patient_responsibility != null
            ? Number(claim.total_patient_responsibility)
            : null;

      let findingCount = 0;
      let potentialSavings = 0;
      let reviewNeededCount = 0;
      let lineItemPatientOwedSum = 0;
      let claimPotentialRecovery = 0;
      let claimAlreadyPaid = 0;
      let claimShouldOwe = 0;
      let claimRefund = 0;
      let claimForgiveness = 0;
      const topFindings: Array<{ title: string; estimatedOvercharge: number; billingCode?: string | null }> = [];
      const reviewLineItems: Array<{
        id: string;
        description: string | null;
        billing_code: string | null;
        service_slug: string | null;
        billed_amount: number | null;
      }> = [];

      for (const item of items) {
        const findings = (item.metadata as Record<string, unknown>)?.auditFindings;
        if (Array.isArray(findings)) {
          findingCount += findings.length;
          for (const f of findings as Array<Record<string, unknown>>) {
            const overcharge = Number(f.estimatedOvercharge || 0);
            potentialSavings += overcharge;
            topFindings.push({
              title: String(f.title || f.type || "Issue"),
              estimatedOvercharge: overcharge,
              billingCode: item.billing_code,
            });
          }
        }

        const billed = Number(item.billed_amount || 0);
        const paid = Number(item.insurance_paid || 0);
        const owed = Number(item.patient_owes || 0);

        // Recovery metrics — uses new amount_still_outstanding column when
        // present, falls back to pro-rating claim header by billed share.
        const coverage = (item.service_slug && coverageMap?.get(item.service_slug)) || null;
        const stillOutstanding = resolveStillOutstanding({
          lineBilled: billed,
          lineStillOutstanding: item.amount_still_outstanding != null ? Number(item.amount_still_outstanding) : null,
          linePatientOwes: owed,
          claimTotalBilled,
          claimStillOutstanding,
        });
        const rec = computeRecovery(billed, stillOutstanding, coverage);
        claimPotentialRecovery += rec.potentialRecovery;
        claimAlreadyPaid += rec.alreadyPaid;
        claimShouldOwe += rec.shouldOwe;
        claimRefund += rec.refundComponent;
        claimForgiveness += rec.forgivenessComponent;

        if (billed > 0 && paid === 0 && owed === 0) {
          reviewNeededCount++;
          reviewLineItems.push({
            id: item.id,
            description: item.description,
            billing_code: item.billing_code,
            service_slug: item.service_slug,
            billed_amount: item.billed_amount,
          });
        }
        lineItemPatientOwedSum += owed;
      }

      // Keep top 3 findings by overcharge size
      topFindings.sort((a, b) => b.estimatedOvercharge - a.estimatedOvercharge);

      // Header-only fallback: if no line items were extracted but the claim
      // header has totals, derive claim-level recovery from those so the
      // UI still surfaces a meaningful Potential Recovery number.
      let recoveryBlock;
      if (items.length === 0 && claimTotalBilled > 0) {
        const stillOutstanding = claimStillOutstanding ?? 0;
        const alreadyPaid = Math.max(0, claimTotalBilled - stillOutstanding);
        const shouldOwe = 0;
        const potentialRecovery = Math.max(0, claimTotalBilled - shouldOwe);
        recoveryBlock = {
          billed: claimTotalBilled,
          alreadyPaid,
          stillOutstanding,
          shouldOwe,
          potentialRecovery,
          refundComponent: Math.max(0, alreadyPaid - shouldOwe),
          forgivenessComponent: Math.max(0, stillOutstanding - shouldOwe),
        };
      } else {
        recoveryBlock = {
          billed: claimTotalBilled,
          alreadyPaid: claimAlreadyPaid,
          stillOutstanding:
            claimStillOutstanding != null
              ? claimStillOutstanding
              : items.reduce((s, it) => s + Number(it.amount_still_outstanding || 0), 0),
          shouldOwe: claimShouldOwe,
          potentialRecovery: claimPotentialRecovery,
          refundComponent: claimRefund,
          forgivenessComponent: claimForgiveness,
        };
      }

      return {
        ...claim,
        lineItemCount: items.length,
        findingCount,
        reviewNeededCount,
        reviewLineItems,
        potentialSavings,
        lineItemPatientOwedSum,
        topFindings: topFindings.slice(0, 3),
        providerName: (claim.metadata as Record<string, unknown>)?.provider
          ? ((claim.metadata as Record<string, unknown>).provider as Record<string, unknown>)?.name || "Unknown Provider"
          : "Unknown Provider",
        recovery: recoveryBlock,
      };
    })
  );

  // Summary stats (computed across all user claims, not just paginated)
  const { data: allClaims } = await supabase
    .from("claims")
    .select("id, status, total_billed, total_patient_responsibility")
    .eq("user_id", user.id);

  // Aggregate potential savings across all claims' line items.
  // "Issues flagged" = classic audit findings + unverified-charge review cases.
  let totalPotentialSavings = 0;
  let totalIssuesFlagged = 0;
  if (allClaims && allClaims.length > 0) {
    const { data: allLineItems } = await supabase
      .from("claim_line_items")
      .select("metadata, claim_id, billed_amount, insurance_paid, patient_owes")
      .in("claim_id", allClaims.map((c) => c.id));

    for (const li of allLineItems || []) {
      const findings = (li.metadata as Record<string, unknown>)?.auditFindings;
      if (Array.isArray(findings)) {
        for (const f of findings as Array<Record<string, unknown>>) {
          totalPotentialSavings += Number(f.estimatedOvercharge || 0);
          totalIssuesFlagged += 1;
        }
      }
      // Also count unexplained-gap lines (billed > 0, paid + owed = 0)
      const billed = Number(li.billed_amount || 0);
      const paid = Number(li.insurance_paid || 0);
      const owed = Number(li.patient_owes || 0);
      if (billed > 0 && paid === 0 && owed === 0) {
        totalIssuesFlagged += 1;
      }
    }
  }

  // Roll up paginated claims' recovery figures into a stats block so the
  // ClaimImpactHero can surface "Potential Recovery" as the headline metric
  // without re-computing.
  const totalPotentialRecovery = claimsWithSummary.reduce((s, c) => s + (c.recovery?.potentialRecovery || 0), 0);
  const totalRefundComponent = claimsWithSummary.reduce((s, c) => s + (c.recovery?.refundComponent || 0), 0);
  const totalForgivenessComponent = claimsWithSummary.reduce((s, c) => s + (c.recovery?.forgivenessComponent || 0), 0);
  const totalAlreadyPaid = claimsWithSummary.reduce((s, c) => s + (c.recovery?.alreadyPaid || 0), 0);

  const stats = {
    totalBills: allClaims?.length || 0,
    flaggedBills: allClaims?.filter((c) => c.status === "flagged").length || 0,
    totalBilled: allClaims?.reduce((sum, c) => sum + (c.total_billed || 0), 0) || 0,
    totalPatientResponsibility: allClaims?.reduce((sum, c) => sum + (c.total_patient_responsibility || 0), 0) || 0,
    totalPotentialSavings,
    totalIssuesFlagged,
    totalPotentialRecovery,
    totalRefundComponent,
    totalForgivenessComponent,
    totalAlreadyPaid,
  };

  return NextResponse.json({
    claims: claimsWithSummary,
    stats,
    pagination: { page, limit, total: count || 0 },
  });
}
