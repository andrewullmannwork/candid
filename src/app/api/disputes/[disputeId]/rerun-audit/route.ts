/**
 * POST /api/disputes/[disputeId]/rerun-audit
 *
 * Replaces the legacy "/upload" CTA in EvidenceGaps for the
 * `audit_findings_missing` gap. Re-runs the audit engine against the
 * existing claim's persisted line items and updates
 * `claim_line_items.metadata.auditFindings` in place — no OCR re-parse,
 * no document re-upload. The /disputes page refetches on focus + on the
 * client-side success callback, so the regenerated letter picks up the
 * fresh findings.
 *
 * Auth: Firebase bearer token. Verifies the dispute belongs to the user.
 */

import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth } from "@/lib/firebase/admin";
import { createServerClient } from "@/lib/supabase/server";
import {
  userScoped,
  selectOwnedChildren,
  updateOwnedChildren,
} from "@/lib/security/user-scoped";
import { runAudit } from "@/lib/audit";
import { refreshClaimLevelFindings } from "@/lib/audit/reaudit";
import type { ParsedBill } from "@/lib/billing/types";

async function getAuthUser(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  try {
    return await getAdminAuth().verifyIdToken(authHeader.slice(7));
  } catch {
    return null;
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ disputeId: string }> },
) {
  const decoded = await getAuthUser(req);
  if (!decoded) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { disputeId } = await params;
  const supabase = createServerClient();

  const { data: user } = await supabase
    .from("users")
    .select("id")
    .eq("firebase_uid", decoded.uid)
    .single();

  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  const { data: dispute } = await userScoped(supabase, user.id)
    .table("dispute_outcomes")
    .select("id, claim_id, user_id")
    .eq("id", disputeId)
    .maybeSingle();

  if (!dispute || !dispute.claim_id) {
    return NextResponse.json({ error: "Dispute or linked claim not found" }, { status: 404 });
  }

  const { data: claim } = await userScoped(supabase, user.id)
    .table("claims")
    .select("id, source_document_id, date_of_service, total_billed, total_allowed, total_insurance_paid, total_patient_responsibility, metadata, user_id, insurance_plan_id")
    .eq("id", dispute.claim_id)
    .maybeSingle();

  if (!claim) {
    return NextResponse.json({ error: "Claim not found" }, { status: 404 });
  }

  const lineItems = (
    await selectOwnedChildren(
      supabase,
      user.id,
      "claim_line_items",
      [claim.id as string],
      "id, line_number, billing_code, description, units, billed_amount, allowed_amount, insurance_paid, patient_owes, modifier_codes, service_slug, billing_code_identity_id, metadata",
    )
  ).sort(
    (a, b) => ((a.line_number as number) ?? 0) - ((b.line_number as number) ?? 0),
  );

  if (!lineItems || lineItems.length === 0) {
    return NextResponse.json({ error: "Claim has no line items" }, { status: 400 });
  }

  const claimMetadata = (claim.metadata as Record<string, unknown> | null) ?? {};
  const provider = (claimMetadata.provider as { name?: string; npi?: string; address?: string } | undefined) ?? {};
  const patient = (claimMetadata.patient as { name?: string; memberId?: string } | undefined) ?? {};
  const insurer = (claimMetadata.insurer as { name?: string; planName?: string } | undefined) ?? {};
  const billType = (claimMetadata.billType as "eob" | "itemized_bill" | undefined) ?? "eob";

  // Reconstruct a ParsedBill from the persisted claim + line items so the
  // audit engine can run without re-parsing OCR text. Audit rules read
  // procedureCode / billedAmount / quantity / modifier — all of which we
  // already have on claim_line_items.
  const parsedBill: ParsedBill = {
    id: claim.id,
    documentId: claim.source_document_id ?? "",
    userId: user.id,
    billType,
    provider: {
      name: provider.name ?? "Unknown",
      npi: provider.npi,
      address: provider.address,
    },
    patient: {
      name: patient.name ?? "",
      memberId: patient.memberId,
    },
    insurer: insurer.name ? { name: insurer.name, planName: insurer.planName } : undefined,
    serviceDate: claim.date_of_service ?? "",
    lineItems: lineItems.map((li) => ({
      lineNumber: li.line_number,
      procedureCode: li.billing_code ?? "",
      description: li.description ?? "",
      category: li.service_slug ?? "",
      serviceDate: claim.date_of_service ?? "",
      quantity: li.units ?? 1,
      billedAmount: Number(li.billed_amount ?? 0),
      allowedAmount: li.allowed_amount != null ? Number(li.allowed_amount) : undefined,
      insurancePaid: li.insurance_paid != null ? Number(li.insurance_paid) : undefined,
      patientResponsibility: li.patient_owes != null ? Number(li.patient_owes) : undefined,
      modifier: Array.isArray(li.modifier_codes) && li.modifier_codes.length > 0
        ? (li.modifier_codes[0] as string)
        : undefined,
    })),
    totals: {
      totalBilled: Number(claim.total_billed ?? 0),
      totalAllowed: claim.total_allowed != null ? Number(claim.total_allowed) : undefined,
      totalInsurancePaid: claim.total_insurance_paid != null ? Number(claim.total_insurance_paid) : undefined,
      totalPatientResponsibility: claim.total_patient_responsibility != null
        ? Number(claim.total_patient_responsibility)
        : undefined,
    },
    rawText: "",
    confidence: 1,
    parseErrors: [],
  };

  // S74.6 §C.1 — thread persisted service_slug + billing_code_identity_id
  // onto bill.lineItems so the audit pipeline can build per-slug cohort keys
  // + D4 description-match skips already-categorized lines. Dispute rerun
  // doesn't re-resolve; persisted values are authoritative.
  const { applyPersistedSlugs } = await import("@/lib/claims/preflight-slug-resolver");
  applyPersistedSlugs(
    parsedBill,
    lineItems.map((li) => ({
      line_number: li.line_number,
      service_slug: li.service_slug,
      billing_code_identity_id:
        (li as { billing_code_identity_id?: string | null }).billing_code_identity_id ?? null,
    })),
  );

  // F-2 — load plan coverage so missing_adjustment + insurance_underpayment
  // rules can compute should_owe against plan terms.
  const { loadAcaFallbackForAudit, loadCoverageMapForPlan } = await import("@/lib/audit/coverage-loader");
  const planIdForAudit =
    (claim as { insurance_plan_id?: string | null }).insurance_plan_id ?? null;
  const planCoverage = await loadCoverageMapForPlan(supabase, planIdForAudit);

  // S74.6 D2 §B — ACA fallback for dispute-rerun audit. Mirrors process-chunk
  // + reaudit pattern: bySlug merged INTO planCoverage; byLineNumber threaded
  // parallel so ACA-mandated lines with no slug still get should_owe=0.
  const acaFallback = await loadAcaFallbackForAudit({
    supabase,
    planId: planIdForAudit,
    userId: claim.user_id as string,
    patientName: patient.name ?? null,
    bill: parsedBill,
    existingCoverageBySlug: new Set(planCoverage?.keys() ?? []),
  });
  const mergedPlanCoverage = planCoverage ?? new Map();
  for (const [slug, cov] of acaFallback.bySlug) {
    if (!mergedPlanCoverage.has(slug)) mergedPlanCoverage.set(slug, cov);
  }

  // S74.6 D3 §C.2 — thread insurer_name for cohort accuracy adjustment on
  // dispute-rerun path (S87 left this site passing no insurerName).
  let insurerNameForAudit: string | null = null;
  if (planIdForAudit) {
    const { data: planRow } = await userScoped(supabase, user.id)
      .table("insurance_plans")
      .select("insurer_name")
      .eq("id", planIdForAudit)
      .maybeSingle();
    insurerNameForAudit = (planRow?.insurer_name as string | null) ?? null;
  }

  const report = await runAudit(
    parsedBill,
    mergedPlanCoverage.size > 0 ? mergedPlanCoverage : null,
    { insurerName: insurerNameForAudit },
    acaFallback.byLineNumber,
  );

  // Group findings by line_number so we can write them back to the matching
  // claim_line_items row. A single finding may flag multiple lines (e.g.,
  // unbundling) — copy it to each line it references.
  const findingsByLine = new Map<number, typeof report.findings>();
  for (const f of report.findings) {
    for (const ln of f.lineItems) {
      const arr = findingsByLine.get(ln) ?? [];
      arr.push(f);
      findingsByLine.set(ln, arr);
    }
  }

  // Update claim_line_items.metadata.auditFindings in place. Match the
  // shape used at upload time in src/lib/claims/persist.ts so downstream
  // consumers (evidence-resolver, dispute templates) see the same fields.
  const lineItemUpdates = lineItems.map((li) => {
    const findings = findingsByLine.get(li.line_number) ?? [];
    const existingMeta = (li.metadata as Record<string, unknown> | null) ?? {};
    return {
      id: li.id as string,
      values: {
        metadata: {
          ...existingMeta,
          auditFindings: findings.map((f) => ({
            id: f.id,
            type: f.type,
            severity: f.severity,
            estimatedOvercharge: f.estimatedOvercharge,
            title: f.title,
            actionable: f.actionable,
            // R3 step 5.2 — removal-dominates flag for the dispute recovery's SET tier (see
            // claims/persist.ts). Mirrors the upload-time write so re-audited claims stay correct.
            removed: (f.removedLineNumbers ?? []).includes(li.line_number as number),
          })),
          auditRerunAt: new Date().toISOString(),
        },
      },
    };
  });
  const { updated: updatedCount } = await updateOwnedChildren(
    supabase,
    user.id,
    "claim_line_items",
    claim.id as string,
    lineItemUpdates,
  );

  // R3 step 5.1 — also refresh claim.metadata.auditSummary.claimLevelFindings (claim-header
  // findings like unallocated_balance). The dispute recovery's CLAIM tier reads these; without
  // this they go stale after a dispute re-audit. Same helper + dismissal-preservation as the
  // GET-path reaudit (refreshClaimLevelFindings) so the two persist paths cannot drift.
  const priorClaimLevel =
    (claimMetadata.auditSummary as
      | { claimLevelFindings?: Array<{ type?: string; estimatedOvercharge?: number; dismissed?: boolean; dismissed_at?: string; dismissed_reason?: string; dismissed_note?: string | null }> }
      | undefined)?.claimLevelFindings ?? [];
  await userScoped(supabase, user.id)
    .table("claims")
    .update({
      metadata: {
        ...claimMetadata,
        auditSummary: {
          ...report.summary,
          claimLevelFindings: refreshClaimLevelFindings(report.summary.claimLevelFindings, priorClaimLevel),
        },
      },
    })
    .eq("id", claim.id as string);

  console.log("[disputes/rerun-audit] complete", {
    disputeId: dispute.id,
    claimId: claim.id,
    findingsTotal: report.findings.length,
    lineItemsUpdated: updatedCount,
  });

  return NextResponse.json({
    ok: true,
    findingsCount: report.findings.length,
    lineItemsUpdated: updatedCount,
    summary: report.summary,
  });
}
