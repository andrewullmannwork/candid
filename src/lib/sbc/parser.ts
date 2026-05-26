/**
 * SBC Haiku-first parser — Phase 3.2 main orchestrator.
 *
 * Architecture (Q-P3.2-2 LOCK = REPLACE; Q-P3.2-3 LOCK = per-section dispatch):
 *   1. Section segmentation — regex detect 5 SBC sections + preamble synthesis
 *   2. Per-section Haiku dispatch in parallel (Promise.allSettled)
 *   3. Cost-cap pre-dispatch 90% threshold guard per section
 *   4. Slug validation (concept-resolver.ts) — drop unknown service slugs
 *   5. Pattern P-8 verification (whitespace + Unicode normalized fallback)
 *   6. Cost telemetry summed per Q-DR-3D-5
 *
 * Recall-maximize bias per `feedback_candid_recall_over_precision`. Citation-grade
 * strictness preserved at consumer-read layer (Pattern P-8 hard rule unchanged).
 *
 * Cost ceiling per Q-P3.2-5 LOCK: $0.50 soft / $2.00 hard (per-section × N=3
 * voting headroom; per-section dispatch typically yields $0.05-0.15 baseline).
 */

import type { ExtractionMethod, SectionRanges } from "../parser/types";
import { countPrioritySBCSections, segmentSBCSections, sliceSection } from "./section-segment";
import type {
  SBCHaikuParseResult,
  SBCHaikuService,
  SBCPlanIdentity,
  SBCSectionResult,
  SBCSectionHint,
} from "./types";
import { extractImportantQuestions } from "./haiku-prompts/important-questions";
import { extractCommonMedicalEvents } from "./haiku-prompts/common-medical-events";
import { extractOtherCovered } from "./haiku-prompts/other-covered";
import { extractExcludedServices } from "./haiku-prompts/excluded-services";
import { extractAppealsGrievances } from "./haiku-prompts/appeals-grievances";
import { validateServiceSlugs, type SlugEnqueueContext } from "./concept-resolver";
import { verifySBCSourceExcerpts } from "./verify-source-excerpts";
import { isSBCSelfCheckEnabled, selfCheckSBCExcerpts } from "./self-check";
import { computeColumnWrapDecision } from "./column-wrap-detector";

const COST_HARD_CAP_USD = 2.0;
const COST_GUARD_THRESHOLD_USD = 0.9; // 90% of hard cap; pre-dispatch chunk-skip guard
const COST_SOFT_ALARM_USD = 0.5;

interface CostTracker {
  totalUsd: number;
}

function emptyPlanIdentity(extractionMethod: ExtractionMethod): SBCPlanIdentity {
  const emptyP8 = {
    source_excerpt: "",
    source_excerpt_verified: "not_found" as const,
    source_excerpt_extraction_method: extractionMethod,
    source_section_hint: "important_questions" as SBCSectionHint,
    source_section_verified: false,
  };
  const emptyString = { value: null as string | null, patternP8: emptyP8 };
  const emptyNumber = { value: null as number | null, patternP8: emptyP8 };
  const emptyBool = { value: null as boolean | null, patternP8: emptyP8 };
  return {
    planName: emptyString,
    insurerName: emptyString,
    planType: emptyString,
    metalTier: emptyString,
    coverageTier: emptyString,
    planYear: emptyNumber,
    coveragePeriodStart: emptyString,
    deductibleIndividual: emptyNumber,
    deductibleFamily: emptyNumber,
    oopMaxIndividual: emptyNumber,
    oopMaxFamily: emptyNumber,
    // CF-19c (Session 64): OON plan-identity scalars
    outDeductibleIndividual: emptyNumber,
    outDeductibleFamily: emptyNumber,
    outOopMaxIndividual: emptyNumber,
    outOopMaxFamily: emptyNumber,
    rxDeductibleIndividual: emptyNumber,
    rxDeductibleFamily: emptyNumber,
    referralRequired: emptyBool,
    minimumValueStandard: emptyBool,
    // S74.6 D1 — ACA-compliance flag (default null; persistence layer applies
    // is_aca_compliant=TRUE + basis='unknown' default when Haiku didn't emit).
    isAcaCompliant: emptyBool,
    acaComplianceBasis: emptyString,
  };
}

