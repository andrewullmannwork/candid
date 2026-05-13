/**
 * S74.5 D7 — Re-audit pipeline triggered on view fetch when a claim has
 * been marked `audit_status='stale'` (typically by D5 correct-category
 * endpoint or D6 resolve-conflict endpoint after a slug change).
 *
 * Per Subplan §4 + G3 LOCK:
 *   - Throttle: max 1 re-audit / minute per claim AND max 5 re-audits / day
 *     per claim. Throttle state persisted in claim.metadata for cross-request
 *     durability.
 *   - Reconstructs a ParsedBill from the persisted claim + claim_line_items
 *     and dispatches runAudit() so D13 zero-cost-share + D15 claim-header
 *     arithmetic + the existing ALL_RULES re-fire.
 *   - Writes refreshed findings back to claim_line_items.metadata.auditFindings
 *     and claim.metadata.auditSummary, clears the stale flag, and records the
 *     re-audit event in throttle state.
 *
 * Returns a result object so the API route can surface the outcome (or
 * skip silently in steady state).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { runAudit } from "./index";
import type {
  ParsedBill,
  BillLineItem,
  AuditFinding,
  ProcedureCodeType,
} from "../billing/types";
import { inferProcedureCodeType } from "../billing/code-type-inference";

const ONE_MINUTE_MS = 60 * 1000;
const DAILY_CAP = 5;

interface ClaimRow {
  id: string;
  user_id: string;
  source_document_id: string | null;
  date_of_service: string | null;
  total_billed: number | null;
  total_allowed: number | null;
  total_insurance_paid: number | null;
  total_patient_responsibility: number | null;
  metadata: Record<string, unknown> | null;
}

interface LineItemRow {
  id: string;
  line_number: number;
  billing_code: string | null;
  billing_code_type: string | null;
  service_slug: string | null;
  description: string | null;
  units: number | null;
  billed_amount: number | null;
  allowed_amount: number | null;
  insurance_paid: number | null;
  patient_owes: number | null;
  metadata: Record<string, unknown> | null;
}

export interface ReauditResult {
  reaudited: boolean;
  reason: string;
  newAuditSummary?: {
    totalFindings: number;
    totalEstimatedOvercharge: number;
    highSeverityCount: number;
    actionableCount: number;
  };
}

/**
 * If the claim is marked stale AND the per-claim throttle allows, re-run
 * the audit pipeline and persist refreshed findings. No-op otherwise.
 */
export async function maybeReauditClaim(
  supabase: SupabaseClient,
  claim: ClaimRow,
  lineItems: LineItemRow[],
): Promise<ReauditResult> {
  const meta = claim.metadata ?? {};
  const auditStatus = meta.audit_status as string | undefined;
  if (auditStatus !== "stale") {
    return { reaudited: false, reason: "not_stale" };
  }

  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const todayAudits = ((meta.re_audits_today as string[] | undefined) ?? []).filter(
    (t) => typeof t === "string" && t.startsWith(today),
  );
  const lastAt = meta.last_re_audit_at as string | undefined;

  if (todayAudits.length >= DAILY_CAP) {
    return { reaudited: false, reason: "throttle_daily_cap_5" };
  }
  if (lastAt) {
    const elapsed = now.getTime() - new Date(lastAt).getTime();
    if (elapsed >= 0 && elapsed < ONE_MINUTE_MS) {
      return {
        reaudited: false,
        reason: `throttle_per_minute (${Math.ceil((ONE_MINUTE_MS - elapsed) / 1000)}s remaining)`,
      };
    }
  }

  if (lineItems.length === 0) {
    return { reaudited: false, reason: "no_line_items" };
  }

  const parsedBill = reconstructParsedBill(claim, lineItems);
  const auditReport = await runAudit(parsedBill);

  // Group findings by line_number for per-row metadata writes.
  const findingsByLine = new Map<number, AuditFinding[]>();
  for (const f of auditReport.findings) {
    for (const ln of f.lineItems) {
      if (!findingsByLine.has(ln)) findingsByLine.set(ln, []);
      findingsByLine.get(ln)!.push(f);
    }
  }

  // Write refreshed findings into each line item's metadata.auditFindings.
  // Lines that previously had findings but no longer match keep their
  // existing metadata SHAPE but receive an empty auditFindings array so
  // stale findings don't render.
  const writes = lineItems.map(async (li) => {
    const liMeta = li.metadata ?? {};
    const findings = findingsByLine.get(li.line_number) ?? [];
    return supabase
      .from("claim_line_items")
      .update({
        metadata: {
          ...liMeta,
          auditFindings: findings.map((f) => ({
            id: f.id,
            type: f.type,
            severity: f.severity,
            estimatedOvercharge: f.estimatedOvercharge,
            title: f.title,
            actionable: f.actionable,
          })),
        },
      })
      .eq("id", li.id);
  });
  await Promise.allSettled(writes);

  // Clear stale flag + record throttle state on claim. Status flips to
  // 'flagged' or 'processed' based on whether any findings remain.
  todayAudits.push(now.toISOString());
  const nextStatus = auditReport.findings.length > 0 ? "flagged" : "processed";
  await supabase
    .from("claims")
    .update({
      metadata: {
        ...meta,
        audit_status: "fresh",
        audit_refreshed_at: now.toISOString(),
        last_re_audit_at: now.toISOString(),
        re_audits_today: todayAudits,
        auditSummary: auditReport.summary,
      },
      status: nextStatus,
    })
    .eq("id", claim.id);

  return {
    reaudited: true,
    reason: "ok",
    newAuditSummary: auditReport.summary,
  };
}

