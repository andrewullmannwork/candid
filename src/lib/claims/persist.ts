/**
 * Claims Persistence — saves audit results to the claims and claim_line_items tables.
 *
 * When a user uploads an EOB or itemized bill, the audit engine runs and produces
 * findings. This module persists those results so the user can track their billing
 * history, disputes, and recovery over time.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { ParsedBill, AuditReport, AuditFinding } from "@/lib/billing/types";

export interface PersistClaimResult {
  claimId: string;
  lineItemIds: string[];
}

/**
 * Save a parsed bill and its audit findings to the database.
 * Creates a claims row + claim_line_items, tagging line items with finding metadata.
 */
export async function persistAuditResults(
  supabase: SupabaseClient,
  params: {
    userId: string;
    insurancePlanId?: string;
    documentId: string;
    parsedBill: ParsedBill;
    auditReport: AuditReport;
  }
): Promise<PersistClaimResult | null> {
  const { userId, insurancePlanId, documentId, parsedBill, auditReport } = params;

  try {
    // Insert claims row
    const { data: claim, error: claimError } = await supabase
      .from("claims")
      .insert({
        user_id: userId,
        insurance_plan_id: insurancePlanId || null,
        source_document_id: documentId,
        date_of_service: parsedBill.serviceDate || null,
        total_billed: parsedBill.totals.totalBilled,
        total_allowed: parsedBill.totals.totalAllowed || null,
        total_insurance_paid: parsedBill.totals.totalInsurancePaid || null,
        total_patient_responsibility: parsedBill.totals.totalPatientResponsibility || null,
        claim_number: null, // Not always present on bills
        status: auditReport.findings.length > 0 ? "flagged" : "processed",
        metadata: {
          billType: parsedBill.billType,
          provider: parsedBill.provider,
          patient: parsedBill.patient,
          insurer: parsedBill.insurer,
          auditSummary: auditReport.summary,
        },
      })
      .select("id")
      .single();

    if (claimError || !claim) {
      console.error("[claims-persist] Failed to insert claim:", claimError);
      return null;
    }

    // Build finding lookup: line number → finding metadata
    const findingsByLine = new Map<number, AuditFinding[]>();
    for (const finding of auditReport.findings) {
      for (const lineNum of finding.lineItems) {
        if (!findingsByLine.has(lineNum)) findingsByLine.set(lineNum, []);
        findingsByLine.get(lineNum)!.push(finding);
      }
    }

    // Insert claim_line_items
    const lineItemInserts = parsedBill.lineItems.map((item) => {
      const findings = findingsByLine.get(item.lineNumber) || [];
      const findingMeta = findings.length > 0
        ? {
            auditFindings: findings.map((f) => ({
              id: f.id,
              type: f.type,
              severity: f.severity,
              estimatedOvercharge: f.estimatedOvercharge,
              title: f.title,
              actionable: f.actionable,
            })),
          }
        : {};

      return {
        claim_id: claim.id,
        line_number: item.lineNumber,
        billing_code: item.procedureCode || null,
        billing_code_type: item.procedureCode ? (item.procedureCode.length === 5 ? "CPT" : "HCPCS") : null,
        service_slug: null, // Will be backfilled when we have code→service mapping
        description: item.description || item.category || null,
        units: item.quantity || 1,
        billed_amount: item.billedAmount,
        allowed_amount: item.allowedAmount || null,
        insurance_paid: item.insurancePaid || null,
        patient_owes: item.patientResponsibility || null,
        adjustment_reason_code: null,
        modifier_codes: item.modifier ? [item.modifier] : null,
        metadata: findingMeta,
      };
    });

    const lineItemIds: string[] = [];
    if (lineItemInserts.length > 0) {
      const { data: insertedItems, error: lineError } = await supabase
        .from("claim_line_items")
        .insert(lineItemInserts)
        .select("id");

      if (lineError) {
        console.error("[claims-persist] Failed to insert line items:", lineError);
      } else if (insertedItems) {
        for (const item of insertedItems) lineItemIds.push(item.id);
      }
    }

    console.log(`[claims-persist] Saved claim ${claim.id}: ${lineItemInserts.length} line items, ${auditReport.findings.length} findings`);

    return { claimId: claim.id, lineItemIds };
  } catch (err) {
    console.error("[claims-persist] Error:", err);
    return null;
  }
}
