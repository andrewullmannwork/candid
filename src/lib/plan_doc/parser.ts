/**
 * Plan_doc Haiku-first parser — S72 main orchestrator.
 *
 * Architecture (Phase 3.1A architectural template + S72 Subplan):
 *   1. Section segmentation — regex detect 3 priority sections + Haiku-discovery
 *      fallback if regex finds <2 (Q-P3.1A-4 LOCK pattern from EOC parser)
 *   2. Per-section sequential Haiku dispatch with cost-cap pre-dispatch guard
 *   3. Cost-cap 90% threshold guard per section (matches EOC + SBC pattern)
 *   4. Pattern P-8 verification (whitespace + Unicode normalized fallback)
 *   5. Phase 4.0.5 dispatchedSections tracking for verbatim_absent derivation
 *
 * Recall-maximize bias per `feedback_candid_recall_over_precision`. Citation-grade
 * strictness preserved at consumer-read layer (Pattern P-8 hard rule unchanged).
 *
 * Cost ceiling: $0.50 soft / $2.00 hard (matching SBC; plan documents typically
 * 5-300 pages with smaller-than-EOC section dispatch counts).
 *
 * S73 follow-up (Phase 3.1A.1 verbatim quality lift): inherits 5 universal P-8
 * mechanisms + self-check loop (env-var gated) for verbatim quality. Commit-2 MVP
 * scaffolding ships parser without self-check; verbatim quality at MVP recall level.
 */

import type { ExtractionMethod, SectionRanges } from "../parser/types";
import {
  countPriorityPlanDocSections,
  discoverPlanDocSectionsViaHaiku,
  mergeSegmentations,
  segmentPlanDocSections,
  sliceSection,
} from "./section-discovery";
import { cleanupBoilerplate } from "./subtractive-cleanup";
import type {
  PlanDocAccessInstructions,
  PlanDocHaikuParseResult,
  PlanDocPlanIdentity,
  PlanDocSectionHint,
  PlanDocSectionResult,
  PlanDocService,
} from "./types";
import { extractPlanIdentity } from "./haiku-prompts/plan-identity";
import { extractServicesCostSharing } from "./haiku-prompts/services-cost-sharing";
import { extractAccessInstructions } from "./haiku-prompts/access-instructions";
import { verifyPlanDocSourceExcerpts } from "./verify-source-excerpts";

const COST_HARD_CAP_USD = 2.0;
const COST_GUARD_THRESHOLD_USD = 0.9; // 90% of hard cap; pre-dispatch chunk-skip guard
const COST_SOFT_ALARM_USD = 0.5;

interface CostTracker {
  totalUsd: number;
}

function emptyPlanIdentity(extractionMethod: ExtractionMethod): PlanDocPlanIdentity {
  const emptyP8 = {
    source_excerpt: "",
    source_excerpt_verified: "not_found" as const,
    source_excerpt_extraction_method: extractionMethod,
    source_section_hint: "plan_identity" as PlanDocSectionHint,
    source_section_verified: false,
  };
  const emptyString = { value: null as string | null, patternP8: emptyP8 };
  const emptyNumber = { value: null as number | null, patternP8: emptyP8 };
  return {
    planName: emptyString,
    insurerName: emptyString,
    planType: emptyString,
    metalTier: emptyString,
    planYear: emptyNumber,
    groupNumber: emptyString,
    networkType: emptyString,
    deductibleIndividual: emptyNumber,
    deductibleFamily: emptyNumber,
    oopMaxIndividual: emptyNumber,
    oopMaxFamily: emptyNumber,
    outDeductibleIndividual: emptyNumber,
    outDeductibleFamily: emptyNumber,
    outOopMaxIndividual: emptyNumber,
    outOopMaxFamily: emptyNumber,
  };
}

interface SectionDispatchPlan<T> {
  hint: PlanDocSectionHint;
  sectionText: string | null;
  sectionRange: { start: number; end: number } | null;
  fn: (
    text: string,
    range: { start: number; end: number },
    em: ExtractionMethod,
  ) => Promise<PlanDocSectionResult<T>>;
}

