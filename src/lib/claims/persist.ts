/**
 * Claims Persistence — saves audit results to the claims and claim_line_items tables.
 *
 * When a user uploads an EOB or itemized bill, the audit engine runs and produces
 * findings. This module persists those results so the user can track their billing
 * history, disputes, and recovery over time.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { ParsedBill, AuditReport, AuditFinding, BillLineItem, FieldMeta } from "@/lib/billing/types";
import { inferBillingCodeType } from "@/lib/claims/service-mapper";
import { isFeatureEnabled } from "@/lib/config/product-flags";
import { notifyUnmappedLineItems } from "@/lib/notifications";
import { buildProvenanceEntry, type FieldProvenanceEntry } from "@/lib/parser/field-categories";
import { reconcileHaikuCodeType } from "@/lib/billing/code-type-inference";

/**
 * S135 bandaid — Haiku parser writes `insurance_adjusted_amount` and
 * `insurance_paid` (and their totals) with negative signs on at least one PROD
 * bill. Parser convention per `haiku-bill-parser.ts:102` is positive magnitudes
 * (writeoffs and payments). Negative values cascade into BillCard / BILL SHOWS
 * inflation and confusing audit body text.
 *
 * This guard coerces to abs() on write + warns to telemetry so we can audit
 * how often Haiku regresses post-deploy. Root-cause prompt fix + reject-not-
 * coerce invariant tracked in plans/findings/parser_sign_hardening_followup.md.
 */
