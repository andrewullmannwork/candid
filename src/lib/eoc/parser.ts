/**
 * EOC parser main orchestrator per Phase 3.1A Subplan + DR-3.1A-C.
 *
 * Architecture (decision logic per Subplan §Task 3.1A-C):
 *   1. Plan identity REUSE — invokes parsePlanDocument() from plan-doc-parser.ts (Q-P3.1A-11)
 *   2. Section segmentation — regex first; Haiku discovery fallback if <2 of 6 priority sections (Q-P3.1A-4)
 *   3. Preamble synthesis (Phase 3.1B.1 universal pattern)
 *   4. Per-section Haiku dispatch — Promise.allSettled (parallel, fault-tolerant; Q-DR-3.1A-C-2)
 *   5. Pattern P-8 verification (whitespace-normalized fallback per Phase 3.1B.1)
 *   6. Cost hard cap $1/EOC (Q-P3.1A-6 LOCK)
 *
 * Pattern P-D + P-8 inheritance enforced per file:
 *   - haiku-prompts/_shared.ts handles caching, max_tokens, retries, cost telemetry
 *   - verify-source-excerpts.ts handles 5-sub-key verification + Tier 2 section attribution
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
import type { EOCParseResult, EOCPlanIdentity, EOCSectionHint, EOCSectionResult } from "./types";
import { verifyEOCSourceExcerpts } from "./verify-source-excerpts";
import { extractPriorAuthCodes } from "./haiku-prompts/prior-auth-codes";
import { extractMedicalNecessity } from "./haiku-prompts/medical-necessity";
import { extractAppealsProcedures } from "./haiku-prompts/appeals-procedures";
import { extractCOBRules } from "./haiku-prompts/cob-rules";
import { extractEligibilityRules } from "./haiku-prompts/eligibility-rules";
import { extractDefinitions } from "./haiku-prompts/definitions";

const COST_HARD_CAP_USD = 1.0;
const COST_SOFT_ALARM_USD = 0.45;
const COST_SOFT_TARGET_USD = 0.3;

/**
 * Take the FIRST range for a given section hint (most EOCs have one canonical
 * occurrence per priority section type; if multiple, the parser dispatches against
 * the first — admin tooling can flag multi-occurrence cases for follow-up).
 */
function pickFirstRange(
  ranges: SectionRanges,
  hint: EOCSectionHint,
): { start: number; end: number } | null {
  const arr = ranges[hint];
  if (!arr || arr.length === 0) return null;
  return arr[0];
}

/**
 * Slice the section text from the raw document using the section range.
 */
function sliceSection(rawDocText: string, range: { start: number; end: number }): string {
  return rawDocText.slice(range.start, range.end);
}

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

  // Degenerate case: no priority sections found at all even after Haiku fallback.
  if (countPrioritySections(sectionRanges) === 0 && (sectionRanges.other?.length ?? 0) > 0) {
    segmentationUsed = "preamble_only";
  }

  // 4. Per-section Haiku dispatch (Promise.allSettled — fault-tolerant per Q-DR-3.1A-C-2).
  const sections: EOCParseResult["sections"] = {};
  let totalCostUsd = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  // Per-section dispatch — each section's result has a different `data` shape, so we
  // dispatch + assign individually rather than via a generic helper (TypeScript would
  // otherwise unify the T across all calls in a single helper signature).
  const dispatch = async <T>(
    hint: EOCSectionHint,
    fn: (text: string, range: { start: number; end: number }, em: ExtractionMethod) => Promise<EOCSectionResult<T>>,
  ): Promise<EOCSectionResult<T> | null> => {
    const range = pickFirstRange(sectionRanges, hint);
    if (!range) return null;
    return fn(sliceSection(ocrText, range), range, extractionMethod);
  };

  // Accumulate telemetry from any section result without narrowing T.
  const recordTelemetry = (result: { haiku_cost_usd: number; haiku_input_tokens: number; haiku_output_tokens: number; warnings: string[] }) => {
    totalCostUsd += result.haiku_cost_usd;
    totalInputTokens += result.haiku_input_tokens;
    totalOutputTokens += result.haiku_output_tokens;
    warnings.push(...result.warnings);
    if (totalCostUsd > COST_HARD_CAP_USD) {
      throw new Error(`eoc_cost_hard_cap_breached:${documentId}:cost=${totalCostUsd.toFixed(4)}`);
    }
  };

  const [paRes, mnRes, apRes, cobRes, elRes, defRes] = await Promise.allSettled([
    dispatch("prior_auth_codes", extractPriorAuthCodes),
    dispatch("medical_necessity", extractMedicalNecessity),
    dispatch("appeals_procedures", extractAppealsProcedures),
    dispatch("cob_rules", extractCOBRules),
    dispatch("eligibility_rules", extractEligibilityRules),
    dispatch("definitions", extractDefinitions),
  ]);

  // Each section assignment is type-safe (no helper-generic unification).
  const tryAssign = <T>(
    hint: EOCSectionHint,
    settled: PromiseSettledResult<EOCSectionResult<T> | null>,
    set: (r: EOCSectionResult<T>) => void,
  ) => {
    if (settled.status === "fulfilled" && settled.value) {
      try {
        recordTelemetry(settled.value);
        set(settled.value);
      } catch (err) {
        parseErrors.push({ section: hint, error: err instanceof Error ? err.message : String(err) });
      }
    } else if (settled.status === "rejected") {
      parseErrors.push({ section: hint, error: settled.reason instanceof Error ? settled.reason.message : String(settled.reason) });
    }
  };

  tryAssign("prior_auth_codes", paRes, (r) => { sections.prior_auth_codes = r; });
  tryAssign("medical_necessity", mnRes, (r) => { sections.medical_necessity = r; });
  tryAssign("appeals_procedures", apRes, (r) => { sections.appeals_procedures = r; });
  tryAssign("cob_rules", cobRes, (r) => { sections.cob_rules = r; });
  tryAssign("eligibility_rules", elRes, (r) => { sections.eligibility_rules = r; });
  tryAssign("definitions", defRes, (r) => { sections.definitions = r; });

  // Soft alarm + soft target diagnostics.
  if (totalCostUsd > COST_SOFT_ALARM_USD) {
    warnings.push(`eoc_cost_soft_alarm:${documentId}:cost=${totalCostUsd.toFixed(4)}:threshold=${COST_SOFT_ALARM_USD}`);
  } else if (totalCostUsd > COST_SOFT_TARGET_USD) {
    warnings.push(`eoc_cost_above_soft_target:${documentId}:cost=${totalCostUsd.toFixed(4)}:target=${COST_SOFT_TARGET_USD}`);
  }

  // 5. Build initial result + 6. Pattern P-8 verification.
  const preliminary: EOCParseResult = {
    plan_identity: planIdentity,
    sections,
    total_cost_usd: totalCostUsd,
    total_input_tokens: totalInputTokens,
    total_output_tokens: totalOutputTokens,
    segmentation_used: segmentationUsed,
    warnings,
    parse_errors: parseErrors,
  };

  return verifyEOCSourceExcerpts(ocrText, preliminary, sectionRanges);
}
