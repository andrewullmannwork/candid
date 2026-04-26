/**
 * Claims Persistence — saves audit results to the claims and claim_line_items tables.
 *
 * When a user uploads an EOB or itemized bill, the audit engine runs and produces
 * findings. This module persists those results so the user can track their billing
 * history, disputes, and recovery over time.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { ParsedBill, AuditReport, AuditFinding } from "@/lib/billing/types";
import { mapLineItemsToServices, inferBillingCodeType } from "@/lib/claims/service-mapper";
import { isFeatureEnabled } from "@/lib/config/product-flags";
import { notifyUnmappedLineItems } from "@/lib/notifications";

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
    planYear?: number | null;
    documentId: string;
    parsedBill: ParsedBill;
    auditReport: AuditReport;
  }
): Promise<PersistClaimResult | null> {
  const { userId, insurancePlanId, planYear, documentId, parsedBill, auditReport } = params;

  try {
    // Resolve plan year if not provided — fall back to the linked plan, then DOS year.
    let resolvedPlanYear: number | null = planYear ?? null;
    if (resolvedPlanYear == null && insurancePlanId) {
      const { data: plan } = await supabase
        .from("insurance_plans")
        .select("plan_year")
        .eq("id", insurancePlanId)
        .maybeSingle();
      resolvedPlanYear = plan?.plan_year ?? null;
    }
    if (resolvedPlanYear == null && parsedBill.serviceDate) {
      const m = parsedBill.serviceDate.match(/^(\d{4})/);
      if (m) resolvedPlanYear = parseInt(m[1], 10);
    }

    // Insert claims row
    const { data: claim, error: claimError } = await supabase
      .from("claims")
      .insert({
        user_id: userId,
        insurance_plan_id: insurancePlanId || null,
        plan_year: resolvedPlanYear,
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

    // Map line item descriptions → service slugs via Haiku (feature-flagged)
    const serviceMappingEnabled = await isFeatureEnabled("billing_code_service_mapping");
    const serviceMappings = new Map<number, { slug: string; confidence: number }>();

    if (serviceMappingEnabled && parsedBill.lineItems.length > 0) {
      try {
        const mappings = await mapLineItemsToServices(
          parsedBill.lineItems.map((item) => ({
            lineNumber: item.lineNumber,
            description: item.description || item.category || "",
            billingCode: item.procedureCode || undefined,
            billingCodeType: item.procedureCode ? inferBillingCodeType(item.procedureCode) : undefined,
            category: item.category || undefined,
          }))
        );
        for (const m of mappings) {
          if (m.confidence >= 0.3) {
            serviceMappings.set(m.lineNumber, { slug: m.serviceSlug, confidence: m.confidence });
          }
        }
        console.log(`[claims-persist] Mapped ${serviceMappings.size}/${parsedBill.lineItems.length} line items to service slugs`);
      } catch (err) {
        console.error("[claims-persist] Service mapping failed (non-blocking):", err);
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

      const mapping = serviceMappings.get(item.lineNumber);

      return {
        claim_id: claim.id,
        line_number: item.lineNumber,
        billing_code: item.procedureCode || null,
        billing_code_type: item.procedureCode ? inferBillingCodeType(item.procedureCode) : null,
        service_slug: mapping?.slug || null,
        description: item.description || item.category || null,
        units: item.quantity || 1,
        billed_amount: item.billedAmount,
        allowed_amount: item.allowedAmount || null,
        insurance_paid: item.insurancePaid || null,
        patient_owes: item.patientResponsibility || null,
        plan_year: resolvedPlanYear,
        adjustment_reason_code: null,
        modifier_codes: item.modifier ? [item.modifier] : null,
        metadata: {
          ...findingMeta,
          ...(mapping ? { serviceMapping: { slug: mapping.slug, confidence: mapping.confidence } } : {}),
        },
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

    // Notify admin if any line items couldn't be mapped to a service slug (non-blocking)
    if (serviceMappingEnabled) {
      const unmapped = lineItemInserts
        .filter((li) => li.service_slug === null && li.description)
        .map((li) => li.description as string);
      if (unmapped.length > 0) {
        notifyUnmappedLineItems(claim.id, unmapped).catch(() => {});
      }
    }

    return { claimId: claim.id, lineItemIds };
  } catch (err) {
    console.error("[claims-persist] Error:", err);
    return null;
  }
}
