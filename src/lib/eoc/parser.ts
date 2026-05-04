/**
 * EOC parser main orchestrator per Phase 3.1A Subplan + DR-3.1A-C, refactored
 * for Phase 3.1A.1 sub-segmentation per DR-3.1A.1-B v3.
 *
 * Architecture (Phase 3.1A.1 v3):
 *   1. Plan identity REUSE — invokes parsePlanDocument() (Q-P3.1A-11)
 *   2. Section segmentation — regex first; Haiku discovery fallback if <2 of 6 priority
 *   3. Preamble synthesis (Phase 3.1B.1 universal pattern)
 *   4. Per-section sub-segmentation — line/paragraph/term granularity per Q-P3.1A.1-1
 *   5. Sequential per-chunk Haiku dispatch within section; sections in parallel via
 *      Promise.allSettled. Cost-cap 90% threshold pre-dispatch guard.
 *   6. Result combine — array sections concat (NO dedup per DR-3.1A.1-B-2);
 *      single-block sections field-merge per Q-P3.1A.1-6 v3
 *   7. full_text for single-blocks = sectionText (per DR-3.1A.1-B-3)
 *   8. Pattern P-8 verification (whitespace-normalized fallback per Phase 3.1B.1)
 *   9. Self-check loop (Iter 2 contingency) — env-var gated per DR-3.1A.1-B-4
 *  10. Cost hard cap $1/EOC (Q-P3.1A-6 LOCK)
 *
 * Recall-maximize bias per `feedback_candid_recall_over_precision`. Citation-grade
 * strictness preserved at consumer-read layer (Pattern P-8 hard rule unchanged).
 */

import { parsePlanDocument } from "../plan/plan-doc-parser";
import type { ExtractionMethod, SectionRanges } from "../parser/types";
import {
  countPrioritySections,
  discoverSectionsViaHaiku,
  mergeSegmentations,
  segmentEOCSections,
} from "./section-segment";
import type {
  AppealsProceduresData,
  COBRulesData,
  DefinitionsData,
  EligibilityRulesData,
  EOCParseResult,
  EOCPlanIdentity,
  EOCSectionHint,
  EOCSectionResult,
  MedicalNecessityData,
  PriorAuthCodesData,
} from "./types";
import { verifyEOCSourceExcerpts } from "./verify-source-excerpts";
import { extractPriorAuthCodes } from "./haiku-prompts/prior-auth-codes";
import { extractMedicalNecessity } from "./haiku-prompts/medical-necessity";
import { extractAppealsProcedures } from "./haiku-prompts/appeals-procedures";
import { extractCOBRules } from "./haiku-prompts/cob-rules";
import { extractEligibilityRules } from "./haiku-prompts/eligibility-rules";
import { extractDefinitions } from "./haiku-prompts/definitions";
import { type Chunk, type Granularity, subSegmentSection } from "./sub-segment";
import { isSelfCheckEnabled, selfCheckExcerpts } from "./self-check";

const COST_HARD_CAP_USD = 1.0;
const COST_GUARD_THRESHOLD_USD = 0.9; // 90% of hard cap; pre-dispatch chunk-skip guard
const COST_SOFT_ALARM_USD = 0.45;
const COST_SOFT_TARGET_USD = 0.3;
const FULL_TEXT_SIZE_WARN_BYTES = 50_000; // DR-3.1A.1-B-3 LOCK

interface DispatchConfig {
  granularity: Granularity;
  maxTokens: number;
  fallback?: Granularity;
}

/**
 * Per-section sub-segmentation config per Q-P3.1A.1-1 LOCK.
 * Shape-driven (output array vs single block + dense vs prose source), not insurer-driven.
 */
const SECTION_CONFIGS: Partial<Record<EOCSectionHint, DispatchConfig>> = {
  prior_auth_codes: { granularity: "line", maxTokens: 800 },
  medical_necessity: { granularity: "paragraph", maxTokens: 600 },
  appeals_procedures: { granularity: "paragraph", maxTokens: 800 },
  cob_rules: { granularity: "paragraph", maxTokens: 800 },
  eligibility_rules: { granularity: "paragraph", maxTokens: 800 },
  definitions: { granularity: "term", maxTokens: 800, fallback: "paragraph" },
};

