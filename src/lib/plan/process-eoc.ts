/**
 * EOC document processing — Phase 3.1A Task 3.1A-D.
 *
 * Orchestrates: parseEOC() (Task 3.1A-C) → plan-identity persistence → per-section
 * persistence (admin queue for unknown codes; coverage_rules JSONB for matched
 * concepts; insurance_plans.metadata.eoc_* for top-level section content) →
 * parse_audit_runs telemetry write.
 *
 * Feature-flag gated by `eoc_parser_v1` (mig 059); when OFF, caller falls back to
 * processPlanDocumentData (legacy plan-doc-parser path) so the EOC doc still gets
 * plan-identity extraction.
 *
 * Image-PDF refusal (Q-P3.1A-12) handled at the dispatcher (process-chunk/route.ts)
 * BEFORE this function is invoked — by the time we get here, ocrText is sufficient.
 *
 * Pattern 2 plan-identity merge (Q-P3.1A-11): EOC parser INTERNALLY reuses
 * plan-doc-parser.ts:parsePlanDocument() for plan_identity extraction; we then
 * merge into existing active plan if one exists for this user (per Pattern 2 hard
 * rules + processPlanDocumentData merge logic). v1 limitation: skip insurer mismatch
 * + year rollover detection — those typically resolve at SBC upload time before EOC
 * arrives. Document follow-up to extract shared mergeOrCreatePlan helper.
 */

import { createServerClient } from "@/lib/supabase/server";
import { parseEOC } from "@/lib/eoc/parser";
import { resolveOrEnqueueConcept } from "@/lib/eoc/concept-resolver";
import type { EOCParseResult } from "@/lib/eoc/types";
import type { ProcessPlanResult } from "@/lib/plan/process-plan";
import { buildEOCPlanIdentityProvenance } from "@/lib/parser/provenance-builders";
import { loadValidServiceSlugs, enqueueUnknownServiceSlug } from "@/lib/parser/service-catalog-slugs";
import { isFeatureEnabled } from "@/lib/config/product-flags";
import {
  commitUploadAndEvaluateCorroboration,
  PHASE_4_0_6_PLAN_IDENTITY_FIELDS_EOC,
} from "@/lib/parser/commit-and-evaluate";

type SupabaseClient = ReturnType<typeof createServerClient>;

const COST_HARD_CAP_USD = 1.0;

export interface ProcessEOCInput {
  doc: { id: string; user_id: string; file_name: string };
  ocrText: string;
  documentId: string;
  classification: { classifiedType: string; confidence: number; mismatch: boolean };
}

/**
 * Main entry. Returns ProcessPlanResult shape so the caller's existing dispatch
 * logic doesn't need separate result handling.
 */