interface SectionDispatchPlan<T> {
  hint: SBCSectionHint;
  sectionText: string | null;
  sectionRange: { start: number; end: number } | null;
  fn: (
    text: string,
    range: { start: number; end: number },
    em: ExtractionMethod,
  ) => Promise<SBCSectionResult<T>>;
}

/**
 * Run a section's Haiku dispatch with cost-cap pre-dispatch guard.
 * Returns null if section not detected or cost cap breached.
 */
async function dispatchSection<T>(
  plan: SectionDispatchPlan<T>,
  extractionMethod: ExtractionMethod,
  costTracker: CostTracker,
  warnings: string[],
): Promise<SBCSectionResult<T> | null> {
  if (!plan.sectionText || !plan.sectionRange) {
    return null;
  }
  if (costTracker.totalUsd > COST_HARD_CAP_USD * COST_GUARD_THRESHOLD_USD) {
    warnings.push(`section_skipped_near_cost_cap:${plan.hint}`);
    return null;
  }
  try {
    const result = await plan.fn(plan.sectionText, plan.sectionRange, extractionMethod);
    costTracker.totalUsd += result.haiku_cost_usd;
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    warnings.push(`section_failed:${plan.hint}:${msg}`);
    return null;
  }
}

export interface ParseSBCInput {
  ocrText: string;
  extractionMethod: ExtractionMethod;
  // Bundle PR #1 (Session 55, audit item #8) — optional admin-queue context for
  // unknown slug routing (Pattern 1 #1). When omitted (e.g., parse-harness),
  // unknowns are dropped with warning (legacy behavior). When present (production
  // parse path), unknowns are enqueued to service_catalog_admin_review_queue.
  enqueueContext?: Omit<SlugEnqueueContext, "sectionHint"> | null;
  // Ing-H (CF-44, S129) — caller-resolved cf44_selective_self_check flag value.
  // When true, self-check fires only when column_wrap_score > 0.6. When false
  // (or omitted), preserves current always-fire behavior (env-var-gated).
  selectiveSelfCheckEnabled?: boolean;
}