function pickFirstRange(
  ranges: SectionRanges,
  hint: EOCSectionHint,
): { start: number; end: number } | null {
  const arr = ranges[hint];
  if (!arr || arr.length === 0) return null;
  return arr[0];
}

function sliceSection(rawDocText: string, range: { start: number; end: number }): string {
  return rawDocText.slice(range.start, range.end);
}

function pickFirstNonNullNumber(
  results: Array<{ value: number | null }>,
): number | null {
  for (const r of results) {
    if (r.value !== null) return r.value;
  }
  return null;
}

function pickFirstNonEmptyString(results: Array<{ value: string }>): string {
  for (const r of results) {
    if (r.value && r.value.length > 0) return r.value;
  }
  return "";
}

function pickFirstNonNullString(results: Array<{ value: string | null }>): string | null {
  for (const r of results) {
    if (r.value !== null && r.value.length > 0) return r.value;
  }
  return null;
}

function pickFirstNonNullBoolean(results: Array<{ value: boolean | null }>): boolean | null {
  for (const r of results) {
    if (r.value !== null) return r.value;
  }
  return null;
}

function pickHighestConfidence(
  results: Array<{ confidence: number | undefined }>,
): number | undefined {
  let highest: number | undefined = undefined;
  for (const r of results) {
    if (typeof r.confidence === "number") {
      if (highest === undefined || r.confidence > highest) highest = r.confidence;
    }
  }
  return highest;
}

function mergeStringArrays(arrays: string[][]): string[] {
  const seen = new Set<string>();
  for (const arr of arrays) for (const s of arr) if (typeof s === "string") seen.add(s);
  return Array.from(seen);
}

interface CostTracker {
  totalUsd: number;
}

interface ChunkDispatchOutcome<T> {
  chunkResults: Array<EOCSectionResult<T> | null>;
  warnings: string[];
}

/**
 * Dispatch chunks SEQUENTIALLY for one section. Cost-cap 90% threshold pre-dispatch
 * guard fires before each chunk's Haiku call. Sections themselves run in PARALLEL
 * via Promise.allSettled at the orchestrator level.
 */