export async function processEOCDocumentData(
  supabase: SupabaseClient,
  input: ProcessEOCInput,
): Promise<ProcessPlanResult> {
  const { doc, ocrText, documentId } = input;
  const parseWarnings: string[] = [];

  // 1. Run EOC parser (Pattern P-D + P-8 inheritance via Task 3.1A-C).
  let parsed: EOCParseResult;
  try {
    parsed = await parseEOC(ocrText, {
      documentId,
      extractionMethod: "pdftotext", // upload pipeline uses pdftotext-then-OCR-fallback;
                                      // OCR fallback is refused upstream (Q-P3.1A-12 image-PDF refusal)
    });
  } catch (err) {
    const reason = `EOC parser exception: ${err instanceof Error ? err.message : String(err)}`;
    console.error("[process-eoc]", reason);
    await supabase
      .from("documents")
      .update({ status: "error", processing_error: reason })
      .eq("id", documentId);
    return {
      success: false,
      error: reason,
      parseWarnings: [reason],
    };
  }

  parseWarnings.push(...parsed.warnings);

  // Cost hard cap defensive check (parser also enforces; double-check at boundary).
  if (parsed.total_cost_usd > COST_HARD_CAP_USD) {
    const reason = `eoc_cost_hard_cap_breached:${documentId}:cost=${parsed.total_cost_usd.toFixed(4)}`;
    parseWarnings.push(reason);
  }

  // 2. Plan-identity persistence.
  // V1 minimal: insert insurance_plans OR update existing active plan for this user.
  // Defer insurer mismatch + year rollover handling (Q-P3.1A-11 v1 limitation).
  const planResult = await persistEOCPlanIdentity(supabase, doc, documentId, parsed);
  if (!planResult.success) {
    return planResult;
  }
  const targetPlanId = planResult.planId;
  if (!targetPlanId) {
    return {
      success: false,
      error: "EOC plan persistence returned no planId",
      parseWarnings,
    };
  }

  // 3. Per-section persistence.
  const persistenceWarnings = await persistEOCSections(supabase, doc, documentId, targetPlanId, parsed);
  parseWarnings.push(...persistenceWarnings);

  // 3.5 Phase 4.0.6 corroboration evaluator post-commit (per Q-P4.0.6-1 LOCK v4
  // Single discipline point — all upload paths route through
  // commitUploadAndEvaluateCorroboration helper). EOC plan-identity is
  // regex-extracted (no Pattern P-8 verified excerpts in v1) so EOC's own
  // contribution doesn't count toward corroboration; calling the helper still
  // runs evaluator on this canonical to detect threshold-met state from prior
  // SBC uploads on the same canonical. Phase 5+ may upgrade EOC plan-identity
  // to Pattern P-8 verified excerpts so cross-source corroboration fires.
  const promotionEventEnabled = await isFeatureEnabled(
    "canonical_promotion_event_v1",
    undefined, // global flag; no per-user check needed
  );
  if (promotionEventEnabled) {
    try {
      const { data: planRow } = await supabase
        .from("insurance_plans")
        .select("canonical_plan_id, user_id")
        .eq("id", targetPlanId)
        .maybeSingle();
      const canonicalPlanId = planRow?.canonical_plan_id as string | null | undefined;
      if (canonicalPlanId) {
        const candidates = PHASE_4_0_6_PLAN_IDENTITY_FIELDS_EOC.map((fieldName) => ({
          serviceSlug: null as string | null,
          fieldName,
        }));
        const result = await commitUploadAndEvaluateCorroboration(supabase, {
          canonicalPlanId,
          actorUserId: (planRow?.user_id as string | undefined) ?? doc.user_id,
          fireSource: "process-eoc",
          candidates,
        });
        console.log(
          `[canonical-promotion] [eoc] canonical=${canonicalPlanId} candidates=${candidates.length} fired=${result.promotionsFired} challenges=${result.challengeCandidates} errors=${result.errors.length}`,
        );
        if (result.errors.length > 0) {
          console.error("[canonical-promotion] [eoc] errors:", result.errors);
          parseWarnings.push(...result.errors.map((e) => `canonical_promotion_eoc:${e}`));
        }
      }
    } catch (err) {
      console.error("[canonical-promotion] [eoc] non-fatal:", err);
    }
  }

  // 4. parse_audit_runs telemetry per Pattern P-7.
  await writeParseAuditRun(supabase, doc, documentId, parsed);

  // 5. documents.metadata.eoc_sections summary write.
  await supabase
    .from("documents")
    .update({
      metadata: {
        eoc_sections_summary: {
          segmentation_used: parsed.segmentation_used,
          sections_extracted: Object.keys(parsed.sections),
          total_cost_usd: parsed.total_cost_usd,
          total_input_tokens: parsed.total_input_tokens,
          total_output_tokens: parsed.total_output_tokens,
          parse_errors: parsed.parse_errors,
          warning_count: parsed.warnings.length,
        },
      },
    })
    .eq("id", documentId);

  return {
    success: true,
    planId: targetPlanId,
    servicesCreated: countCoverageServices(parsed),
    planData: {
      planName: parsed.plan_identity.plan_name,
      planType: null, // plan-doc-parser populates this; v1 doesn't surface back through EOC
      inDeductible: parsed.plan_identity.in_deductible_individual,
      outDeductible: parsed.plan_identity.out_deductible_individual,
      inOopMax: parsed.plan_identity.in_oop_max_individual,
      outOopMax: parsed.plan_identity.out_oop_max_individual,
      servicesExtracted: countCoverageServices(parsed),
    },
    parseWarnings,
  };
}