async function dispatchSection<T>(
  plan: SectionDispatchPlan<T>,
  extractionMethod: ExtractionMethod,
  costTracker: CostTracker,
  warnings: string[],
): Promise<PlanDocSectionResult<T> | null> {
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

export interface ParsePlanDocInput {
  ocrText: string;
  extractionMethod: ExtractionMethod;
  documentId: string;
}

export async function parsePlanDocumentHaiku(
  input: ParsePlanDocInput,
): Promise<PlanDocHaikuParseResult> {
  const { ocrText, extractionMethod, documentId } = input;
  const warnings: string[] = [];
  const costTracker: CostTracker = { totalUsd: 0 };

  // Step 0 (S72 commit 7): Subtractive boilerplate cleanup. Strips TOC region +
  // repeating page furniture so per-section dispatch sees denser semantic content.
  // Per S72-COMMIT-7 user direction: invert regex usage from "find data" to "remove
  // boilerplate" — Haiku does all semantic discovery + extraction. Conservative bias
  // (when in doubt, KEEP); legal boilerplate that matters for disputes is preserved.
  // ALL downstream operations (segmentation + per-section dispatch + Pattern P-8
  // verification) operate in cleaned-text coordinate space.
  const cleanup = cleanupBoilerplate(ocrText);
  const workingText = cleanup.cleanedText;
  warnings.push(...cleanup.warnings);
  warnings.push(
    `subtractive_cleanup:stripped_${cleanup.strippedLineCount}_of_${cleanup.originalLineCount}_lines:${(
      (cleanup.strippedLineCount / Math.max(cleanup.originalLineCount, 1)) *
      100
    ).toFixed(1)}%`,
  );

  // Step 1: Section segmentation (regex first, on cleaned text)
  let sectionRanges: SectionRanges = segmentPlanDocSections(workingText);
  let segmentationUsed: PlanDocHaikuParseResult["segmentationUsed"] = "regex_only";

  // Step 2: Haiku-discovery fallback per Phase 3.1A Q-P3.1A-4 LOCK pattern.
  // S72 commit 7: now a real Haiku call (was stub pre-commit-7) — asks Haiku for
  // distinctive opening phrases per section, then string-search to derive offsets
  // in cleaned text. Bias: more Haiku work for higher fidelity per S72-COMMIT-7.
  const regexCount = countPriorityPlanDocSections(sectionRanges);
  if (regexCount < 2) {
    warnings.push(`plan_doc_section_discovery_fallback:${documentId}:regex_found_${regexCount}`);
    try {
      const discovered = await discoverPlanDocSectionsViaHaiku(workingText);
      sectionRanges = mergeSegmentations(sectionRanges, discovered);
      const postFallbackCount = countPriorityPlanDocSections(sectionRanges);
      if (postFallbackCount > regexCount) {
        segmentationUsed = regexCount === 0 ? "haiku_discovery_only" : "regex_plus_haiku_discovery";
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      warnings.push(`section_discovery_failed:${documentId}:${msg}`);
    }
  }

  // Degenerate case: no priority sections detected at all (only preamble "other")
  if (
    countPriorityPlanDocSections(sectionRanges) === 0 &&
    (sectionRanges.other?.length ?? 0) > 0
  ) {
    segmentationUsed = "preamble_only";
  }

  // Step 3: Build per-section dispatch plans (operating on cleaned working text)
  const planIdentityRange = sectionRanges.plan_identity?.[0] ?? null;
  const servicesCostSharingRange = sectionRanges.services_cost_sharing?.[0] ?? null;
  const accessInstructionsRange = sectionRanges.access_instructions?.[0] ?? null;

  const planIdentityPlan: SectionDispatchPlan<PlanDocPlanIdentity> = {
    hint: "plan_identity",
    sectionText: sliceSection(workingText, sectionRanges, "plan_identity"),
    sectionRange: planIdentityRange,
    fn: extractPlanIdentity,
  };
  const servicesCostSharingPlan: SectionDispatchPlan<{ services: PlanDocService[] }> = {
    hint: "services_cost_sharing",
    sectionText: sliceSection(workingText, sectionRanges, "services_cost_sharing"),
    sectionRange: servicesCostSharingRange,
    fn: extractServicesCostSharing,
  };
  const accessInstructionsPlan: SectionDispatchPlan<PlanDocAccessInstructions> = {
    hint: "access_instructions",
    sectionText: sliceSection(workingText, sectionRanges, "access_instructions"),
    sectionRange: accessInstructionsRange,
    fn: extractAccessInstructions,
  };

  // Step 4: Sequential dispatch (matches SBC pattern; cost-cap precision over latency)
  const planIdentityResult = await dispatchSection(
    planIdentityPlan,
    extractionMethod,
    costTracker,
    warnings,
  );
  const servicesCostSharingResult = await dispatchSection(
    servicesCostSharingPlan,
    extractionMethod,
    costTracker,
    warnings,
  );
  const accessInstructionsResult = await dispatchSection(
    accessInstructionsPlan,
    extractionMethod,
    costTracker,
    warnings,
  );

  // Phase 4.0.5: track dispatchedSections for verbatim_absent derivation
  const dispatchedSections: PlanDocSectionHint[] = [
    planIdentityResult ? "plan_identity" : null,
    servicesCostSharingResult ? "services_cost_sharing" : null,
    accessInstructionsResult ? "access_instructions" : null,
  ].filter((s): s is PlanDocSectionHint => s !== null);

  // Cost soft alarm
  if (costTracker.totalUsd > COST_SOFT_ALARM_USD) {
    warnings.push(`cost_soft_alarm:${costTracker.totalUsd.toFixed(4)}`);
  }

  // Push section warnings into top-level warnings
  if (planIdentityResult?.warnings) warnings.push(...planIdentityResult.warnings);
  if (servicesCostSharingResult?.warnings) warnings.push(...servicesCostSharingResult.warnings);
  if (accessInstructionsResult?.warnings) warnings.push(...accessInstructionsResult.warnings);

  // Step 5: Sum telemetry
  const sectionResults = [
    planIdentityResult,
    servicesCostSharingResult,
    accessInstructionsResult,
  ].filter((r): r is NonNullable<typeof r> => r !== null);

  const haikuTokensInput = sectionResults.reduce((s, r) => s + r.haiku_input_tokens, 0);
  const haikuTokensOutput = sectionResults.reduce((s, r) => s + r.haiku_output_tokens, 0);
  const totalCostUsd = sectionResults.reduce((s, r) => s + r.haiku_cost_usd, 0);

  // Step 6: Assemble pre-verification result
  const preVerificationResult: PlanDocHaikuParseResult = {
    planIdentity: planIdentityResult?.data ?? emptyPlanIdentity(extractionMethod),
    services: servicesCostSharingResult?.data.services ?? [],
    accessInstructions: accessInstructionsResult?.data ?? null,
    parseWarnings: warnings,
    haikuTokensInput,
    haikuTokensOutput,
    haikuCacheCreateTokens: 0, // populated by callHaikuWithCache via response.usage in S73 follow-up
    haikuCacheReadTokens: 0,
    costUsd: totalCostUsd,
    parseStrategyV2: true,
    dispatchedSections,
    segmentationUsed,
  };

  // Hard cap check (post-aggregation)
  if (totalCostUsd > COST_HARD_CAP_USD) {
    throw new Error(
      `plan_doc_cost_hard_cap_breached:${documentId}:cost=${totalCostUsd.toFixed(4)}`,
    );
  }

  // Step 7: Pattern P-8 verification (insurer-agnostic; uses shared verifier).
  // Per S72 commit 7: verifier uses workingText (cleaned) since per-section dispatch
  // operated in cleaned-text coordinate space. Excerpts that Haiku emitted came from
  // cleaned content; verifier substring-matches against cleaned text. Stripped
  // boilerplate isn't expected to be extracted (per Pattern P-8 hard rule + cleanup
  // conservative bias) so verifier doesn't need to handle it.
  const verifiedResult = verifyPlanDocSourceExcerpts(workingText, preVerificationResult, sectionRanges);

  return verifiedResult;
}
