/**
 * Claims Persistence — saves audit results to the claims and claim_line_items tables.
 *
 * When a user uploads an EOB or itemized bill, the audit engine runs and produces
 * findings. This module persists those results so the user can track their billing
 * history, disputes, and recovery over time.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { ParsedBill, AuditReport, AuditFinding, BillLineItem, FieldMeta } from "@/lib/billing/types";
import { mapLineItemsToServices, inferBillingCodeType } from "@/lib/claims/service-mapper";
import { isFeatureEnabled } from "@/lib/config/product-flags";
import { notifyUnmappedLineItems } from "@/lib/notifications";
import { buildProvenanceEntry, type FieldProvenanceEntry } from "@/lib/parser/field-categories";
import { categorizeLineItem } from "@/lib/parser/code-identity";
import { inferProcedureCodeType } from "@/lib/billing/code-type-inference";

/**
 * Build a field_provenance JSONB payload for a parsed bill line item per DR-3B
 * (Q-DR-3B-1 + Q-DR-3B-2). Source is `doc_extraction` for EOBs (insurer record) and
 * `bill_observed` for itemized bills (provider claim) — Q-DR-3A-4-final hierarchy
 * routes them to the right category at conflict resolution time.
 *
 * Per Q-DR-3B-1, Haiku per-field confidence (item._meta) is METADATA only — preserved
 * for Phase 6 calibration analysis but never auto-blended into the SOURCE_DEFAULT.
 */
// Pattern P-8 (Phase 3.1B) — column → Haiku _meta dot-path key mapping.
// Haiku emits meta keys with snake_case fields normalized to camelCase by
// `parseHaikuMetaBlock`; column names use snake_case. Lookup happens after the
// normalization so values here use the camelCase form Haiku returns.
const COLUMN_TO_META_KEY: Record<string, string> = {
  billing_code: "procedureCode",
  description: "description",
  units: "quantity",
  billed_amount: "billedAmount",
  allowed_amount: "allowedAmount",
  insurance_paid: "insurancePaid",
  patient_owes: "patientResponsibility",
  service_date: "serviceDate",
  rendering_provider_name: "renderingProviderName",
  rendering_provider_npi: "renderingProviderNpi",
};