/**
 * Minimal plan-identity persistence — inserts new insurance_plans row OR merges
 * into existing active plan for this user. Defers insurer-mismatch + year-rollover
 * detection per v1 scope (Q-P3.1A-11 limitation; user typically uploads SBC first).
 */
async function persistEOCPlanIdentity(
  supabase: SupabaseClient,
  doc: { id: string; user_id: string },
  documentId: string,
  parsed: EOCParseResult,
): Promise<ProcessPlanResult> {
  // Phase 3.2.1 Q-P3.2.1-2 — Pattern P-8 plan-identity provenance for EOC writes.
  // EOC plan_identity comes from regex parsePlanDocument (per Q-P3.1A-11) so there's
  // no patternP8 sub-keys; entries carry source="doc_extraction_eoc" + confidence +
  // last_corroborated_at only. Cross-source corroboration with SBC plan-identity
  // (where values match) lifts confidence via Pattern 1 #3 — corroboration is value-
  // match-based, not excerpt-match-based, so absence of P-8 sub-keys here doesn't
  // break the flywheel.
  const eocPlanIdentityProvenance = buildEOCPlanIdentityProvenance(parsed.plan_identity);
  const hasProvenanceEntries = Object.keys(eocPlanIdentityProvenance).length > 0;

  const planFields = {
    user_id: doc.user_id,
    insurer_name: parsed.plan_identity.insurer_name,
    plan_name: parsed.plan_identity.plan_name,
    plan_year: parsed.plan_identity.plan_year,
    in_deductible_individual: parsed.plan_identity.in_deductible_individual,
    in_oop_max_individual: parsed.plan_identity.in_oop_max_individual,
    out_deductible_individual: parsed.plan_identity.out_deductible_individual,
    out_oop_max_individual: parsed.plan_identity.out_oop_max_individual,
    source: "eoc_upload" as const,
    source_document_id: documentId,
    is_active: true,
    verification_status: "document_verified" as const,
    ...(hasProvenanceEntries ? { field_provenance: eocPlanIdentityProvenance } : {}),
  };

  // Check for existing active plan for this user.
  const { data: existingActive } = await supabase
    .from("insurance_plans")
    .select("id, plan_name, insurer_name")
    .eq("user_id", doc.user_id)
    .eq("is_active", true)
    .maybeSingle();

  if (existingActive) {
    // Merge: update existing plan with EOC plan_identity (where EOC has values; preserve existing where EOC is null).
    const updates: Record<string, unknown> = {
      source: "eoc_upload",
      source_document_id: documentId,
      verification_status: "document_verified",
    };
    if (planFields.in_deductible_individual !== null) updates.in_deductible_individual = planFields.in_deductible_individual;
    if (planFields.in_oop_max_individual !== null) updates.in_oop_max_individual = planFields.in_oop_max_individual;
    if (planFields.out_deductible_individual !== null) updates.out_deductible_individual = planFields.out_deductible_individual;
    if (planFields.out_oop_max_individual !== null) updates.out_oop_max_individual = planFields.out_oop_max_individual;
    // Phase 3.2.1 — propagate EOC plan-identity provenance into existing row.
    // Last-writer-wins on JSONB (acceptable per Subplan §Risks; Pattern 1 #3
    // corroboration handles cross-source value-matching independent of excerpt diversity).
    if (hasProvenanceEntries) updates.field_provenance = eocPlanIdentityProvenance;

    const { error: updateErr } = await supabase
      .from("insurance_plans")
      .update(updates)
      .eq("id", existingActive.id);
    if (updateErr) {
      return { success: false, error: `EOC plan merge failed: ${updateErr.message}` };
    }
    return { success: true, planId: existingActive.id };
  }

  // No existing active plan — create new.
  const { data: newPlan, error: insertErr } = await supabase
    .from("insurance_plans")
    .insert(planFields)
    .select("id")
    .single();
  if (insertErr || !newPlan) {
    return { success: false, error: `EOC plan insert failed: ${insertErr?.message ?? "unknown"}` };
  }

  // Back-populate profile pointer.
  await supabase
    .from("profiles")
    .update({
      active_insurance_plan_id: newPlan.id,
      ...(planFields.insurer_name ? { insurer: planFields.insurer_name } : {}),
      ...(planFields.plan_name ? { plan_name: planFields.plan_name } : {}),
    })
    .eq("user_id", doc.user_id);

  return { success: true, planId: newPlan.id };
}

