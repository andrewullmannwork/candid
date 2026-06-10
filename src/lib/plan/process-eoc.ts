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
import { getUserContextByPk } from "@/lib/users/resolve-user-by-pk";
import { parseEOC } from "@/lib/eoc/parser";
import { resolveOrEnqueueConcept } from "@/lib/eoc/concept-resolver";
import type { EOCParseResult, PriorAuthCode, MedicalNecessityCriterion } from "@/lib/eoc/types";
import { routeCriterion, type RouteContext } from "@/lib/eoc/route-criterion";
import { loadEocRoutingConfig } from "@/lib/eoc/routing-config";
import type { ProcessPlanResult } from "@/lib/plan/process-plan";
import { buildEOCPlanIdentityProvenance } from "@/lib/parser/provenance-builders";
import { buildProvenanceEntry } from "@/lib/parser/field-categories";
import { canonicalizeSlug, loadServiceRenameMap, acceptCodeAnchoredSlug } from "@/lib/plan_doc/thesaurus-routing";
import { upsertServiceCoverage, resolveServiceIdBySlug } from "@/lib/plan/coverage-targeting";
import { resolveServices, type ResolveLineInput } from "@/lib/claims/service-resolver";
import { loadValidServiceSlugs, enqueueUnknownServiceSlug, loadServiceVocabularyBlock } from "@/lib/parser/service-catalog-slugs";
import {
  commitUploadAndEvaluateCorroboration,
  PHASE_4_0_6_PLAN_IDENTITY_FIELDS_EOC,
} from "@/lib/parser/commit-and-evaluate";
import {
  writeCanonicalHaikuExtractions,
  generateHaikuRunId,
  extractRowsFromEOCParseResult,
} from "@/lib/parser/canonical-haiku-extractions";
import { validatePlanField } from "@/lib/plan/garbage-validators";
import { recordCostEvent } from "@/lib/cost/parse-cost-events";
import { isFeatureEnabled } from "@/lib/config/product-flags";

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

  // Ing-H (CF-44, S129): resolve cf44_selective_self_check flag — when ON,
  // EOC self-check fires ONLY when column_wrap_score > 0.6. Default ON in
  // PROD per S129 test-on-prod decision; missing flag falls back to false
  // (preserves current always-fire behavior).
  const selectiveSelfCheckEnabled = await isFeatureEnabled("cf44_selective_self_check");

  // 1. Run EOC parser (Pattern P-D + P-8 inheritance via Task 3.1A-C).
  // S180 thesaurus P1 — load the live catalog vocabulary and inject it into the medical_necessity
  // prompt (Pattern S #17: constrain extraction to real slugs, no bare invention). Always-on; on a
  // load failure the block is empty → the prompt degrades gracefully (anti-invention rules remain).
  const serviceVocabulary = await loadServiceVocabularyBlock(supabase);
  // S182 P2 (M1 fix): read `eoc_prose_prior_auth_v1` ONCE here and thread it to BOTH parseEOC (gates the
  // medical_necessity prompt's content-type classification + C1 split) and persistEOCSections (gates the
  // routeCriterion dispatch + telemetry + facts-clear). A single read = one consistent value across
  // parse+persist (no split-brain / mid-parse flip). OFF → byte-identical to post-D1 end-to-end.
  const eocRoutingFlagOn = await isFeatureEnabled("eoc_prose_prior_auth_v1");
  let parsed: EOCParseResult;
  try {
    parsed = await parseEOC(ocrText, {
      documentId,
      extractionMethod: "pdftotext", // upload pipeline uses pdftotext-then-OCR-fallback;
                                      // OCR fallback is refused upstream (Q-P3.1A-12 image-PDF refusal)
      selectiveSelfCheckEnabled,
      serviceVocabulary,
      eocContentTypeRoutingOn: eocRoutingFlagOn,
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

  // ── Ing-B: Garbage-pattern validators on EOC plan-identity ────────────────
  // Same defense surface as process-plan.ts; doc-type-agnostic per
  // feedback_universal_fixes_only. EOC parser today only emits plan_name +
  // insurer_name on plan_identity (metal_tier + group_number not extracted),
  // so we validate the two relevant fields. Mutates parsed.plan_identity
  // in-place so all downstream uses (planFields build, provenance, profile
  // back-populate) see the cleaned values. Gated by garbage_validators_enabled
  // (mig 121, default ON).
  const garbageValidatorsEnabled = await isFeatureEnabled("garbage_validators_enabled");
  if (garbageValidatorsEnabled) {
    const planNameResult = validatePlanField(parsed.plan_identity.plan_name, "plan_name");
    if (planNameResult.warning) {
      parsed.plan_identity.plan_name = null;
      parseWarnings.push(planNameResult.warning);
    }
    const insurerNameResult = validatePlanField(parsed.plan_identity.insurer_name, "insurer_name");
    if (insurerNameResult.warning) {
      parsed.plan_identity.insurer_name = null;
      parseWarnings.push(insurerNameResult.warning);
    }
    if (planNameResult.warning || insurerNameResult.warning) {
      const fired = [planNameResult.warning, insurerNameResult.warning].filter(Boolean);
      console.warn("[process-eoc] Garbage-pattern validator nulled fields:", fired.join(", "));
    }
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
  const persistenceWarnings = await persistEOCSections(supabase, doc, documentId, targetPlanId, parsed, eocRoutingFlagOn);
  parseWarnings.push(...persistenceWarnings);

  // 3.5 Phase 4.0.6 corroboration evaluator post-commit. Single discipline point
  // — all upload paths route through commitUploadAndEvaluateCorroboration helper
  // (Q-P4.0.6-1 LOCK v4; Engineering North Star #1 single code path). EOC
  // plan-identity is regex-extracted (no Pattern P-8 verified excerpts in v1) so
  // EOC's own contribution doesn't count toward corroboration; calling the
  // helper still runs evaluator on this canonical to detect threshold-met state
  // from prior SBC uploads on the same canonical. Phase 5+ may upgrade EOC
  // plan-identity to Pattern P-8 verified excerpts so cross-source corroboration
  // fires. Helper invocation is unconditional post-Task 4.0.6-I cleanup
  // (mig 064 RPC value-write branch sunset 2026-05-04).
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
        documentId: doc.id,
      });
      console.log(
        `[canonical-promotion] [eoc] canonical=${canonicalPlanId} candidates=${candidates.length} fired=${result.promotionsFired} challenges=${result.challengeCandidates} errors=${result.errors.length}`,
      );
      if (result.errors.length > 0) {
        console.error("[canonical-promotion] [eoc] errors:", result.errors);
        parseWarnings.push(...result.errors.map((e) => `canonical_promotion_eoc:${e}`));
      }

      // ── S72 commit 4: canonical_haiku_extractions cite-grade write ──
      // Per-section cite-grade Pattern P-8 source_excerpts from EOC parser
      // (prior_auth_codes / medical_necessity / appeals / cob / eligibility /
      // definitions). Closes CF-20 cite-grade gap for EOC dispute-letter citations.
      // Plan-identity rows excluded — EOC plan_identity is regex-extracted (no P-8).
      // Non-fatal on insert error.
      try {
        const userId = (planRow?.user_id as string | undefined) ?? doc.user_id;
        const { data: docMeta } = await supabase
          .from("documents")
          .select("file_hash")
          .eq("id", documentId)
          .maybeSingle();
        const sourceUserDocHash = (docMeta?.file_hash as string | null | undefined) ?? null;

        const eocRows = extractRowsFromEOCParseResult(parsed);
        const eocWrite = await writeCanonicalHaikuExtractions(supabase, {
          canonicalPlanId,
          userId,
          documentId,
          sourceUserDocHash,
          haikuRunId: generateHaikuRunId("eoc", documentId),
          parserKind: "eoc",
          rows: eocRows,
        });
        console.log(
          `[canonical-haiku-extractions] eoc canonical=${canonicalPlanId} cite_grade_rows_written=${eocWrite.rowsWritten}`,
        );
      } catch (err) {
        console.error("[canonical-haiku-extractions] [eoc] non-fatal write error:", err);
      }
    }
  } catch (err) {
    console.error("[canonical-promotion] [eoc] non-fatal:", err);
  }

  // 4. parse_audit_runs telemetry per Pattern P-7.
  await writeParseAuditRun(supabase, doc, documentId, parsed);

  // 4b. parse_cost_events ledger (Cost-F, S129) — parallel write to unified
  // cost ledger. Same canonicalPlanId lookup as the canonical-promotion
  // block above; done in a fresh small read here to keep the cost write
  // self-contained (negligible round-trip cost).
  try {
    const { data: planRowForCost } = await supabase
      .from("insurance_plans")
      .select("canonical_plan_id, user_id")
      .eq("id", targetPlanId)
      .maybeSingle();
    await recordCostEvent(supabase, {
      canonicalPlanId: (planRowForCost?.canonical_plan_id as string | null | undefined) ?? null,
      insurancePlanId: targetPlanId,
      documentId,
      userId: (planRowForCost?.user_id as string | undefined) ?? doc.user_id,
      parserKind: "eoc_base",
      costSource: "user_upload",
      costUsd: parsed.total_cost_usd,
      haikuTokensInput: parsed.total_input_tokens,
      haikuTokensOutput: parsed.total_output_tokens,
      metadata: {
        sections_extracted: Object.keys(parsed.sections),
        segmentation_used: parsed.segmentation_used,
      },
    });
  } catch (err) {
    console.warn("[parse-cost-events] [eoc] non-fatal:", err);
  }

  // 5. documents.metadata.eoc_sections + Ing-H column_wrap_decision summary write.
  // Ing-H (CF-44, S129) decision struct is co-located with eoc_sections_summary
  // so admin can see "which heuristic decision drove this parse's self-check"
  // alongside the parse output stats.
  // Read-merge-write (NOT a blind overwrite): this must preserve keys written earlier in THIS flow —
  // the G7 eoc_routing_telemetry from persistEOCSections (flag-ON only now; D3) — plus any UPSTREAM
  // documents.metadata keys (cf40_*, adversarial_pdf_assessment). The prior blind overwrite WIPED them.
  // DOCUMENTED CARVE-OUT (M1/D2): this read-merge is an intentional, FLAG-INDEPENDENT correctness fix and
  // is the ONE deliberate exception to "flag-OFF = byte-identical post-D1". Reverting to the blind
  // overwrite would re-introduce data loss (e.g. dropping adversarial_pdf_assessment when THAT separate
  // flag is ON). The byte-identity guarantee is scoped to PLAN DATA + the cite-grade cache, not this
  // observability blob — do NOT "restore" the overwrite to satisfy a literal-bytes reading.
  {
    const { data: docMetaRow } = await supabase
      .from("documents")
      .select("metadata")
      .eq("id", documentId)
      .maybeSingle();
    const existingDocMeta = (docMetaRow?.metadata ?? {}) as Record<string, unknown>;
    await supabase
      .from("documents")
      .update({
        metadata: {
          ...existingDocMeta,
          eoc_sections_summary: {
            segmentation_used: parsed.segmentation_used,
            sections_extracted: Object.keys(parsed.sections),
            total_cost_usd: parsed.total_cost_usd,
            total_input_tokens: parsed.total_input_tokens,
            total_output_tokens: parsed.total_output_tokens,
            parse_errors: parsed.parse_errors,
            warning_count: parsed.warnings.length,
          },
          ...(parsed.column_wrap_decision
            ? { column_wrap_decision: parsed.column_wrap_decision }
            : {}),
        },
      })
      .eq("id", documentId);
  }

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
  // Mig 078 — comparison uploads via /compare must never overwrite the user's
  // primary plan. Read documents.purpose and branch the activation behavior.
  const { data: docMeta } = await supabase
    .from("documents")
    .select("purpose")
    .eq("id", documentId)
    .single();
  const isComparisonUpload = docMeta?.purpose === "comparison";

  // Phase 3.2.1 Q-P3.2.1-2 — Pattern P-8 plan-identity provenance for EOC writes.
  // EOC plan_identity comes from regex parsePlanDocument (per Q-P3.1A-11) so there's
  // no patternP8 sub-keys; entries carry source="doc_extraction_eoc" + confidence +
  // last_corroborated_at only. Cross-source corroboration with SBC plan-identity
  // (where values match) lifts confidence via Pattern 1 #3 — corroboration is value-
  // match-based, not excerpt-match-based, so absence of P-8 sub-keys here doesn't
  // break the flywheel.
  const eocPlanIdentityProvenance = buildEOCPlanIdentityProvenance(parsed.plan_identity);
  const hasProvenanceEntries = Object.keys(eocPlanIdentityProvenance).length > 0;

  // S74.6 D1 §A.1 — prefer Haiku-extracted ACA-compliance signal from EOC
  // text; fall back to the conservative-for-users default when (a) the
  // standalone dispatch failed (aca_compliance === null) or (b) Haiku found
  // no signal in the bounded text slice (isAcaCompliant === null AND
  // acaComplianceBasis === null). The default keeps D2 registry fallback
  // working for first-parse EOC-only uploads; a subsequent SBC or plan_doc
  // Haiku upload may overwrite via the merge-update path in process-plan.ts.
  const acaExtracted = parsed.aca_compliance?.data;
  const acaHasSignal =
    !!acaExtracted &&
    (acaExtracted.isAcaCompliant !== null || acaExtracted.acaComplianceBasis !== null);
  const acaFields = acaHasSignal && acaExtracted
    ? {
        is_aca_compliant: acaExtracted.isAcaCompliant,
        aca_compliance_basis: acaExtracted.acaComplianceBasis ?? "unknown",
        aca_compliance_source: "eoc_parser",
        aca_compliance_excerpt: acaExtracted.source_excerpt,
      }
    : {
        is_aca_compliant: true,
        aca_compliance_basis: "unknown",
        aca_compliance_source: "eoc_parser_default",
        aca_compliance_excerpt: "",
      };

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
    // Comparison uploads start inactive (live in insurance_plans for the
    // canonical-corroboration flywheel but never become primary).
    is_active: !isComparisonUpload,
    verification_status: "document_verified" as const,
    ...(hasProvenanceEntries ? { field_provenance: eocPlanIdentityProvenance } : {}),
    ...acaFields,
  };

  // Check for existing active plan for this user — comparison uploads SKIP
  // the merge path entirely (a comparison plan is a separate plan, not an
  // enrichment of the user's primary).
  const { data: existingActive } = isComparisonUpload
    ? { data: null }
    : await supabase
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

  // Back-populate profile pointer — but NOT for comparison uploads (they
  // must never become the user's active plan).
  if (!isComparisonUpload) {
    await supabase
      .from("profiles")
      .update({
        active_insurance_plan_id: newPlan.id,
        ...(planFields.insurer_name ? { insurer: planFields.insurer_name } : {}),
        ...(planFields.plan_name ? { plan_name: planFields.plan_name } : {}),
      })
      .eq("user_id", doc.user_id);
  }

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
  eocRoutingFlagOn: boolean,
): Promise<string[]> {
  const warnings: string[] = [];

  // Resolve the proposer's users.id from doc.user_id (which IS the users PK, NOT a
  // firebase_uid; proposed_by_user_id is a UUID). S164: was .eq("firebase_uid", …),
  // which never matched → proposedByUserId null → concept/slug enqueue attribution
  // silently dropped. Convention: src/lib/users/resolve-user-by-pk.ts.
  const userRow = await getUserContextByPk(supabase, doc.user_id, "process-eoc:concept-enqueue");
  const proposedByUserId = userRow?.id ?? null;
  if (!proposedByUserId) {
    warnings.push(`eoc_persist_user_lookup_failed:${doc.user_id}`);
  }

  // ── P2 content-routing collectors (filled by Section B's routeCriterion dispatch) ──────────────
  // `codeAnchoredPaSlugs`: slugs Section A (code tables) already set prior_auth_required on → code wins
  // the dedup tie (D1); Section B prose-PA defers. Structured PA facts (axis / plan-wide / waived /
  // low-conf) + admin provisions are captured here and flushed to insurance_plans.metadata below.
  const codeAnchoredPaSlugs = new Set<string>();
  const eocPriorAuthFacts: Array<Record<string, unknown>> = [];
  const eocCoverageProvisions: Array<Record<string, unknown>> = [];
  const routingTelemetry: Record<string, number> = {};
  const tallyRoute = (reason: string): void => {
    routingTelemetry[reason] = (routingTelemetry[reason] ?? 0) + 1;
  };
  // The routing flag is read ONCE in the orchestrator (above parseEOC) and passed in as a param, so the
  // prompt gating and this dispatch share a single consistent value (no split-brain / mid-parse flip).
  // Flag OFF → byte-identical post-D1 routing. The config (floor) is only consumed flag-ON; absent → 0.7.
  const eocRoutingConfig = await loadEocRoutingConfig(supabase);
  // Loaded once + shared by Section A and Section B so the dead→live canonicalization (and the D1 dedup
  // keyed on the canonical slug) is provably identical across both sections.
  const renameMap = await loadServiceRenameMap(supabase);

  // ── Section A: prior_auth_codes ──────────────────────────────────────────────
  if (parsed.sections.prior_auth_codes && proposedByUserId) {
    const thesaurusOn = await isFeatureEnabled("thesaurus_phase1a_v1");
    // Accumulate by canonicalized SLUG (not service_id): EOC prior-auth tables run 5–50 pages of
    // codes, many collapsing to one service — so the slug→id lookup + the typed column + provenance
    // happen ONCE per service, not per code.
    const bySlug = new Map<string, { code: PriorAuthCode; criteria: string[] }>();
    const accumulate = (slug: string, code: PriorAuthCode): void => {
      const acc = bySlug.get(slug) ?? { code, criteria: [] };
      if (code.pa_criteria) acc.criteria.push(code.pa_criteria);
      bySlug.set(slug, acc);
    };
    // Codes the concept registry gave no usable slug for → candidates for the bills-fed code-cache
    // rescue (D1-A). The line index lets the single batched resolver map results back.
    const rescue: Array<{ line: number; code: PriorAuthCode }> = [];

    // Pass 1 — concept registry (curated authority) + Pattern 1 #1 admin gate.
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
        if (!result.matched) {
          // Unknown code: enqueued for admin (Pattern 1 #1, preserved). The coverage write is
          // still rescuable from the corroborated code-cache below.
          warnings.push(`eoc_unknown_pa_code_enqueued:${code.billing_code}:${code.billing_code_type}`);
          rescue.push({ line: rescue.length, code });
        } else if (result.serviceSlug) {
          // Matched concept's slug WINS (curated authority); canonicalize dead→live.
          accumulate(canonicalizeSlug(result.serviceSlug, renameMap), code);
        } else {
          // Concept matched but carries no service_slug mapping — also rescuable.
          rescue.push({ line: rescue.length, code });
        }
      } catch (err) {
        warnings.push(`eoc_pa_code_persist_failed:${code.billing_code}:${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Pass 2 (D1-A, flag-gated) — bills-fed CODE-cache rescue for codes the registry couldn't slug.
    // ONE batched resolveServices (cache-first; no Haiku, no writeback). ACCEPT ONLY a code_cache
    // hit (`acceptCodeAnchoredSlug`): the "description" here is criteria prose, so a signature/trigram
    // match would manufacture a wrong slug. OFF → today's behavior (coverage dropped).
    if (thesaurusOn && rescue.length > 0) {
      const lines: ResolveLineInput[] = rescue.map((r) => ({
        lineNumber: r.line,
        description: r.code.pa_criteria ?? "",
        billingCode: r.code.billing_code,
        billingCodeType: r.code.billing_code_type,
      }));
      try {
        const resolved = await resolveServices(lines, {
          supabase,
          userId: proposedByUserId,
          skipHaiku: true,
          skipWriteback: true,
        });
        for (const r of rescue) {
          const slug = acceptCodeAnchoredSlug(resolved.get(r.line));
          if (slug) accumulate(canonicalizeSlug(slug, renameMap), r.code);
        }
      } catch (err) {
        warnings.push(`eoc_pa_rescue_failed:${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Write once per service: set the EOC-authoritative typed `prior_auth_required` column (what
    // /plan + /compare actually read) + its field_provenance (cite-grade, the SAME key + builder the
    // SBC/plan-doc parsers use) + the criteria detail in coverage_rules JSONB. A PA-required service
    // is a real covered service → create a base cell if it has none.
    for (const [slug, acc] of bySlug) {
      const serviceId = await resolveServiceIdBySlug(supabase, slug);
      if (!serviceId) {
        warnings.push(`eoc_pa_slug_no_service_id:${slug}`);
        continue;
      }
      const provEntry = buildProvenanceEntry(
        "plan_covered_services",
        "prior_auth_required",
        "doc_extraction_eoc",
        acc.code.haiku_confidence,
        {
          sourceExcerpt: acc.code.source_excerpt,
          sourceExcerptVerified: acc.code.source_excerpt_verified,
          sourceExcerptExtractionMethod: acc.code.source_excerpt_extraction_method,
          sourceSectionHint: acc.code.source_section_hint,
          sourceSectionVerified: acc.code.source_section_verified,
        },
      );
      try {
        await upsertServiceCoverage(
          supabase,
          planId,
          serviceId,
          {
            typed: { prior_auth_required: true },
            provenance: provEntry ? { prior_auth_required: provEntry } : undefined,
            coverageRules: {
              requires_prior_auth: true,
              prior_auth_criteria: acc.criteria[0] ?? acc.code.pa_criteria ?? null,
              prior_auth_all_criteria: acc.criteria,
              prior_auth_source_excerpt: acc.code.source_excerpt,
              prior_auth_source_excerpt_verified: acc.code.source_excerpt_verified,
            },
          },
          { allowBaseCell: true },
        );
        codeAnchoredPaSlugs.add(slug); // code-anchored PA recorded → Section B prose-PA defers (D1 dedup)
      } catch (err) {
        warnings.push(`eoc_pa_write_failed:${slug}:${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // ── Section B: medical_necessity (P2 content-type routing) ───────────────────────────────────────
  // Each extracted fact carries a `type` (T1); `routeCriterion` (pure, T2) decides its store. Flag OFF →
  // byte-identical post-D1 (type ignored: valid slug → coverage_rules, unknown → admin enqueue, no slug →
  // drop). Flag ON → route by type: clinical → coverage_rules; service-specific prior_auth (requires,
  // confident, deduped vs Section-A code-PA) → the typed prior_auth_required column; admin / axis / waived /
  // low-conf / no-slug PA → captured in insurance_plans.metadata (never silently dropped, never wrongly
  // surfaced). validSlugs uses service_catalog (broad), not STANDARD_SLUGS, so EOC-legitimate slugs survive.
  if (parsed.sections.medical_necessity && proposedByUserId) {
    const validSlugs = await loadValidServiceSlugs(supabase);
    const ctx: RouteContext = {
      flagOn: eocRoutingFlagOn,
      confidenceFloor: eocRoutingConfig.prosePaTypeConfidenceFloor,
      validSlugs,
      renameMap,
    };

    for (const criterion of parsed.sections.medical_necessity.data.criteria) {
      const decision = routeCriterion(criterion, ctx);
      const canonSlug = criterion.service_slug_hint
        ? canonicalizeSlug(criterion.service_slug_hint, renameMap)
        : null;

      switch (decision.store) {
        case "drop":
          tallyRoute(decision.reason);
          warnings.push(`eoc_mn_drop:${decision.reason}:criteria_text_len_${criterion.criteria_text.length}`);
          break;

        case "enqueue_unknown_slug": {
          tallyRoute(decision.reason);
          if (!canonSlug) break;
          // Pattern 1 #1 admin gate for slug growth (unchanged behavior; canonicalized hint already applied).
          try {
            const { isNew } = await enqueueUnknownServiceSlug(supabase, {
              sourceDocId: documentId,
              proposedByUserId,
              parserSource: "eoc",
              proposedServiceSlug: canonSlug,
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
                ? `eoc_medical_necessity_slug_enqueued_new:${canonSlug}`
                : `eoc_medical_necessity_slug_enqueued_existing:${canonSlug}`,
            );
          } catch (err) {
            warnings.push(`eoc_medical_necessity_slug_enqueue_failed:${canonSlug}:${err instanceof Error ? err.message : String(err)}`);
          }
          break;
        }

        case "coverage_rules": {
          tallyRoute(decision.reason);
          if (!canonSlug) break;
          // Clinical criterion → coverage_rules on EXISTING cells ONLY (no phantom covered=true base cell;
          // no typed column / /plan reader for medical necessity yet — a deliberate follow-up). Today's path.
          const serviceId = await resolveServiceIdBySlug(supabase, canonSlug);
          if (!serviceId) {
            warnings.push(`eoc_medical_necessity_no_service_id:${canonSlug}`);
            break;
          }
          try {
            await upsertServiceCoverage(
              supabase,
              planId,
              serviceId,
              {
                coverageRules: {
                  medical_necessity_text: criterion.criteria_text,
                  diagnosis_qualifiers: criterion.diagnosis_qualifiers,
                  medical_necessity_source_excerpt: criterion.source_excerpt,
                  medical_necessity_source_excerpt_verified: criterion.source_excerpt_verified,
                },
              },
              { allowBaseCell: false },
            );
          } catch (err) {
            warnings.push(`eoc_medical_necessity_persist_failed:${canonSlug}:${err instanceof Error ? err.message : String(err)}`);
          }
          break;
        }

        case "admin_metadata":
          tallyRoute(decision.reason);
          // Out of coverage_rules (the over-capture fix); preserved, reversibly, in plan metadata.
          eocCoverageProvisions.push(buildAdminProvisionRecord(criterion, canonSlug));
          break;

        case "pa_facts":
          tallyRoute(decision.reason);
          // Captured-not-surfaced: axis / plan-wide / waived / low-conf / no-slug PA. The pre-launch
          // reader-resolution block reads this carve-out-ready record to apply axis/plan-wide/waived PA.
          eocPriorAuthFacts.push(buildPriorAuthFactRecord(criterion, canonSlug, decision.reason));
          break;

        case "pa_column": {
          // Tally the ACTUAL terminal outcome, not the router's optimistic decision: pa_column can re-route
          // to pa_facts at runtime (code-dedup / no service id) and the write can throw — the G7 instrument
          // must reflect what truly happened (else it overstates user-visible PA writes).
          if (!canonSlug) {
            tallyRoute("pa_column_no_slug_defensive"); // unreachable (pa_column ⇒ slugValid); defensive
            break;
          }
          // Section-A dedup (D1): a code-anchored PA already wrote this slug → code wins the 0.5 tie. Do
          // not clobber its cite-grade provenance; capture the prose corroboration in the structured record.
          if (codeAnchoredPaSlugs.has(canonSlug)) {
            tallyRoute("pa_requires_code_dedup");
            warnings.push(`eoc_prose_pa_deduped_code_wins:${canonSlug}`);
            eocPriorAuthFacts.push(buildPriorAuthFactRecord(criterion, canonSlug, "pa_requires_code_dedup"));
            break;
          }
          const serviceId = await resolveServiceIdBySlug(supabase, canonSlug);
          if (!serviceId) {
            // No service row to carry the typed column → capture instead of dropping.
            tallyRoute("pa_requires_no_service_id");
            eocPriorAuthFacts.push(buildPriorAuthFactRecord(criterion, canonSlug, "pa_requires_no_service_id"));
            break;
          }
          const provEntry = buildProvenanceEntry(
            "plan_covered_services",
            "prior_auth_required",
            "doc_extraction_eoc",
            criterion.haiku_confidence,
            {
              sourceExcerpt: criterion.source_excerpt,
              sourceExcerptVerified: criterion.source_excerpt_verified,
              sourceExcerptExtractionMethod: criterion.source_excerpt_extraction_method,
              sourceSectionHint: criterion.source_section_hint,
              sourceSectionVerified: criterion.source_section_verified,
            },
          );
          try {
            // Same typed col + provenance builder the SBC/plan-doc/Section-A parsers use → cite-grade parity.
            await upsertServiceCoverage(
              supabase,
              planId,
              serviceId,
              {
                typed: { prior_auth_required: true },
                provenance: provEntry ? { prior_auth_required: provEntry } : undefined,
                coverageRules: {
                  requires_prior_auth: true,
                  prior_auth_criteria: criterion.criteria_text,
                  prior_auth_source_excerpt: criterion.source_excerpt,
                  prior_auth_source_excerpt_verified: criterion.source_excerpt_verified,
                },
              },
              { allowBaseCell: true },
            );
            tallyRoute("pa_requires_service_specific"); // only count the column write on SUCCESS
          } catch (err) {
            tallyRoute("pa_requires_write_failed");
            warnings.push(`eoc_prose_pa_write_failed:${canonSlug}:${err instanceof Error ? err.message : String(err)}`);
          }
          break;
        }

        default: {
          // Exhaustiveness guard: a future RouteStore member forces a COMPILE error here (the `never`
          // assignment), and defensively never silently drops at runtime (the anti-flywheel behavior this
          // routing was built to eliminate).
          const _exhaustive: never = decision.store;
          tallyRoute("unrouted");
          warnings.push(`eoc_mn_unrouted:${String(_exhaustive)}`);
          break;
        }
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
  // P2: structured PA facts + admin provisions from Section B's dispatch are SET here when this parse
  // produced them (flag-ON only); the stale-key CLEAR for a flag-ON→OFF rollback is handled just below (D4).
  const sectionBRan = Boolean(parsed.sections.medical_necessity) && Boolean(proposedByUserId);
  if (eocPriorAuthFacts.length > 0) planMetadataPatch.eoc_prior_auth_facts = eocPriorAuthFacts;
  if (eocCoverageProvisions.length > 0) planMetadataPatch.eoc_coverage_provisions = eocCoverageProvisions;
  // REPLACE-per-parse clear: a parse that RAN Section B but produced no PA-facts/provisions should drop any
  // STALE key a prior flag-ON parse left behind (rollback hygiene). M1/D4 fix: only schedule a clear for a
  // key that ACTUALLY EXISTS, so a clean parse with no stale P2 keys (including ANY flag-OFF parse, where
  // routeCriterion can never emit pa_facts/admin_metadata) issues ZERO insurance_plans writes — no spurious
  // `updated_at` bump → byte-identical to post-D1. The auto-cleanup after a real flag-ON→OFF rollback is
  // preserved (it fires only when there is genuinely a key to remove).
  const mayNeedFactsClear = sectionBRan && eocPriorAuthFacts.length === 0;
  const mayNeedProvClear = sectionBRan && eocCoverageProvisions.length === 0;

  if (Object.keys(planMetadataPatch).length > 0 || mayNeedFactsClear || mayNeedProvClear) {
    // Read existing metadata, merge (preserve other keys), drop ONLY genuinely-present stale keys, write back.
    const { data: planRow } = await supabase
      .from("insurance_plans")
      .select("metadata")
      .eq("id", planId)
      .single();
    const existingMetadata = (planRow?.metadata as Record<string, unknown>) ?? {};
    const clearKeys: string[] = [];
    if (mayNeedFactsClear && existingMetadata.eoc_prior_auth_facts !== undefined) clearKeys.push("eoc_prior_auth_facts");
    if (mayNeedProvClear && existingMetadata.eoc_coverage_provisions !== undefined) clearKeys.push("eoc_coverage_provisions");
    // Nothing to patch AND nothing genuinely stale to clear → no write at all (the clean flag-OFF no-op path).
    if (Object.keys(planMetadataPatch).length > 0 || clearKeys.length > 0) {
      const mergedMetadata = { ...existingMetadata, ...planMetadataPatch };
      for (const k of clearKeys) delete mergedMetadata[k];
      await supabase.from("insurance_plans").update({ metadata: mergedMetadata }).eq("id", planId);
    }
  }

  // Non-fire telemetry (Ship Gate G7): the per-parse routing distribution — captures what was routed
  // AWAY (admin out of coverage_rules, low-conf/waived/axis PA parked), not just what was written. Non-fatal.
  // FLAG-GATED (M1/D3 fix): written ONLY when routing is ON. Flag OFF → routeCriterion is byte-identical
  // post-D1 (no real routing decisions to measure — only `flag_off_*` buckets), and adding a new
  // documents.metadata key would break the byte-identical-rollback guarantee. For a flag-OFF distribution,
  // log it out-of-band — never into documents.metadata (which is inside the byte-identity surface).
  if (eocRoutingFlagOn && Object.keys(routingTelemetry).length > 0) {
    try {
      const { data: docRow } = await supabase
        .from("documents")
        .select("metadata")
        .eq("id", documentId)
        .maybeSingle();
      const existingDocMeta = (docRow?.metadata ?? {}) as Record<string, unknown>;
      await supabase
        .from("documents")
        .update({
          metadata: {
            ...existingDocMeta,
            eoc_routing_telemetry: {
              counts: routingTelemetry,
              flag_on: eocRoutingFlagOn,
              prose_pa_type_confidence_floor: eocRoutingConfig.prosePaTypeConfidenceFloor,
              decided_at: new Date().toISOString(),
            },
          },
        })
        .eq("id", documentId);
    } catch (err) {
      warnings.push(`eoc_routing_telemetry_write_failed:${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return warnings;
}

/**
 * Build a carve-out-ready `eoc_prior_auth_facts[]` record (P2). Holds `service_slug` + `place_of_service`
 * (axis) + `polarity` (requires/waived) so the pre-launch reader-resolution block can apply axis / plan-wide
 * / waived PA. `routing_reason` records WHY it landed here (axis / no-slug / low-conf / waived / dedup).
 */
function buildPriorAuthFactRecord(
  c: MedicalNecessityCriterion,
  canonicalSlug: string | null,
  routingReason: string,
): Record<string, unknown> {
  return {
    service_slug: canonicalSlug,
    place_of_service: c.place_of_service,
    polarity: c.pa_polarity,
    routing_reason: routingReason,
    criteria_text: c.criteria_text,
    source_excerpt: c.source_excerpt,
    source_excerpt_verified: c.source_excerpt_verified,
    type_confidence: c.type_confidence,
  };
}

/** Build an `eoc_coverage_provisions[]` record — admin provisions routed OUT of coverage_rules (reversible). */
function buildAdminProvisionRecord(
  c: MedicalNecessityCriterion,
  canonicalSlug: string | null,
): Record<string, unknown> {
  return {
    service_slug: canonicalSlug,
    place_of_service: c.place_of_service,
    text: c.criteria_text,
    source_excerpt: c.source_excerpt,
    source_excerpt_verified: c.source_excerpt_verified,
    type_confidence: c.type_confidence,
  };
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