function buildLineItemProvenance(
  item: BillLineItem,
  billType: "eob" | "itemized_bill",
  lineIndex?: number,
  fieldProvenanceMeta?: Record<string, FieldMeta>,
): Record<string, FieldProvenanceEntry> {
  const source = billType === "eob" ? "doc_extraction" : "bill_observed";
  const provenance: Record<string, FieldProvenanceEntry> = {};

  const fields: Array<[string, unknown]> = [
    ["billing_code", item.procedureCode],
    ["billing_code_type", item.procedureCode],
    ["description", item.description],
    ["units", item.quantity],
    ["billed_amount", item.billedAmount],
    ["allowed_amount", item.allowedAmount],
    ["insurance_paid", item.insurancePaid],
    ["patient_owes", item.patientResponsibility],
    ["service_date", item.serviceDate],
    ["rendering_provider_name", item.rendering_provider_name],
    ["rendering_provider_npi", item.rendering_provider_npi],
  ];

  for (const [column, value] of fields) {
    if (value === null || value === undefined || value === "") continue;

    // Pattern P-8: look up Haiku per-field meta (source_excerpt + section_hint +
    // verification flags) when available. Skip for columns Haiku doesn't tag (e.g.,
    // billing_code_type — derived from procedureCode, not separately provenance-tagged).
    let patternP8: Parameters<typeof buildProvenanceEntry>[4];
    let haikuConfidence: number | undefined;
    if (fieldProvenanceMeta && lineIndex !== undefined && COLUMN_TO_META_KEY[column]) {
      const metaKey = `lineItems[${lineIndex}].${COLUMN_TO_META_KEY[column]}`;
      const meta = fieldProvenanceMeta[metaKey];
      if (meta) {
        haikuConfidence = meta.confidence;
        patternP8 = {
          sourceExcerpt: meta.source_excerpt,
          sourceExcerptVerified: meta.source_excerpt_verified,
          sourceExcerptExtractionMethod: meta.source_excerpt_extraction_method,
          sourceSectionHint: meta.source_section_hint,
          sourceSectionVerified: meta.source_section_verified,
        };
      }
    }

    const entry = buildProvenanceEntry("claim_line_items", column, source, haikuConfidence, patternP8);
    if (entry) provenance[column] = entry;
  }

  return provenance;
}

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

    // DR-3B per-field provenance: only emit when parse_strategy_v2 flag is ON.
    // OFF preserves legacy behavior (no field_provenance writes; column default '{}'
    // applies via mig 056 so reads stay backwards-compatible).
    const parseStrategyV2Enabled = await isFeatureEnabled("parse_strategy_v2");

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

    // S74.5 D4 — composite-key categorization flywheel (gated). When ON, runs
    // ALONGSIDE the legacy service-mapper: D2 result wins for slug + sets
    // billing_code_identity_id; legacy mapping is fallback when D2 returns null.
    const flywheelEnabled = await isFeatureEnabled("s74_5_categorization_flywheel_v1");
    const identityMappings = new Map<
      number,
      { slug: string | null; confidence: number; identityId: string | null; needsReview: boolean }
    >();

    if (flywheelEnabled && parsedBill.lineItems.length > 0) {
      try {
        const results = await Promise.all(
          parsedBill.lineItems.map(async (item) => {
            const code = item.procedureCode || "";
            if (!code) return null;
            // Use the new ProcedureCodeType namespace for billing_code_identity writes;
            // legacy claim_line_items.billing_code_type stays in BillingCodeType.
            const codeType =
              item.procedureCodeType ?? inferProcedureCodeType(code) ?? undefined;
            const description = item.description || item.category || "";
            try {
              const r = await categorizeLineItem({
                code,
                codeType,
                description,
                userId,
              });
              return { lineNumber: item.lineNumber, ...r };
            } catch (err) {
              console.warn("[claims-persist] flywheel categorize failed for line", item.lineNumber, err);
              return null;
            }
          })
        );
        for (const r of results) {
          if (!r) continue;
          identityMappings.set(r.lineNumber, {
            slug: r.serviceSlug,
            confidence: r.confidence,
            identityId: r.identityId,
            needsReview: r.needsReview,
          });
        }
        console.log(
          `[claims-persist] flywheel: ${identityMappings.size} line items processed (${
            Array.from(identityMappings.values()).filter((m) => m.slug).length
          } with slug)`
        );
      } catch (err) {
        console.error("[claims-persist] flywheel categorization failed (non-blocking):", err);
      }
    }

    // Insert claim_line_items
    const lineItemInserts = parsedBill.lineItems.map((item, idx) => {
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
      const identity = identityMappings.get(item.lineNumber);
      // D4: flywheel slug wins when present; legacy mapping is fallback
      const resolvedSlug = identity?.slug ?? mapping?.slug ?? null;
      const resolvedSlugSource = identity?.slug
        ? "flywheel"
        : mapping?.slug
          ? "service_mapper"
          : null;

      const baseRow: Record<string, unknown> = {
        claim_id: claim.id,
        line_number: item.lineNumber,
        billing_code: item.procedureCode || null,
        billing_code_type: item.procedureCode ? inferBillingCodeType(item.procedureCode) : null,
        service_slug: resolvedSlug,
        billing_code_identity_id: identity?.identityId ?? null,
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
          ...(identity
            ? {
                codeIdentity: {
                  identityId: identity.identityId,
                  slug: identity.slug,
                  confidence: identity.confidence,
                  needsReview: identity.needsReview,
                },
                slugSource: resolvedSlugSource,
              }
            : {}),
        },
      };

      if (parseStrategyV2Enabled) {
        baseRow.field_provenance = buildLineItemProvenance(
          item,
          parsedBill.billType,
          idx,
          parsedBill.extractionMeta?.fieldProvenance,
        );
      }

      return baseRow;
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