async function dispatchChunksSequentially<T>(
  hint: EOCSectionHint,
  config: DispatchConfig,
  sectionRange: { start: number; end: number },
  sectionText: string,
  fn: (text: string, range: { start: number; end: number }, em: ExtractionMethod) => Promise<EOCSectionResult<T>>,
  extractionMethod: ExtractionMethod,
  costTracker: CostTracker,
): Promise<ChunkDispatchOutcome<T>> {
  const warnings: string[] = [];
  const chunks: Chunk[] = subSegmentSection(sectionText, config.granularity, config.maxTokens, config.fallback);

  if (chunks.length === 0) {
    return { chunkResults: [], warnings };
  }

  // Diagnostic: surface oversized chunks (single piece exceeded maxTokens)
  for (const chunk of chunks) {
    if (chunk.tokenEstimate > config.maxTokens) {
      warnings.push(`chunk_oversized:${hint}:${chunk.start}:${chunk.tokenEstimate}`);
    }
  }

  const chunkResults: Array<EOCSectionResult<T> | null> = [];
  for (const chunk of chunks) {
    if (costTracker.totalUsd > COST_HARD_CAP_USD * COST_GUARD_THRESHOLD_USD) {
      warnings.push(`chunk_skipped_near_cost_cap:${hint}:${chunk.start}`);
      break;
    }
    const absRange = { start: sectionRange.start + chunk.start, end: sectionRange.start + chunk.end };
    try {
      const r = await fn(chunk.text, absRange, extractionMethod);
      chunkResults.push(r);
      costTracker.totalUsd += r.haiku_cost_usd;
    } catch (err) {
      chunkResults.push(null);
      warnings.push(`chunk_failed:${hint}:${chunk.start}:${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { chunkResults, warnings };
}

function sumTelemetry<T>(
  chunks: Array<EOCSectionResult<T> | null>,
): { input: number; output: number; cost: number; warnings: string[] } {
  let input = 0;
  let output = 0;
  let cost = 0;
  const warnings: string[] = [];
  for (const c of chunks) {
    if (!c) continue;
    input += c.haiku_input_tokens;
    output += c.haiku_output_tokens;
    cost += c.haiku_cost_usd;
    warnings.push(...c.warnings);
  }
  return { input, output, cost, warnings };
}

// ── Combine helpers per section ────────────────────────────────────────────

function combinePriorAuthCodes(
  chunks: Array<EOCSectionResult<PriorAuthCodesData> | null>,
  sectionRange: { start: number; end: number },
): EOCSectionResult<PriorAuthCodesData> | null {
  const valid = chunks.filter((c): c is EOCSectionResult<PriorAuthCodesData> => c !== null);
  if (valid.length === 0) return null;
  const tel = sumTelemetry(valid);
  return {
    section_type: "prior_auth_codes",
    section_range: sectionRange,
    data: { codes: valid.flatMap((v) => v.data.codes) },
    haiku_input_tokens: tel.input,
    haiku_output_tokens: tel.output,
    haiku_cost_usd: tel.cost,
    warnings: tel.warnings,
  };
}

function combineMedicalNecessity(
  chunks: Array<EOCSectionResult<MedicalNecessityData> | null>,
  sectionRange: { start: number; end: number },
): EOCSectionResult<MedicalNecessityData> | null {
  const valid = chunks.filter((c): c is EOCSectionResult<MedicalNecessityData> => c !== null);
  if (valid.length === 0) return null;
  const tel = sumTelemetry(valid);
  return {
    section_type: "medical_necessity",
    section_range: sectionRange,
    data: { criteria: valid.flatMap((v) => v.data.criteria) },
    haiku_input_tokens: tel.input,
    haiku_output_tokens: tel.output,
    haiku_cost_usd: tel.cost,
    warnings: tel.warnings,
  };
}

function combineDefinitions(
  chunks: Array<EOCSectionResult<DefinitionsData> | null>,
  sectionRange: { start: number; end: number },
): EOCSectionResult<DefinitionsData> | null {
  const valid = chunks.filter((c): c is EOCSectionResult<DefinitionsData> => c !== null);
  if (valid.length === 0) return null;
  const tel = sumTelemetry(valid);
  return {
    section_type: "definitions",
    section_range: sectionRange,
    data: { definitions: valid.flatMap((v) => v.data.definitions) },
    haiku_input_tokens: tel.input,
    haiku_output_tokens: tel.output,
    haiku_cost_usd: tel.cost,
    warnings: tel.warnings,
  };
}

function combineAppealsProcedures(
  chunks: Array<EOCSectionResult<AppealsProceduresData> | null>,
  sectionRange: { start: number; end: number },
  sectionText: string,
  extractionMethod: ExtractionMethod,
): EOCSectionResult<AppealsProceduresData> | null {
  const valid = chunks.filter((c): c is EOCSectionResult<AppealsProceduresData> => c !== null);
  if (valid.length === 0) return null;
  const tel = sumTelemetry(valid);
  // Field-merge per Q-P3.1A.1-6 v3 LOCK: first non-null wins; highest confidence breaks ties
  const data: AppealsProceduresData = {
    internal_timing_days: pickFirstNonNullNumber(valid.map((v) => ({ value: v.data.internal_timing_days }))),
    internal_urgent_timing_hours: pickFirstNonNullNumber(
      valid.map((v) => ({ value: v.data.internal_urgent_timing_hours })),
    ),
    external_timing_days: pickFirstNonNullNumber(valid.map((v) => ({ value: v.data.external_timing_days }))),
    iro_assignment_method: pickFirstNonNullString(valid.map((v) => ({ value: v.data.iro_assignment_method }))),
    filing_methods: mergeStringArrays(valid.map((v) => v.data.filing_methods)),
    state_doi_complaint_text: pickFirstNonNullString(
      valid.map((v) => ({ value: v.data.state_doi_complaint_text })),
    ),
    full_text: sectionText, // DR-3.1A.1-B-3 v3: use sectionText directly, NOT chunk concat
    source_excerpt: pickFirstNonEmptyString(valid.map((v) => ({ value: v.data.source_excerpt }))),
    source_excerpt_verified: "not_found", // verifier sets this
    source_excerpt_extraction_method: extractionMethod,
    source_section_hint: "appeals_procedures",
    source_section_verified: false,
    haiku_confidence: pickHighestConfidence(valid.map((v) => ({ confidence: v.data.haiku_confidence }))),
  };
  return {
    section_type: "appeals_procedures",
    section_range: sectionRange,
    data,
    haiku_input_tokens: tel.input,
    haiku_output_tokens: tel.output,
    haiku_cost_usd: tel.cost,
    warnings: tel.warnings,
  };
}

function combineCOBRules(
  chunks: Array<EOCSectionResult<COBRulesData> | null>,
  sectionRange: { start: number; end: number },
  sectionText: string,
  extractionMethod: ExtractionMethod,
): EOCSectionResult<COBRulesData> | null {
  const valid = chunks.filter((c): c is EOCSectionResult<COBRulesData> => c !== null);
  if (valid.length === 0) return null;
  const tel = sumTelemetry(valid);
  const data: COBRulesData = {
    primary_determination_method:
      (pickFirstNonNullString(
        valid.map((v) => ({ value: v.data.primary_determination_method as string | null })),
      ) as COBRulesData["primary_determination_method"]) ?? null,
    calculation_method:
      (pickFirstNonNullString(valid.map((v) => ({ value: v.data.calculation_method as string | null }))) as
        | COBRulesData["calculation_method"]) ?? null,
    erisa_preempted: pickFirstNonNullBoolean(valid.map((v) => ({ value: v.data.erisa_preempted }))),
    full_text: sectionText, // DR-3.1A.1-B-3 v3
    source_excerpt: pickFirstNonEmptyString(valid.map((v) => ({ value: v.data.source_excerpt }))),
    source_excerpt_verified: "not_found",
    source_excerpt_extraction_method: extractionMethod,
    source_section_hint: "cob_rules",
    source_section_verified: false,
    haiku_confidence: pickHighestConfidence(valid.map((v) => ({ confidence: v.data.haiku_confidence }))),
  };
  return {
    section_type: "cob_rules",
    section_range: sectionRange,
    data,
    haiku_input_tokens: tel.input,
    haiku_output_tokens: tel.output,
    haiku_cost_usd: tel.cost,
    warnings: tel.warnings,
  };
}

function combineEligibilityRules(
  chunks: Array<EOCSectionResult<EligibilityRulesData> | null>,
  sectionRange: { start: number; end: number },
  sectionText: string,
  extractionMethod: ExtractionMethod,
): EOCSectionResult<EligibilityRulesData> | null {
  const valid = chunks.filter((c): c is EOCSectionResult<EligibilityRulesData> => c !== null);
  if (valid.length === 0) return null;
  const tel = sumTelemetry(valid);
  const data: EligibilityRulesData = {
    effective_date_rule: pickFirstNonEmptyString(valid.map((v) => ({ value: v.data.effective_date_rule }))),
    dependent_age_limit: pickFirstNonNullNumber(valid.map((v) => ({ value: v.data.dependent_age_limit }))),
    cobra_eligible: pickFirstNonNullBoolean(valid.map((v) => ({ value: v.data.cobra_eligible }))),
    cobra_max_months: pickFirstNonNullNumber(valid.map((v) => ({ value: v.data.cobra_max_months }))),
    special_enrollment_events: mergeStringArrays(valid.map((v) => v.data.special_enrollment_events)),
    full_text: sectionText, // DR-3.1A.1-B-3 v3
    source_excerpt: pickFirstNonEmptyString(valid.map((v) => ({ value: v.data.source_excerpt }))),
    source_excerpt_verified: "not_found",
    source_excerpt_extraction_method: extractionMethod,
    source_section_hint: "eligibility_rules",
    source_section_verified: false,
    haiku_confidence: pickHighestConfidence(valid.map((v) => ({ confidence: v.data.haiku_confidence }))),
  };
  return {
    section_type: "eligibility_rules",
    section_range: sectionRange,
    data,
    haiku_input_tokens: tel.input,
    haiku_output_tokens: tel.output,
    haiku_cost_usd: tel.cost,
    warnings: tel.warnings,
  };
}

// ── Main parser ───────────────────────────────────────────────────────────

export async function parseEOC(
  ocrText: string,
  options: {
    documentId: string;
    extractionMethod: ExtractionMethod;
  },
): Promise<EOCParseResult> {
  const { documentId, extractionMethod } = options;
  const warnings: string[] = [];
  const parseErrors: Array<{ section: EOCSectionHint; error: string }> = [];

  // 1. Plan identity REUSE per Q-P3.1A-11.
  let planIdentity: EOCPlanIdentity = {
    insurer_name: null,
    plan_name: null,
    plan_year: null,
    in_deductible_individual: null,
    in_oop_max_individual: null,
    out_deductible_individual: null,
    out_oop_max_individual: null,
  };
  try {
    const planParse = parsePlanDocument(ocrText);
    planIdentity = {
      insurer_name: planParse.plan.insurer_name ?? null,
      plan_name: planParse.plan.plan_name ?? null,
      plan_year: planParse.plan.plan_year ?? null,
      in_deductible_individual: planParse.plan.in_deductible_individual ?? null,
      in_oop_max_individual: planParse.plan.in_oop_max_individual ?? null,
      out_deductible_individual: planParse.plan.out_deductible_individual ?? null,
      out_oop_max_individual: planParse.plan.out_oop_max_individual ?? null,
    };
  } catch (err) {
    warnings.push(`plan_identity_extraction_failed:${documentId}:${err instanceof Error ? err.message : String(err)}`);
  }

  // 2. Section segmentation — regex first.
  let sectionRanges = segmentEOCSections(ocrText);
  let segmentationUsed: EOCParseResult["segmentation_used"] = "regex_only";

  // 3. Section-discovery Haiku fallback (Q-P3.1A-4 LOCK).
  const regexCount = countPrioritySections(sectionRanges);
  if (regexCount < 2) {
    warnings.push(`eoc_section_discovery_fallback:${documentId}:regex_found_${regexCount}`);
    try {
      const discovered = await discoverSectionsViaHaiku(ocrText);
      sectionRanges = mergeSegmentations(sectionRanges, discovered);
      segmentationUsed = regexCount === 0 ? "haiku_discovery_only" : "regex_plus_haiku_discovery";
    } catch (err) {
      warnings.push(`section_discovery_failed:${documentId}:${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Degenerate case
  if (countPrioritySections(sectionRanges) === 0 && (sectionRanges.other?.length ?? 0) > 0) {
    segmentationUsed = "preamble_only";
  }

  // 4. Per-section sub-segmented dispatch — sections in parallel; chunks sequential within section.
  const costTracker: CostTracker = { totalUsd: 0 };

  const dispatchSection = async <T>(
    hint: EOCSectionHint,
    fn: (text: string, range: { start: number; end: number }, em: ExtractionMethod) => Promise<EOCSectionResult<T>>,
    combineFn: (
      chunks: Array<EOCSectionResult<T> | null>,
      sectionRange: { start: number; end: number },
      sectionText: string,
    ) => EOCSectionResult<T> | null,
  ): Promise<{ result: EOCSectionResult<T> | null; warnings: string[] }> => {
    const range = pickFirstRange(sectionRanges, hint);
    if (!range) return { result: null, warnings: [] };
    const config = SECTION_CONFIGS[hint];
    if (!config) return { result: null, warnings: [] };
    const sectionText = sliceSection(ocrText, range);
    const { chunkResults, warnings: chunkWarnings } = await dispatchChunksSequentially(
      hint,
      config,
      range,
      sectionText,
      fn,
      extractionMethod,
      costTracker,
    );
    const combined = combineFn(chunkResults, range, sectionText);
    return { result: combined, warnings: chunkWarnings };
  };

  const [paOutcome, mnOutcome, apOutcome, cobOutcome, elOutcome, defOutcome] = await Promise.allSettled([
    dispatchSection(
      "prior_auth_codes",
      extractPriorAuthCodes,
      (cs, r) => combinePriorAuthCodes(cs, r),
    ),
    dispatchSection(
      "medical_necessity",
      extractMedicalNecessity,
      (cs, r) => combineMedicalNecessity(cs, r),
    ),
    dispatchSection(
      "appeals_procedures",
      extractAppealsProcedures,
      (cs, r, st) => combineAppealsProcedures(cs, r, st, extractionMethod),
    ),
    dispatchSection(
      "cob_rules",
      extractCOBRules,
      (cs, r, st) => combineCOBRules(cs, r, st, extractionMethod),
    ),
    dispatchSection(
      "eligibility_rules",
      extractEligibilityRules,
      (cs, r, st) => combineEligibilityRules(cs, r, st, extractionMethod),
    ),
    dispatchSection(
      "definitions",
      extractDefinitions,
      (cs, r) => combineDefinitions(cs, r),
    ),
  ]);

  // 5. Aggregate + assign.
  const sections: EOCParseResult["sections"] = {};
  let totalCostUsd = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  type SectionOutcome<T> = { result: EOCSectionResult<T> | null; warnings: string[] };
  const tryAssign = <T>(
    hint: EOCSectionHint,
    settled: PromiseSettledResult<SectionOutcome<T>>,
    set: (r: EOCSectionResult<T>) => void,
  ) => {
    if (settled.status === "fulfilled") {
      warnings.push(...settled.value.warnings);
      const r = settled.value.result;
      if (r) {
        totalCostUsd += r.haiku_cost_usd;
        totalInputTokens += r.haiku_input_tokens;
        totalOutputTokens += r.haiku_output_tokens;
        warnings.push(...r.warnings);
        // full_text size diagnostic (DR-3.1A.1-B-3 LOCK)
        const ft = (r.data as unknown as { full_text?: string }).full_text;
        if (typeof ft === "string" && ft.length > FULL_TEXT_SIZE_WARN_BYTES) {
          warnings.push(`full_text_oversized:${hint}:${ft.length}`);
        }
        set(r);
      }
    } else {
      parseErrors.push({
        section: hint,
        error: settled.reason instanceof Error ? settled.reason.message : String(settled.reason),
      });
    }
  };

  tryAssign("prior_auth_codes", paOutcome, (r) => {
    sections.prior_auth_codes = r;
  });
  tryAssign("medical_necessity", mnOutcome, (r) => {
    sections.medical_necessity = r;
  });
  tryAssign("appeals_procedures", apOutcome, (r) => {
    sections.appeals_procedures = r;
  });
  tryAssign("cob_rules", cobOutcome, (r) => {
    sections.cob_rules = r;
  });
  tryAssign("eligibility_rules", elOutcome, (r) => {
    sections.eligibility_rules = r;
  });
  tryAssign("definitions", defOutcome, (r) => {
    sections.definitions = r;
  });

  // Hard cap check (post-aggregation).
  if (totalCostUsd > COST_HARD_CAP_USD) {
    throw new Error(`eoc_cost_hard_cap_breached:${documentId}:cost=${totalCostUsd.toFixed(4)}`);
  }
  if (totalCostUsd > COST_SOFT_ALARM_USD) {
    warnings.push(`eoc_cost_soft_alarm:${documentId}:cost=${totalCostUsd.toFixed(4)}:threshold=${COST_SOFT_ALARM_USD}`);
  } else if (totalCostUsd > COST_SOFT_TARGET_USD) {
    warnings.push(`eoc_cost_above_soft_target:${documentId}:cost=${totalCostUsd.toFixed(4)}:target=${COST_SOFT_TARGET_USD}`);
  }

  // 6. Build preliminary + 7. Pattern P-8 verification.
  // Phase 4.0.5: track dispatched_sections from `sections` map keys (sections that
  // had a successful Haiku result populate the map entry; failed sections appear
  // in parse_errors instead per Promise.allSettled pattern).
  const dispatched_sections = Object.keys(sections) as EOCSectionHint[];
  const preliminary: EOCParseResult = {
    plan_identity: planIdentity,
    sections,
    total_cost_usd: totalCostUsd,
    total_input_tokens: totalInputTokens,
    total_output_tokens: totalOutputTokens,
    segmentation_used: segmentationUsed,
    warnings,
    parse_errors: parseErrors,
    dispatched_sections,
  };

  let final = verifyEOCSourceExcerpts(ocrText, preliminary, sectionRanges);

  // 8. Self-check loop (Iter 2 contingency) — env-var gated per DR-3.1A.1-B-4.
  if (isSelfCheckEnabled()) {
    const { updatedResult } = await selfCheckExcerpts(final, ocrText, sectionRanges);
    // Re-run verifier on corrected excerpts to refresh source_excerpt_verified +
    // source_section_verified flags.
    final = verifyEOCSourceExcerpts(ocrText, updatedResult, sectionRanges);
    // Hard cap re-check (self-check could push us over).
    if (final.total_cost_usd > COST_HARD_CAP_USD) {
      throw new Error(`eoc_cost_hard_cap_breached_post_self_check:${documentId}:cost=${final.total_cost_usd.toFixed(4)}`);
    }
  }

  return final;
}
