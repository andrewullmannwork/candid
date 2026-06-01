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
import {
  detectSignViolations,
  loadVerifierTolerances,
  verifyHeaderReconciliation,
  verifyPerLineSums,
} from "@/lib/billing/sum-invariants";
import {
  recordBillParserDecision,
  type BillParserPath,
} from "@/lib/billing/bill-parser-decisions";

/**
 * PR4 (S142) — replace the S135 silent-Math.abs bandaid with an audited
 * magnitude write. Negative inputs are still coerced to magnitude at write
 * time (downstream math depends on positives), but every coercion produces a
 * `bill_parser_decisions` row with verdict='sign_violation', so admin can
 * detect regressions. The structural fix is upstream (B-3 prompt + B-1
 * tool-use minimum:0 schema constraint); this is defense-in-depth.
 */
function absOrNull(value: number | null | undefined): number | null {
  if (value == null) return null;
  const v = Number(value);
  if (Number.isNaN(v)) return null;
  return Math.abs(v);
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
    // PR4 (S142) — which parser code path produced parsedBill. Default 'raw_json'
    // because the bill_parser_tool_use_v1 flag ships OFF in PROD. Caller threads
    // the actual path through so bill_parser_decisions rows can attribute
    // verdict-rate trends to parser-path drift across the migration soak.
    parserPath?: BillParserPath;
  }
): Promise<PersistClaimResult | null> {
  const { userId, insurancePlanId, planYear, documentId, parsedBill, auditReport } = params;
  // Explicit param wins; otherwise inherit the transient label that the parser
  // stamped on the result. Defaults to 'raw_json' when both are missing
  // (regex-fallback path via parseBillFromOCR).
  const parserPath: BillParserPath = params.parserPath ?? parsedBill.parserPath ?? "raw_json";

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

    // PR4 (S142) — run B-1 / B-2 / B-3 verifiers upfront. Used to:
    //   1. Decide whether to populate per-line numeric fields (sparse-mismatch
    //      drops them so frontend Path B helper pro-rates from header)
    //   2. Set metadata flags on the claim so frontend can suppress dispute
    //      generation on flagged claims (B-2 contract per S140 cite-grade fix)
    //   3. Drive the bill_parser_decisions row (B-3 admin queue)
    const tolerances = await loadVerifierTolerances();
    const signViolations = detectSignViolations(parsedBill);
    const perLineVerdicts = verifyPerLineSums(parsedBill, tolerances);
    const headerVerdict = verifyHeaderReconciliation(parsedBill, tolerances);
    // Per-line fields to DROP to NULL on insert (sparse-mismatch fallback).
    // A field is dropped when it was populated AND its line-sum didn't match
    // the header total within tolerance — that means the parser emitted
    // inconsistent values per-line, so the frontend Path B helper should
    // pro-rate from the trustworthy header instead.
    const perLineDropFields = new Set(
      perLineVerdicts.filter((v) => v.populated && !v.withinTolerance).map((v) => v.perLineKey),
    );
    const billParserVerdictFlags: Record<string, boolean> = {};
    if (signViolations.length > 0) billParserVerdictFlags.bill_parser_sign_violation = true;
    if (perLineDropFields.size > 0) billParserVerdictFlags.per_line_breakdown_sparse = true;
    if (headerVerdict.allHeaderTotalsPresent && !headerVerdict.withinTolerance) {
      billParserVerdictFlags.header_reconciliation_failed = true;
    }

    // Insert claims row. Sign-violation handling: write magnitude so downstream
    // BillCard / BILL SHOWS / recovery math stays sane, but the decision row +
    // metadata flag preserve the audit trail (replaces silent S135 Math.abs
    // bandaid).
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
        total_insurance_paid: absOrNull(parsedBill.totals.totalInsurancePaid),
        total_insurance_adjusted: absOrNull(parsedBill.totals.totalInsAdjusted) ?? 0,
        total_patient_responsibility: parsedBill.totals.totalPatientResponsibility ?? null,
        total_patient_paid: absOrNull(parsedBill.totals.totalPatientPaid) ?? 0,
        claim_number: null, // Not always present on bills
        status: auditReport.findings.length > 0 ? "flagged" : "processed",
        metadata: {
          billType: parsedBill.billType,
          provider: parsedBill.provider,
          patient: parsedBill.patient,
          insurer: parsedBill.insurer,
          auditSummary: auditReport.summary,
          ...billParserVerdictFlags,
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
    // S153 — when ON, the unified resolver (run in preflight) already set the
    // user-scoped slug + warmed the learned cache; here we only cast the
    // cross-user corroboration vote from the resolver result (the legacy
    // D4-finding vote path is skipped).
    const resolverEnabled = await isFeatureEnabled("service_resolver_v1");

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
      // S153 — resolver confidence persisted for Ship Gate G7 observability
      // (per-line source + confidence distribution; admin can detect drift).
      const resolvedConfidence = item.serviceSlugConfidence ?? null;

      // PR4 (S142) B-1 — when a per-line field's sum doesn't match the header,
      // drop the per-line value to NULL so the frontend Path B helper
      // pro-rates from the trustworthy header total. Per-line-sparse path is
      // signaled at the document/claim level via metadata.per_line_breakdown_sparse;
      // dispute pipeline marks provenance.citationSource='claim_header'.
      const dropInsurancePaid = perLineDropFields.has("insurancePaid");
      const dropInsAdjusted = perLineDropFields.has("ins_adjusted");
      const dropPatientPaid = perLineDropFields.has("patient_paid");

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
        insurance_paid: dropInsurancePaid ? null : absOrNull(item.insurancePaid),
        // Mig 092 — contractual writeoff distinct from insurance_paid. Defaults
        // to 0 (rather than null) so downstream math can sum without null guards;
        // null indicates "parser didn't extract" which we treat as 0 too here.
        // PR4: when the sum-equals-header verifier failed for this field, drop
        // to null so frontend Path B helper pro-rates from header (which is
        // the trustworthy total per B-2).
        insurance_adjusted_amount: dropInsAdjusted ? null : absOrNull(item.ins_adjusted) ?? 0,
        patient_owes: item.patientResponsibility ?? null,
        // Mig 092 — patient out-of-pocket payments. Default 0; populated by
        // parser when "Paid [date] -$X" footer lines are present on the bill.
        // PR4: same sparse-drop semantics as insurance_paid / ins_adjusted.
        patient_paid_amount: dropPatientPaid ? null : absOrNull(item.patient_paid) ?? 0,
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
                  confidence: resolvedConfidence,
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
            // S153 — resolver path: cast the corroboration vote from the
            // resolver result (coded, confident lines) and skip the legacy
            // D4-finding vote logic. Code-less lines rely on the signature
            // learned cache (no billing_code_identity row to corroborate).
            if (resolverEnabled) {
              if (
                item.serviceSlugSource === "resolver" &&
                item.serviceSlug &&
                item.procedureCode &&
                (item.serviceSlugConfidence ?? 0) >= 0.85
              ) {
                const ct =
                  reconcileHaikuCodeType(
                    item.procedureCode,
                    item.procedureCodeType,
                  ) ?? undefined;
                try {
                  await recordDescriptionMatchVote({
                    userId: dbUserId,
                    billingCode: item.procedureCode,
                    billingCodeType: ct,
                    rawDescription: item.description || item.category || "",
                    proposedSlug: item.serviceSlug,
                    haikuScore: item.serviceSlugConfidence ?? 0.85,
                    lineItemId: lineId,
                  });
                } catch (e) {
                  console.warn(
                    "[claims-persist] resolver vote failed for line",
                    item.lineNumber,
                    e,
                  );
                }
              }
              continue;
            }
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

    // PR4 (S142) — append bill_parser_decisions row capturing B-1 / B-2 / B-3
    // verdicts. Non-fatal: failures swallowed inside the helper. Recorded for
    // EVERY persist (clean + fire) per Ship Gate G7 silent-regression detection
    // — so admin can compute (clean / total) rates and detect drift.
    void recordBillParserDecision({
      supabase,
      documentId,
      claimId: claim.id,
      userId,
      parserPath,
      signViolations,
      perLineVerdicts,
      headerVerdict,
      metadata: {
        bill_type: parsedBill.billType,
        plan_year: resolvedPlanYear,
        total_billed: parsedBill.totals.totalBilled,
      },
    });

    // PR4 (S142) — also reflect verdict flags onto documents.metadata so the
    // dispute-letter pipeline + admin doc surfaces can read header-level
    // verdicts without joining through claims. Non-fatal; failures logged.
    if (Object.keys(billParserVerdictFlags).length > 0) {
      try {
        const { data: docRow } = await supabase
          .from("documents")
          .select("metadata")
          .eq("id", documentId)
          .maybeSingle();
        const existingMeta = (docRow?.metadata ?? {}) as Record<string, unknown>;
        const { error: docUpdateErr } = await supabase
          .from("documents")
          .update({
            metadata: {
              ...existingMeta,
              ...billParserVerdictFlags,
              bill_parser_decision_summary: {
                claim_id: claim.id,
                parser_path: parserPath,
                verdict_flags: billParserVerdictFlags,
                recorded_at: new Date().toISOString(),
              },
            },
          })
          .eq("id", documentId);
        if (docUpdateErr) {
          console.warn("[claims-persist] documents.metadata flag update failed (non-fatal):", docUpdateErr);
        }
      } catch (metaErr) {
        console.warn("[claims-persist] documents.metadata flag update threw (non-fatal):", metaErr);
      }
    }

    return { claimId: claim.id, lineItemIds };
  } catch (err) {
    console.error("[claims-persist] Error:", err);
    return null;
  }
}