export async function parseSBC(input: ParseSBCInput): Promise<SBCHaikuParseResult> {
  const { ocrText, extractionMethod, enqueueContext } = input;
  const selectiveSelfCheckEnabled = input.selectiveSelfCheckEnabled ?? false;
  const warnings: string[] = [];
  const costTracker: CostTracker = { totalUsd: 0 };

  // Step 1: Section segmentation
  const sectionRanges: SectionRanges = segmentSBCSections(ocrText);
  const detectedCount = countPrioritySBCSections(sectionRanges);
  if (detectedCount < 3) {
    warnings.push(`low_section_detection:detected=${detectedCount}/5`);
  }

  // Step 2: Build per-section dispatch plans
  const importantQuestionsRange = sectionRanges.important_questions?.[0] ?? null;
  const commonMedicalEventsRange = sectionRanges.common_medical_events?.[0] ?? null;
  const otherCoveredRange = sectionRanges.other_covered_services?.[0] ?? null;
  const excludedServicesRange = sectionRanges.excluded_services?.[0] ?? null;
  const appealsGrievancesRange = sectionRanges.appeals_grievances?.[0] ?? null;

  const importantQuestionsPlan: SectionDispatchPlan<SBCPlanIdentity> = {
    hint: "important_questions",
    sectionText: sliceSection(ocrText, sectionRanges, "important_questions"),
    sectionRange: importantQuestionsRange,
    fn: extractImportantQuestions,
  };
  const commonMedicalEventsPlan: SectionDispatchPlan<{ services: SBCHaikuService[] }> = {
    hint: "common_medical_events",
    sectionText: sliceSection(ocrText, sectionRanges, "common_medical_events"),
    sectionRange: commonMedicalEventsRange,
    fn: extractCommonMedicalEvents,
  };
  const otherCoveredPlan: SectionDispatchPlan<{ services: SBCHaikuService[] }> = {
    hint: "other_covered_services",
    sectionText: sliceSection(ocrText, sectionRanges, "other_covered_services"),
    sectionRange: otherCoveredRange,
    fn: extractOtherCovered,
  };
  const excludedServicesPlan: SectionDispatchPlan<{
    excludedServices: string[];
    patternP8: SBCHaikuParseResult["excludedServicesPatternP8"];
    haikuConfidence?: number;
  }> = {
    hint: "excluded_services",
    sectionText: sliceSection(ocrText, sectionRanges, "excluded_services"),
    sectionRange: excludedServicesRange,
    fn: extractExcludedServices,
  };
  const appealsPlan: SectionDispatchPlan<{ contacts: SBCHaikuParseResult["appealsContacts"] }> = {
    hint: "appeals_grievances",
    sectionText: sliceSection(ocrText, sectionRanges, "appeals_grievances"),
    sectionRange: appealsGrievancesRange,
    fn: extractAppealsGrievances,
  };

  // Step 3: Sequential dispatch (sequential to enforce cost-cap precisely; sections are small).
  // Note: we COULD parallelize via Promise.allSettled like EOC, but cost-cap pre-dispatch
  // guard requires sequential execution to honor the 90% threshold. SBC sections are small
  // (5 calls × $0.05-0.15 baseline = ~$0.25-0.75), so latency overhead is acceptable.
  const importantQuestionsResult = await dispatchSection(importantQuestionsPlan, extractionMethod, costTracker, warnings);
  const commonMedicalEventsResult = await dispatchSection(commonMedicalEventsPlan, extractionMethod, costTracker, warnings);
  const otherCoveredResult = await dispatchSection(otherCoveredPlan, extractionMethod, costTracker, warnings);
  const excludedServicesResult = await dispatchSection(excludedServicesPlan, extractionMethod, costTracker, warnings);
  const appealsResult = await dispatchSection(appealsPlan, extractionMethod, costTracker, warnings);

  // Phase 4.0.5: track dispatchedSections for verbatim_absent derivation +
  // searched_sections population on FieldProvenanceEntry per Q-P4.0.5-2 LOCK.
  const dispatchedSections: SBCSectionHint[] = [
    importantQuestionsResult ? "important_questions" : null,
    commonMedicalEventsResult ? "common_medical_events" : null,
    otherCoveredResult ? "other_covered_services" : null,
    excludedServicesResult ? "excluded_services" : null,
    appealsResult ? "appeals_grievances" : null,
  ].filter((s): s is SBCSectionHint => s !== null);

  // Cost soft alarm
  if (costTracker.totalUsd > COST_SOFT_ALARM_USD) {
    warnings.push(`cost_soft_alarm:${costTracker.totalUsd.toFixed(4)}`);
  }

  // Step 4: Slug validation (drop unknown slugs + Pattern 1 #1 admin gate enqueue
  // when enqueueContext is provided per Bundle PR #1 audit item #8 close).
  const rawCommonServices = commonMedicalEventsResult?.data.services ?? [];
  const rawOtherServices = otherCoveredResult?.data.services ?? [];
  const commonCtx: SlugEnqueueContext | null = enqueueContext
    ? { ...enqueueContext, sectionHint: "common_medical_events" }
    : null;
  const otherCtx: SlugEnqueueContext | null = enqueueContext
    ? { ...enqueueContext, sectionHint: "other_covered_services" }
    : null;
  const commonValidation = await validateServiceSlugs(rawCommonServices, commonCtx);
  const otherValidation = await validateServiceSlugs(rawOtherServices, otherCtx);
  warnings.push(...commonValidation.warnings, ...otherValidation.warnings);
  // Push section warnings into top-level warnings
  if (commonMedicalEventsResult?.warnings) warnings.push(...commonMedicalEventsResult.warnings);
  if (otherCoveredResult?.warnings) warnings.push(...otherCoveredResult.warnings);
  if (importantQuestionsResult?.warnings) warnings.push(...importantQuestionsResult.warnings);
  if (excludedServicesResult?.warnings) warnings.push(...excludedServicesResult.warnings);
  if (appealsResult?.warnings) warnings.push(...appealsResult.warnings);

  // Step 5: Sum telemetry
  const sectionResults = [
    importantQuestionsResult,
    commonMedicalEventsResult,
    otherCoveredResult,
    excludedServicesResult,
    appealsResult,
  ].filter((r): r is NonNullable<typeof r> => r !== null);

  const haikuTokensInput = sectionResults.reduce((s, r) => s + r.haiku_input_tokens, 0);
  const haikuTokensOutput = sectionResults.reduce((s, r) => s + r.haiku_output_tokens, 0);
  const totalCostUsd = sectionResults.reduce((s, r) => s + r.haiku_cost_usd, 0);

  // Step 6: Assemble pre-verification result
  const preVerificationResult: SBCHaikuParseResult = {
    planIdentity: importantQuestionsResult?.data ?? emptyPlanIdentity(extractionMethod),
    services: commonValidation.validServices,
    otherCoveredServices: otherValidation.validServices,
    excludedServices: excludedServicesResult?.data.excludedServices ?? [],
    excludedServicesPatternP8: excludedServicesResult?.data.patternP8 ?? null,
    appealsContacts: appealsResult?.data.contacts ?? [],
    parseWarnings: warnings,
    haikuTokensInput,
    haikuTokensOutput,
    haikuCacheCreateTokens: 0, // populated by callHaikuWithCache via response.usage
    haikuCacheReadTokens: 0,
    costUsd: totalCostUsd,
    parseStrategyV2: true,
    dispatchedSections,
  };

  // Step 7: Pattern P-8 verification (insurer-agnostic; uses shared verifier)
  let verifiedResult = verifySBCSourceExcerpts(ocrText, preVerificationResult, sectionRanges);

  // Step 8: Self-check loop (Iter 2 contingency) — env-var gated
  // Fires when SBC_SELF_CHECK_ENABLED=true. For each Pattern P-8 field with
  // source_excerpt_verified='not_found' AND non-empty excerpt, re-prompt Haiku
  // to emit a corrected verbatim substring. Mirrors Phase 3.1A.1 EOC + S77
  // plan_doc self-check patterns.
  //
  // Per-parser policy (Session 77): SBC self-check enabled in PROD because
  // multi-column tabular SBC layouts produce pdftotext column-wrap garbling
  // that first-pass verbatim verification rejects despite correct extraction.
  // Empirical (Kaiser Gold 80): services cite-grade 74.5% → 97.9% with self-check.
  //
  // Ing-H (CF-44, S129) selective gate: when cf44_selective_self_check flag is
  // ON (resolved by caller + passed as input.selectiveSelfCheckEnabled),
  // self-check fires ONLY when column_wrap_score > 0.6. Estimated ~90% cost
  // reduction on self-check pass while preserving recall benefit on the docs
  // that actually need it. When flag OFF, decision.fired=true always
  // (preserves current behavior). Decision struct is attached to result for
  // caller to persist to documents.metadata.column_wrap_decision.
  const columnWrapDecision = computeColumnWrapDecision(
    ocrText,
    "sbc",
    selectiveSelfCheckEnabled,
  );
  if (isSBCSelfCheckEnabled() && columnWrapDecision.fired) {
    const { updatedResult } = await selfCheckSBCExcerpts(verifiedResult, ocrText, sectionRanges);
    verifiedResult = verifySBCSourceExcerpts(ocrText, updatedResult, sectionRanges);
  }

  return { ...verifiedResult, columnWrapDecision };
}