/**
 * Per-section persistence:
 * - Sections A (prior_auth_codes) + B (medical_necessity): per-code resolveOrEnqueueConcept.
 *   Matched concepts → write to plan_covered_services.coverage_rules JSONB; unknown → admin queue.
 * - Sections C (appeals_procedures) + D (cob_rules) + F (eligibility_rules) + K (definitions):
 *   write to insurance_plans.metadata.eoc_<section> JSONB.
 */
async function persistEOCSections(
  supabase: SupabaseClient,
  doc: { id: string; user_id: string },
  documentId: string,
  planId: string,
  parsed: EOCParseResult,
): Promise<string[]> {
  const warnings: string[] = [];

  // Resolve users.id for the firebase_uid (concept_admin_review_queue.proposed_by_user_id is UUID).
  const { data: userRow } = await supabase
    .from("users")
    .select("id")
    .eq("firebase_uid", doc.user_id)
    .maybeSingle();
  const proposedByUserId = userRow?.id ?? null;
  if (!proposedByUserId) {
    warnings.push(`eoc_persist_user_lookup_failed:${doc.user_id}`);
  }

  // ── Section A: prior_auth_codes ──────────────────────────────────────────────
  if (parsed.sections.prior_auth_codes && proposedByUserId) {
    for (const code of parsed.sections.prior_auth_codes.data.codes) {
      try {
        const result = await resolveOrEnqueueConcept(supabase, {
          sourceDocId: documentId,
          proposedByUserId,
          billingCode: code.billing_code,
          billingCodeType: code.billing_code_type,
          proposedConceptLabel: code.pa_criteria,
          proposedServiceSlug: null,
          sourceExcerpt: code.source_excerpt,
          sourceExcerptVerified: code.source_excerpt_verified,
          sourceExcerptExtractionMethod: code.source_excerpt_extraction_method,
          sourceSectionHint: code.source_section_hint,
          sourceSectionVerified: code.source_section_verified,
          contextExtract: extractContext(parsed, code.source_excerpt),
        });

        if (result.matched && result.serviceSlug) {
          // Write coverage_rules JSONB on plan_covered_services for this service_slug.
          await mergeCoverageRules(supabase, planId, result.serviceSlug, {
            requires_prior_auth: true,
            prior_auth_criteria: code.pa_criteria,
            prior_auth_source_excerpt: code.source_excerpt,
            prior_auth_source_excerpt_verified: code.source_excerpt_verified,
          });
        } else if (!result.matched) {
          warnings.push(`eoc_unknown_pa_code_enqueued:${code.billing_code}:${code.billing_code_type}`);
        }
      } catch (err) {
        warnings.push(`eoc_pa_code_persist_failed:${code.billing_code}:${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // ── Section B: medical_necessity ──────────────────────────────────────────────
  if (parsed.sections.medical_necessity && proposedByUserId) {
    // Bundle PR #1 (Session 55, audit item #8) — Pattern 1 #1 admin gate for slug
    // growth. Validate Haiku-emitted service_slug_hint against service_catalog;
    // unknowns route to service_catalog_admin_review_queue (mig 065) for admin
    // promotion. Prior behavior dropped unknowns silently — anti-flywheel.
    // service_catalog is the broader DB-truth vocabulary; STANDARD_SLUGS (51
    // SBC-curated) would over-prune EOC-legitimate slugs like specialty mental
    // health / transplant.
    const validSlugs = await loadValidServiceSlugs(supabase);

    for (const criterion of parsed.sections.medical_necessity.data.criteria) {
      // For medical_necessity, service_slug_hint is the parser's best-guess at which
      // service catalog entry this maps to. If present + matches existing service_catalog,
      // write to coverage_rules. If unknown, enqueue for admin promotion (Pattern 1 #1).
      // If no slug hint at all, log for admin review (criteria without slug binding
      // can't merge into coverage_rules).
      if (criterion.service_slug_hint) {
        if (!validSlugs.has(criterion.service_slug_hint)) {
          try {
            const { isNew } = await enqueueUnknownServiceSlug(supabase, {
              sourceDocId: documentId,
              proposedByUserId,
              parserSource: "eoc",
              proposedServiceSlug: criterion.service_slug_hint,
              proposedServiceLabel: criterion.criteria_text.slice(0, 200),
              proposedCategory: null,
              sourceExcerpt: criterion.source_excerpt,
              sourceExcerptVerified: criterion.source_excerpt_verified,
              sourceExcerptExtractionMethod: criterion.source_excerpt_extraction_method,
              sourceSectionHint: criterion.source_section_hint,
              sourceSectionVerified: criterion.source_section_verified,
              contextExtract: extractContext(parsed, criterion.source_excerpt),
            });
            warnings.push(
              isNew
                ? `eoc_medical_necessity_slug_enqueued_new:${criterion.service_slug_hint}`
                : `eoc_medical_necessity_slug_enqueued_existing:${criterion.service_slug_hint}`,
            );
          } catch (err) {
            warnings.push(`eoc_medical_necessity_slug_enqueue_failed:${criterion.service_slug_hint}:${err instanceof Error ? err.message : String(err)}`);
          }
          continue;
        }
        try {
          await mergeCoverageRules(supabase, planId, criterion.service_slug_hint, {
            medical_necessity_text: criterion.criteria_text,
            diagnosis_qualifiers: criterion.diagnosis_qualifiers,
            medical_necessity_source_excerpt: criterion.source_excerpt,
            medical_necessity_source_excerpt_verified: criterion.source_excerpt_verified,
          });
        } catch (err) {
          warnings.push(`eoc_medical_necessity_persist_failed:${criterion.service_slug_hint}:${err instanceof Error ? err.message : String(err)}`);
        }
      } else {
        warnings.push(`eoc_medical_necessity_no_slug:criteria_text_len_${criterion.criteria_text.length}`);
      }
    }
  }

  // ── Section C: appeals_procedures (single block → insurance_plans.metadata) ──
  // ── Section D: cob_rules ─────────────────────────────────────────────────────
  // ── Section F: eligibility_rules ─────────────────────────────────────────────
  // ── Section K: definitions ───────────────────────────────────────────────────
  const planMetadataPatch: Record<string, unknown> = {};
  if (parsed.sections.appeals_procedures) {
    planMetadataPatch.eoc_appeals_procedures = parsed.sections.appeals_procedures.data;
  }
  if (parsed.sections.cob_rules) {
    planMetadataPatch.eoc_cob_rules = parsed.sections.cob_rules.data;
  }
  if (parsed.sections.eligibility_rules) {
    planMetadataPatch.eoc_eligibility_rules = parsed.sections.eligibility_rules.data;
  }
  if (parsed.sections.definitions) {
    planMetadataPatch.eoc_definitions = parsed.sections.definitions.data;
  }

  if (Object.keys(planMetadataPatch).length > 0) {
    // Read existing metadata, merge (preserve other keys), write back.
    const { data: planRow } = await supabase
      .from("insurance_plans")
      .select("metadata")
      .eq("id", planId)
      .single();
    const existingMetadata = (planRow?.metadata as Record<string, unknown>) ?? {};
    const mergedMetadata = { ...existingMetadata, ...planMetadataPatch };
    await supabase.from("insurance_plans").update({ metadata: mergedMetadata }).eq("id", planId);
  }

  return warnings;
}

/**
 * Merge a coverage_rules JSONB patch into plan_covered_services for a given
 * (plan_id, service_slug). Creates the row if it doesn't exist; deep-merges patch
 * into existing coverage_rules JSONB. Preserves Pattern P-A FIELD_EXCEPTIONS by
 * NOT overwriting non-EOC-authoritative fields.
 */
async function mergeCoverageRules(
  supabase: SupabaseClient,
  planId: string,
  serviceSlug: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const { data: existing } = await supabase
    .from("plan_covered_services")
    .select("id, coverage_rules")
    .eq("plan_id", planId)
    .eq("service_slug", serviceSlug)
    .maybeSingle();

  if (existing) {
    const existingRules = (existing.coverage_rules as Record<string, unknown>) ?? {};
    const merged = { ...existingRules, ...patch };
    await supabase.from("plan_covered_services").update({ coverage_rules: merged }).eq("id", existing.id);
  } else {
    await supabase.from("plan_covered_services").insert({
      plan_id: planId,
      service_slug: serviceSlug,
      coverage_rules: patch,
    });
  }
}

/**
 * Extract ±500 chars around the source_excerpt in the raw doc. For admin context.
 */
function extractContext(parsed: EOCParseResult, excerpt: string): string {
  // Note: parsed doesn't carry rawDocText (would balloon memory). The caller has
  // ocrText but we don't pass it through. v1 simplification: store the source_excerpt
  // ITSELF as context_extract; v1.5 can pass ocrText through if admin UX needs more.
  return excerpt;
  // Suppress unused-parameter lint for parsed (kept for future expansion).
  void parsed;
}

/**
 * Write parse_audit_runs row per Pattern P-7. parser_name='eoc'.
 * structural_completeness = (sections_extracted / 6_priority_sections) for v1 (admin
 * fixture annotation deferred to Phase 6).
 */
async function writeParseAuditRun(
  supabase: SupabaseClient,
  doc: { id: string; user_id: string; file_name: string },
  documentId: string,
  parsed: EOCParseResult,
): Promise<void> {
  const sectionsExtracted = Object.keys(parsed.sections).length;
  const totalPriority = 6;

  const row = {
    run_id: `prod_eoc_${documentId}`,
    parser_version: "phase_3.1A_v1",
    parser_name: "eoc",
    fixture_id: doc.file_name,
    fixture_kind: "bulk_unannotated",
    fields_captured: sectionsExtracted,
    fields_total: totalPriority,
    fields_correct: null, // recall vs ground truth requires fixture annotation (Phase 6)
    cost_usd: parsed.total_cost_usd,
    haiku_tokens_input: parsed.total_input_tokens,
    haiku_tokens_output: parsed.total_output_tokens,
    haiku_cache_read_tokens: 0, // SDK-reported usage breakdown stored in _shared.ts; v1.5 pipe through
    haiku_cache_create_tokens: 0,
    per_field_results: parsed.sections, // section-level results for admin drilldown
    warnings: { eoc_warnings: parsed.warnings, segmentation_used: parsed.segmentation_used },
    parse_duration_ms: null,
    parse_attempt_idx: 1,
    parse_status: parsed.parse_errors.length === 0 ? "success" : "extraction_failed",
  };

  const { error } = await supabase.from("parse_audit_runs").insert(row);
  if (error) {
    console.warn("[process-eoc] parse_audit_runs insert failed (non-fatal):", error.message);
  }
}

/**
 * Count of coverage_rules writes (matched concepts) across all sections. For
 * ProcessPlanResult.servicesCreated.
 */
function countCoverageServices(parsed: EOCParseResult): number {
  const paCount = parsed.sections.prior_auth_codes?.data.codes.length ?? 0;
  const mnCount =
    parsed.sections.medical_necessity?.data.criteria.filter((c) => c.service_slug_hint).length ?? 0;
  return paCount + mnCount;
}