/**
 * Reconstruct a ParsedBill shape from the persisted claims row + line
 * items so runAudit can re-execute. We don't have the original raw OCR
 * text in the claims row (lives on documents); audit rules don't need it
 * — they consume codes + amounts.
 */
function reconstructParsedBill(claim: ClaimRow, lineItems: LineItemRow[]): ParsedBill {
  const claimMeta = claim.metadata ?? {};
  const billType =
    (claimMeta.billType as ParsedBill["billType"] | undefined) ?? "itemized_bill";
  const providerMeta = (claimMeta.provider as Record<string, unknown> | null) ?? {};
  const patientMeta = (claimMeta.patient as Record<string, unknown> | null) ?? {};
  const insurerMeta = (claimMeta.insurer as Record<string, unknown> | null) ?? null;

  const bills: BillLineItem[] = lineItems.map((li) => {
    const code = li.billing_code ?? "";
    // Code type column on claim_line_items is the LEGACY namespace; the
    // billing_code_identity table uses the new ProcedureCodeType namespace.
    // Run the D0 inference so D13 + downstream consumers see the right
    // type even if the column stored a legacy variant.
    const codeType: ProcedureCodeType | undefined =
      (li.billing_code_type as ProcedureCodeType | null) ??
      inferProcedureCodeType(code);
    return {
      lineNumber: li.line_number,
      procedureCode: code,
      procedureCodeType: codeType,
      description: li.description ?? "Medical service",
      category: li.service_slug ?? "Medical Service",
      serviceDate: claim.date_of_service ?? new Date().toISOString().slice(0, 10),
      quantity: Number(li.units ?? 1),
      billedAmount: Number(li.billed_amount ?? 0),
      allowedAmount: li.allowed_amount != null ? Number(li.allowed_amount) : undefined,
      insurancePaid: li.insurance_paid != null ? Number(li.insurance_paid) : undefined,
      patientResponsibility:
        li.patient_owes != null ? Number(li.patient_owes) : undefined,
    };
  });

  return {
    id: claim.id,
    documentId: claim.source_document_id ?? "",
    userId: claim.user_id,
    billType,
    provider: {
      name: (providerMeta.name as string | undefined) ?? "Unknown Provider",
      npi: providerMeta.npi as string | undefined,
      address: providerMeta.address as string | undefined,
    },
    patient: {
      name: (patientMeta.name as string | undefined) ?? "Unknown",
      memberId: patientMeta.memberId as string | undefined,
      groupNumber: patientMeta.groupNumber as string | undefined,
    },
    insurer: insurerMeta
      ? {
          name: (insurerMeta.name as string | undefined) ?? "",
          planName: insurerMeta.planName as string | undefined,
          accountNumber: insurerMeta.accountNumber as string | undefined,
        }
      : undefined,
    serviceDate: claim.date_of_service ?? new Date().toISOString().slice(0, 10),
    lineItems: bills,
    totals: {
      totalBilled: Number(claim.total_billed ?? 0),
      totalAllowed:
        claim.total_allowed != null ? Number(claim.total_allowed) : undefined,
      totalInsurancePaid:
        claim.total_insurance_paid != null
          ? Number(claim.total_insurance_paid)
          : undefined,
      totalPatientResponsibility:
        claim.total_patient_responsibility != null
          ? Number(claim.total_patient_responsibility)
          : undefined,
    },
    rawText: "",
    confidence: 0.85,
    parseErrors: [],
  };
}