function normalizeBillingSign(
  value: number | null | undefined,
  field: string,
  ctx: Record<string, unknown> = {},
): number | null {
  if (value == null) return null;
  const v = Number(value);
  if (Number.isNaN(v)) return null;
  if (v < 0) {
    console.warn(`[persist] sign-violation: ${field}=${v} flipped to ${Math.abs(v)}`, ctx);
    return Math.abs(v);
  }
  return v;
}

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
        total_insurance_paid: normalizeBillingSign(parsedBill.totals.totalInsurancePaid, "total_insurance_paid", { userId, documentId }),
        total_insurance_adjusted: normalizeBillingSign(parsedBill.totals.totalInsAdjusted, "total_insurance_adjusted", { userId, documentId }) ?? 0,
        total_patient_responsibility: parsedBill.totals.totalPatientResponsibility ?? null,
        total_patient_paid: parsedBill.totals.totalPatientPaid ?? 0,
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

    // S74.6 §C.1 — service-mapper + flywheel categorize moved upstream to
    // `resolveLineItemSlugs` (preflight-slug-resolver) so the audit pipeline
    // can build per-slug cohort keys + D4 can skip categorized lines. Persist
    // now consumes the pre-resolved values from bill.lineItems[i].serviceSlug
    // / .serviceSlugSource / .billingCodeIdentityId rather than re-running.
    // The legacy `billing_code_service_mapping` flag controls whether
    // unmapped-line admin notifications fire (preserved at the bottom of
    // this function).
    const serviceMappingEnabled = await isFeatureEnabled(
      "billing_code_service_mapping",
    );
    const flywheelEnabled = await isFeatureEnabled(
      "s74_5_categorization_flywheel_v1",
    );

    // DR-3B per-field provenance: only emit when parse_strategy_v2 flag is ON.
    // OFF preserves legacy behavior (no field_provenance writes; column default '{}'
    // applies via mig 056 so reads stay backwards-compatible).
    const parseStrategyV2Enabled = await isFeatureEnabled("parse_strategy_v2");

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
              description: f.description, // Session 85 — persist so the
              // expanded-row "what we found" card can render the longer
              // user-friendly explanation (e.g., F-14's insurer-vs-plan
              // narrative).
              actionable: f.actionable,
            })),
          }
        : {};

      // §C.1 — pre-flight resolved slug + identity from `resolveLineItemSlugs`
      // (caller runs it before runAudit). When pre-flight didn't run (legacy
      // callers in test paths), these fields are undefined and the row keeps
      // service_slug=null until D4 post-insert assigns a provisional slug.
      const resolvedSlug = item.serviceSlug ?? null;
      const resolvedSlugSource = item.serviceSlugSource ?? null;
      const resolvedIdentityId = item.billingCodeIdentityId ?? null;

      const baseRow: Record<string, unknown> = {
        claim_id: claim.id,
        line_number: item.lineNumber,
        billing_code: item.procedureCode || null,
        billing_code_type: item.procedureCode ? inferBillingCodeType(item.procedureCode) : null,
        service_slug: resolvedSlug,
        billing_code_identity_id: resolvedIdentityId,
        description: item.description || item.category || null,
        units: item.quantity || 1,
        billed_amount: item.billedAmount,
        allowed_amount: item.allowedAmount || null,
        insurance_paid: normalizeBillingSign(item.insurancePaid, "insurance_paid", { lineNumber: item.lineNumber }),
        // Mig 092 — contractual writeoff distinct from insurance_paid. Defaults
        // to 0 (rather than null) so downstream math can sum without null guards;
        // null indicates "parser didn't extract" which we treat as 0 too here.
        insurance_adjusted_amount: normalizeBillingSign(item.ins_adjusted, "insurance_adjusted_amount", { lineNumber: item.lineNumber }) ?? 0,
        patient_owes: item.patientResponsibility ?? null,
        // Mig 092 — patient out-of-pocket payments. Default 0; populated by
        // parser when "Paid [date] -$X" footer lines are present on the bill.
        patient_paid_amount: item.patient_paid ?? 0,
        plan_year: resolvedPlanYear,
        adjustment_reason_code: null,
        modifier_codes: item.modifier ? [item.modifier] : null,
        metadata: {
          ...findingMeta,
          ...(resolvedSlug
            ? {
                slugSource: resolvedSlugSource,
                slugResolution: {
                  slug: resolvedSlug,
                  identityId: resolvedIdentityId,
                  source: resolvedSlugSource,
                },
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

    // S74.6 D4 §D.1 + §D.2 + §D.4 — post-insert flywheel write. For each
    // line item carrying a `code_uncategorized_description_match` finding,
    // route to vote-recording (confident) or ambiguous-candidate (ambiguous)
    // helpers. The line item ID is finally available here (couldn't write at
    // audit time because INSERT hadn't fired). After the vote-write, §D.4
    // auto-assigns the provisional slug + identity_id back to claim_line_items
    // so the bill renders with the matched category on first view.
    //
    // Gated on flywheelEnabled + at least one matching finding. Non-blocking —
    // errors logged + swallowed (the claim is still persisted, the flywheel
    // just doesn't accumulate this user's vote on that line).
    if (flywheelEnabled && lineItemIds.length === lineItemInserts.length) {
      try {
        // Resolve the auth users.id (UUID) once — vote-writes expect the DB
        // user_id, not the firebase_uid.
        const { data: userRow } = await supabase
          .from("users")
          .select("id")
          .eq("firebase_uid", userId)
          .maybeSingle();
        const dbUserId = userRow?.id as string | null;
        if (dbUserId) {
          const {
            recordDescriptionMatchVote,
            recordAmbiguousCandidate,
          } = await import("@/lib/parser/code-identity-promotion");

          for (let idx = 0; idx < parsedBill.lineItems.length; idx++) {
            const item = parsedBill.lineItems[idx];
            const lineId = lineItemIds[idx];
            const findings = findingsByLine.get(item.lineNumber) || [];
            const dmFinding = findings.find(
              (f) =>
                f.type === "code_uncategorized_description_match" &&
                f.descriptionMatch,
            );
            if (!dmFinding || !dmFinding.descriptionMatch) continue;
            const dm = dmFinding.descriptionMatch;
            const code = item.procedureCode || "";
            if (!code) continue;
            const codeType = reconcileHaikuCodeType(code, item.procedureCodeType) ?? undefined;
            const desc = item.description || item.category || "";

            try {
              if (dm.ambiguous && dm.secondMatch) {
                await recordAmbiguousCandidate({
                  userId: dbUserId,
                  billingCode: code,
                  billingCodeType: codeType,
                  rawDescription: desc,
                  topMatch: {
                    slug: dm.provisionalSlug,
                    score: dm.haikuScore,
                  },
                  secondMatch: dm.secondMatch,
                  lineItemId: lineId,
                });
                // §D.4 — even for ambiguous, top-1 becomes the displayed slug
                // (user sees the best guess; admin disambiguation refines).
                await supabase
                  .from("claim_line_items")
                  .update({ service_slug: dm.provisionalSlug })
                  .eq("id", lineId)
                  .is("service_slug", null);
              } else {
                const voteResult = await recordDescriptionMatchVote({
                  userId: dbUserId,
                  billingCode: code,
                  billingCodeType: codeType,
                  rawDescription: desc,
                  proposedSlug: dm.provisionalSlug,
                  haikuScore: dm.haikuScore,
                  lineItemId: lineId,
                });
                // §D.4 — auto-assign provisional slug + identity_id. Only when
                // the parser didn't already resolve a slug (don't overwrite
                // direct catalog matches).
                if (voteResult.identityId) {
                  await supabase
                    .from("claim_line_items")
                    .update({
                      service_slug: dm.provisionalSlug,
                      billing_code_identity_id: voteResult.identityId,
                    })
                    .eq("id", lineId)
                    .is("service_slug", null);
                }
              }
            } catch (perLineErr) {
              console.warn(
                "[claims-persist] D4 flywheel write failed for line",
                item.lineNumber,
                perLineErr,
              );
            }
          }
        }
      } catch (err) {
        console.error("[claims-persist] D4 flywheel post-insert failed (non-blocking):", err);
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
