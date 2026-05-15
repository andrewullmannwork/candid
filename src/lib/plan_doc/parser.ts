/**
 * Plan_doc Haiku-first parser — S72 main orchestrator (S73 enhanced).
 *
 * Architecture (Phase 3.1A architectural template + S72 Subplan + S73 mechanism inheritance):
 *   1. Subtractive cleanup — strip TOC + repeated page furniture (S72 commit 7)
 *   2. Section segmentation — regex detect 3 priority sections + Haiku-discovery
 *      fallback if regex finds <2 (Q-P3.1A-4 LOCK pattern from EOC parser)
 *   3. Per-section sub-segmented Haiku dispatch (NEW S73 — Phase 3.1A.1 inheritance):
 *      - planIdentity: dispatch on plan_identity + services_cost_sharing + preamble
 *        "other" (early-exit when all 15 fields populated); field-merge chunks
 *      - services: chunk-dispatch services_cost_sharing section (Kaiser 102+ services
 *        token-truncation fix); concat + serviceSlug dedup
 *      - accessInstructions: dispatch on access_instructions + plan_identity +
 *        services_cost_sharing + preamble "other" (early-exit when phone + URL
 *        populated); field-merge chunks
 *   4. Cost-cap pre-dispatch guard per chunk (matches EOC pattern)
 *   5. Pattern P-8 verification (whitespace + Unicode normalized fallback)
 *   6. Phase 4.0.5 dispatchedSections tracking for verbatim_absent derivation
 *
 * Recall-maximize bias per `feedback_candid_recall_over_precision`. Citation-grade
 * strictness preserved at consumer-read layer (Pattern P-8 hard rule unchanged).
 *
 * Cost ceiling: $0.50 soft / $2.00 hard. S73 multi-section dispatch increases call
 * count but early-exit + cost-cap pre-dispatch guard keep typical fixtures under
 * $0.50. Worst case (Kaiser 102+ services + multi-section misses) = ~$1.00-1.50.
 */

import type { ExtractionMethod, SectionRanges } from "../parser/types";
import { type Granularity, subSegmentSection } from "../eoc/sub-segment";
import {
  countPriorityPlanDocSections,
  discoverPlanDocSectionsViaHaiku,
  mergeSegmentations,
  segmentPlanDocSections,
  sliceSection,
} from "./section-discovery";
import { cleanupBoilerplate } from "./subtractive-cleanup";
import {
  emptyPlanIdentity,
  mergeAccessInstructionsChunks,
  mergePlanIdentityChunks,
  mergeServicesChunks,
} from "./combine";
import type {
  PlanDocAccessInstructions,
  PlanDocHaikuParseResult,
  PlanDocPlanIdentity,
  PlanDocSectionHint,
  PlanDocService,
} from "./types";
import { extractPlanIdentity } from "./haiku-prompts/plan-identity";
import { extractServicesCostSharing } from "./haiku-prompts/services-cost-sharing";
import { extractAccessInstructions } from "./haiku-prompts/access-instructions";
import { detectLayout } from "./layout-detector";
import { verifyPlanDocSourceExcerpts } from "./verify-source-excerpts";
import { isSelfCheckEnabled, selfCheckPlanDocExcerpts } from "./self-check";

const COST_HARD_CAP_USD = 2.0;
const COST_GUARD_THRESHOLD_USD = 0.9; // 90% of hard cap; pre-dispatch chunk-skip guard
const COST_SOFT_ALARM_USD = 0.5;

interface CostTracker {
  totalUsd: number;
}

interface DispatchConfig {
  granularity: Granularity;
  maxTokens: number;
  fallback?: Granularity;
}

/**
 * Per-section sub-segmentation config per S73 (Session 76) — Phase 3.1A.1 inheritance.
 * Shape-driven (output array vs single scalar + dense vs prose source), not insurer-driven.
 *
 *   - plan_identity: paragraph granularity, 3000 maxTokens (paragraphs typically small;
 *     plan-identity scalars cluster in tables / list rows; large enough budget that
 *     small sections stay single-chunk)
 *   - services_cost_sharing: line granularity, 1200 maxTokens (one chunk = ~30-40
 *     services × ~30 tokens each; Kaiser 102+ services → ~3 chunks; output token
 *     budget headroom preserved)
 *   - access_instructions: paragraph granularity, 2000 maxTokens (typically small;
 *     phone numbers + URLs scatter across paragraphs)
 */
const SECTION_CONFIGS: Partial<Record<PlanDocSectionHint, DispatchConfig>> = {
  plan_identity: { granularity: "paragraph", maxTokens: 3000 },
  services_cost_sharing: { granularity: "line", maxTokens: 1200, fallback: "paragraph" },
  access_instructions: { granularity: "paragraph", maxTokens: 2000 },
};

/**
 * Multi-section dispatch supplementary section size cap (chars). When running
 * planIdentity or accessInstructions on a NON-primary section (e.g., services_cost_sharing
 * for planIdentity), only the first N chars are sampled to keep cost bounded. Plan-identity
 * scalars typically cluster in section headers / first table BUT large EOCs (Aetna
 * Medicare 493K bytes) may have plan-identity scalars in mid-section "Schedule of Cost
 * Sharing" tables — 30K chars (~7500 input tokens) covers section header + first table
 * + most cost-sharing rows. Cost impact marginal (~$0.005 per call). Per S73 Session 76.
 */
const SUPPLEMENTARY_SECTION_SAMPLE_CHARS = 30_000;

/**
 * Preamble "other" section size minimum (chars). Skip supplementary dispatch on
 * tiny preambles (cover page boilerplate < 200 chars yields no scalars and wastes
 * a Haiku call).
 */
const PREAMBLE_MIN_CHARS = 200;

function allPlanIdentityFieldsPopulated(pi: PlanDocPlanIdentity): boolean {
  // 15 scalars; "all populated" means every field has a non-null value.
  // Used for early-exit from multi-section dispatch (cost optimization).
  return (
    pi.planName.value !== null &&
    pi.insurerName.value !== null &&
    pi.planType.value !== null &&
    pi.metalTier.value !== null &&
    pi.planYear.value !== null &&
    pi.groupNumber.value !== null &&
    pi.networkType.value !== null &&
    pi.deductibleIndividual.value !== null &&
    pi.deductibleFamily.value !== null &&
    pi.oopMaxIndividual.value !== null &&
    pi.oopMaxFamily.value !== null &&
    pi.outDeductibleIndividual.value !== null &&
    pi.outDeductibleFamily.value !== null &&
    pi.outOopMaxIndividual.value !== null &&
    pi.outOopMaxFamily.value !== null
  );
}

function accessInstructionsCoreFieldsPopulated(ai: PlanDocAccessInstructions | null): boolean {
  if (!ai) return false;
  // Core fields: customerServicePhone + networkFinderUrl. domainContacts is
  // ancillary (optional per-domain phones; not gating).
  return ai.customerServicePhone.value !== null && ai.networkFinderUrl.value !== null;
}

/**
 * Sub-segment a section's text into chunks per the config, dispatch each chunk to
 * `fn` sequentially with cost-cap pre-dispatch guard, return chunk results.
 */
async function dispatchSectionAsChunks<T>(
  hint: PlanDocSectionHint,
  sectionText: string,
  sectionRange: { start: number; end: number },
  fn: (
    text: string,
    range: { start: number; end: number },
    em: ExtractionMethod,
    sectionHint: PlanDocSectionHint,
  ) => Promise<{ data: T; haiku_input_tokens: number; haiku_output_tokens: number; haiku_cost_usd: number; warnings: string[] }>,
  extractionMethod: ExtractionMethod,
  costTracker: CostTracker,
  warnings: string[],
  sectionHintOverride?: PlanDocSectionHint,
): Promise<T[]> {
  const config = SECTION_CONFIGS[hint];
  if (!config) return [];

  const chunks = subSegmentSection(sectionText, config.granularity, config.maxTokens, config.fallback);
  if (chunks.length === 0) return [];

  const effectiveHint = sectionHintOverride ?? hint;
  const results: T[] = [];

  for (const chunk of chunks) {
    if (costTracker.totalUsd > COST_HARD_CAP_USD * COST_GUARD_THRESHOLD_USD) {
      warnings.push(`chunk_skipped_near_cost_cap:${effectiveHint}:${chunk.start}`);
      break;
    }
    if (chunk.tokenEstimate > config.maxTokens) {
      warnings.push(`chunk_oversized:${effectiveHint}:${chunk.start}:${chunk.tokenEstimate}`);
    }
    const absRange = {
      start: sectionRange.start + chunk.start,
      end: sectionRange.start + chunk.end,
    };
    try {
      const r = await fn(chunk.text, absRange, extractionMethod, effectiveHint);
      costTracker.totalUsd += r.haiku_cost_usd;
      warnings.push(...r.warnings);
      results.push(r.data);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      warnings.push(`chunk_failed:${effectiveHint}:${chunk.start}:${msg}`);
    }
  }
  return results;
}

/**
 * Dispatch a section as a SINGLE (non-sub-segmented) call. Used for supplementary
 * multi-section dispatch where we want to sample only the header/top of a section
 * (not pay for full sub-segmentation). Caller controls sampling via sectionText param.
 */
async function dispatchSectionSingle<T>(
  sectionText: string,
  sectionRange: { start: number; end: number },
  fn: (
    text: string,
    range: { start: number; end: number },
    em: ExtractionMethod,
    sectionHint: PlanDocSectionHint,
  ) => Promise<{ data: T; haiku_input_tokens: number; haiku_output_tokens: number; haiku_cost_usd: number; warnings: string[] }>,
  extractionMethod: ExtractionMethod,
  costTracker: CostTracker,
  warnings: string[],
  sectionHint: PlanDocSectionHint,
): Promise<T | null> {
  if (costTracker.totalUsd > COST_HARD_CAP_USD * COST_GUARD_THRESHOLD_USD) {
    warnings.push(`single_dispatch_skipped_near_cost_cap:${sectionHint}`);
    return null;
  }
  try {
    const r = await fn(sectionText, sectionRange, extractionMethod, sectionHint);
    costTracker.totalUsd += r.haiku_cost_usd;
    warnings.push(...r.warnings);
    return r.data;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    warnings.push(`single_dispatch_failed:${sectionHint}:${msg}`);
    return null;
  }
}

function pickFirstRange(
  ranges: SectionRanges,
  hint: PlanDocSectionHint,
): { start: number; end: number } | null {
  const arr = ranges[hint];
  if (!arr || arr.length === 0) return null;
  return arr[0];
}

function sampleSectionForSupplementary(text: string, range: { start: number; end: number }): {
  text: string;
  range: { start: number; end: number };
} {
  const fullLength = range.end - range.start;
  if (fullLength <= SUPPLEMENTARY_SECTION_SAMPLE_CHARS) {
    return { text, range };
  }
  // Top of section: scalars + headers tend to live here
  const sampledText = text.slice(0, SUPPLEMENTARY_SECTION_SAMPLE_CHARS);
  return {
    text: sampledText,
    range: { start: range.start, end: range.start + SUPPLEMENTARY_SECTION_SAMPLE_CHARS },
  };
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

  // Step 0: Subtractive boilerplate cleanup (S72 commit 7)
  const cleanup = cleanupBoilerplate(ocrText);
  const workingText = cleanup.cleanedText;
  warnings.push(...cleanup.warnings);
  warnings.push(
    `subtractive_cleanup:stripped_${cleanup.strippedLineCount}_of_${cleanup.originalLineCount}_lines:${(
      (cleanup.strippedLineCount / Math.max(cleanup.originalLineCount, 1)) *
      100
    ).toFixed(1)}%`,
  );

  // Step 0.5: Layout detection (S92 Stage 3a) — Stage A of the layout-aware
  // 2-stage extraction architecture (Pattern P-9: Parse Quality Flywheel).
  // Layout label gates federal-SBC-specific extraction instructions in the
  // plan-identity + services-cost-sharing prompts. See layout-detector.ts.
  const layoutDetection = detectLayout(workingText);
  warnings.push(
    `layout_detected:${layoutDetection.layout}:${layoutDetection.confidence.toFixed(2)}:features=${layoutDetection.features.length}`,
  );
  // Wrap extraction fns with closure baking in detected layout. Lets us reuse
  // the existing dispatchSectionAsChunks / dispatchSectionSingle helpers
  // unchanged. Layout=unknown falls back to default-prompt behavior.
  const layout = layoutDetection.layout === "unknown" ? undefined : layoutDetection.layout;
  const extractPlanIdentityWithLayout = (
    text: string,
    range: { start: number; end: number },
    em: ExtractionMethod,
    hint: PlanDocSectionHint,
  ) => extractPlanIdentity(text, range, em, hint, layout);
  const extractServicesCostSharingWithLayout = (
    text: string,
    range: { start: number; end: number },
    em: ExtractionMethod,
    hint: PlanDocSectionHint,
  ) => extractServicesCostSharing(text, range, em, hint, layout);

  // Step 1: Section segmentation (regex first, on cleaned text)
  let sectionRanges: SectionRanges = segmentPlanDocSections(workingText);
  let segmentationUsed: PlanDocHaikuParseResult["segmentationUsed"] = "regex_only";

  // Step 2: Haiku-discovery fallback per Phase 3.1A Q-P3.1A-4 LOCK pattern
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

  if (
    countPriorityPlanDocSections(sectionRanges) === 0 &&
    (sectionRanges.other?.length ?? 0) > 0
  ) {
    segmentationUsed = "preamble_only";
  }

  // Section text + range references
  const planIdentityRange = pickFirstRange(sectionRanges, "plan_identity");
  const servicesRange = pickFirstRange(sectionRanges, "services_cost_sharing");
  const accessRange = pickFirstRange(sectionRanges, "access_instructions");
  const otherRange = pickFirstRange(sectionRanges, "other");

  const planIdentityText = planIdentityRange ? sliceSection(workingText, sectionRanges, "plan_identity") : null;
  const servicesText = servicesRange ? sliceSection(workingText, sectionRanges, "services_cost_sharing") : null;
  const accessText = accessRange ? sliceSection(workingText, sectionRanges, "access_instructions") : null;
  const otherText = otherRange ? workingText.slice(otherRange.start, otherRange.end) : null;

  // Track which sections were dispatched (for verbatim_absent derivation post-verify)
  const dispatchedSectionsSet = new Set<PlanDocSectionHint>();

  // ── Step 3a: planIdentity multi-section dispatch (S73 — Phase 3.1A.1 inheritance) ──
  // Primary: plan_identity section (sub-segmented if large)
  // Secondary (if not all populated): services_cost_sharing top + preamble "other"
  const planIdentityChunks: PlanDocPlanIdentity[] = [];

  if (planIdentityText && planIdentityRange) {
    const chunks = await dispatchSectionAsChunks(
      "plan_identity",
      planIdentityText,
      planIdentityRange,
      extractPlanIdentityWithLayout,
      extractionMethod,
      costTracker,
      warnings,
    );
    planIdentityChunks.push(...chunks);
    if (chunks.length > 0) dispatchedSectionsSet.add("plan_identity");
  }

  let mergedPlanIdentity = planIdentityChunks.length > 0
    ? mergePlanIdentityChunks(planIdentityChunks)
    : emptyPlanIdentity(extractionMethod);

  // Supplementary sections for planIdentity — dispatched in PARALLEL when primary
  // didn't populate all 15 fields (early-exit short-circuits when primary saturates).
  //
  //   Section #1: services_cost_sharing top (scalars often appear in services
  //     schedule headers — Cigna "The Schedule", Kaiser "Cost Share Summary")
  //   Section #2: preamble "other" (cover page often has plan name + plan year +
  //     insurer name)
  //
  // Parallel dispatch (Promise.all) cuts latency ~2x vs sequential. Cost-cap
  // pre-dispatch guard still enforced in each call; post-aggregation hard cap
  // check below catches any cumulative overshoot.
  if (!allPlanIdentityFieldsPopulated(mergedPlanIdentity)) {
    const supplementaryTasks: Array<Promise<PlanDocPlanIdentity | null>> = [];

    if (servicesText && servicesRange) {
      const sample = sampleSectionForSupplementary(servicesText, servicesRange);
      supplementaryTasks.push(
        dispatchSectionSingle(
          sample.text,
          sample.range,
          extractPlanIdentityWithLayout,
          extractionMethod,
          costTracker,
          warnings,
          "services_cost_sharing",
        ),
      );
    }

    if (otherText && otherRange && otherText.length >= PREAMBLE_MIN_CHARS) {
      const sample = sampleSectionForSupplementary(otherText, otherRange);
      supplementaryTasks.push(
        dispatchSectionSingle(
          sample.text,
          sample.range,
          extractPlanIdentityWithLayout,
          extractionMethod,
          costTracker,
          warnings,
          "other",
        ),
      );
    }

    const supplementaryResults = await Promise.all(supplementaryTasks);
    for (const r of supplementaryResults) {
      if (r) planIdentityChunks.push(r);
    }
    if (supplementaryResults.some((r) => r !== null)) {
      mergedPlanIdentity = mergePlanIdentityChunks(planIdentityChunks);
    }
  }

  // ── Step 3b: services chunk-dispatch (sub-segment + concat + dedup) ──
  let services: PlanDocService[] = [];
  if (servicesText && servicesRange) {
    const chunks = await dispatchSectionAsChunks<{ services: PlanDocService[] }>(
      "services_cost_sharing",
      servicesText,
      servicesRange,
      extractServicesCostSharingWithLayout,
      extractionMethod,
      costTracker,
      warnings,
    );
    if (chunks.length > 0) {
      services = mergeServicesChunks(chunks.map((c) => c.services));
      dispatchedSectionsSet.add("services_cost_sharing");
    }
  }

  // ── Step 3c: accessInstructions multi-section dispatch ──
  const accessInstructionsChunks: PlanDocAccessInstructions[] = [];

  if (accessText && accessRange) {
    const chunks = await dispatchSectionAsChunks(
      "access_instructions",
      accessText,
      accessRange,
      extractAccessInstructions,
      extractionMethod,
      costTracker,
      warnings,
    );
    accessInstructionsChunks.push(...chunks);
    if (chunks.length > 0) dispatchedSectionsSet.add("access_instructions");
  }

  let mergedAccess = mergeAccessInstructionsChunks(accessInstructionsChunks);

  // Supplementary sections for accessInstructions — dispatched in PARALLEL when primary
  // didn't populate both core fields (customerServicePhone + networkFinderUrl).
  //
  //   Section #1: services_cost_sharing top (access info sometimes in service notes)
  //   Section #2: preamble "other" (cover page sometimes has support phone)
  //   Section #3: plan_identity (last resort — sometimes phone listed in plan info box)
  if (!accessInstructionsCoreFieldsPopulated(mergedAccess)) {
    const supplementaryTasks: Array<Promise<PlanDocAccessInstructions | null>> = [];

    if (servicesText && servicesRange) {
      const sample = sampleSectionForSupplementary(servicesText, servicesRange);
      supplementaryTasks.push(
        dispatchSectionSingle(
          sample.text,
          sample.range,
          extractAccessInstructions,
          extractionMethod,
          costTracker,
          warnings,
          "services_cost_sharing",
        ),
      );
    }

    if (otherText && otherRange && otherText.length >= PREAMBLE_MIN_CHARS) {
      const sample = sampleSectionForSupplementary(otherText, otherRange);
      supplementaryTasks.push(
        dispatchSectionSingle(
          sample.text,
          sample.range,
          extractAccessInstructions,
          extractionMethod,
          costTracker,
          warnings,
          "other",
        ),
      );
    }

    if (planIdentityText && planIdentityRange) {
      const sample = sampleSectionForSupplementary(planIdentityText, planIdentityRange);
      supplementaryTasks.push(
        dispatchSectionSingle(
          sample.text,
          sample.range,
          extractAccessInstructions,
          extractionMethod,
          costTracker,
          warnings,
          "plan_identity",
        ),
      );
    }

    const supplementaryResults = await Promise.all(supplementaryTasks);
    for (const r of supplementaryResults) {
      if (r) accessInstructionsChunks.push(r);
    }
    if (supplementaryResults.some((r) => r !== null)) {
      mergedAccess = mergeAccessInstructionsChunks(accessInstructionsChunks);
    }
  }

  // ── Step 4: Cost soft alarm ──
  if (costTracker.totalUsd > COST_SOFT_ALARM_USD) {
    warnings.push(`cost_soft_alarm:${costTracker.totalUsd.toFixed(4)}`);
  }

  // ── Step 5: Telemetry roll-up ──
  // Note: per-chunk costs are tracked in costTracker.totalUsd. Per-chunk
  // input/output tokens are NOT preserved on the merged PlanDocPlanIdentity /
  // services / accessInstructions — telemetry is in costTracker. Aggregate
  // input/output tokens reported as 0 for now since the merged shape doesn't
  // include per-call totals; harness uses costUsd as primary signal.
  // S73-COMMIT-1-NOTE: chunk-level telemetry could be threaded back through if
  // needed for diagnostic tooling. Deferred — not required for HARD GATE.

  // Hard cap check (post-aggregation)
  if (costTracker.totalUsd > COST_HARD_CAP_USD) {
    throw new Error(
      `plan_doc_cost_hard_cap_breached:${documentId}:cost=${costTracker.totalUsd.toFixed(4)}`,
    );
  }

  // Diagnostic telemetry: cumulative populated count post-merge (helps harness narrate progress)
  if (planIdentityChunks.length > 0) {
    let populated = 0;
    for (const key of [
      "planName",
      "insurerName",
      "planType",
      "metalTier",
      "planYear",
      "groupNumber",
      "networkType",
      "deductibleIndividual",
      "deductibleFamily",
      "oopMaxIndividual",
      "oopMaxFamily",
      "outDeductibleIndividual",
      "outDeductibleFamily",
      "outOopMaxIndividual",
      "outOopMaxFamily",
      "isAcaCompliant",
      "acaComplianceBasis",
    ] as const) {
      if (mergedPlanIdentity[key].value !== null) populated += 1;
    }
    warnings.push(`plan_identity_populated_after_merge:${populated}_of_17:chunks=${planIdentityChunks.length}`);
  }

  // ── Step 6: Assemble pre-verification result ──
  // mergedPlanIdentity is already emptyPlanIdentity() when chunks is empty (line above).
  const dispatchedSections = Array.from(dispatchedSectionsSet);

  const preVerificationResult: PlanDocHaikuParseResult = {
    planIdentity: mergedPlanIdentity,
    services,
    accessInstructions: mergedAccess,
    parseWarnings: warnings,
    haikuTokensInput: 0,
    haikuTokensOutput: 0,
    haikuCacheCreateTokens: 0,
    haikuCacheReadTokens: 0,
    costUsd: costTracker.totalUsd,
    parseStrategyV2: true,
    dispatchedSections,
    segmentationUsed,
  };

  // ── Step 7: Pattern P-8 verification ──
  let verifiedResult = verifyPlanDocSourceExcerpts(workingText, preVerificationResult, sectionRanges);

  // ── Step 8: Self-check loop (Iter 2 contingency) — env-var gated ──
  // Fires only when PLAN_DOC_SELF_CHECK_ENABLED=true. For each Pattern P-8 field
  // with source_excerpt_verified='not_found' AND non-empty excerpt, re-prompt Haiku
  // to emit a corrected verbatim substring. Mirrors Phase 3.1A.1 EOC self-check
  // (which achieved 97-100% verbatim rate on EOC fixtures).
  if (isSelfCheckEnabled()) {
    const { updatedResult } = await selfCheckPlanDocExcerpts(verifiedResult, workingText, sectionRanges);
    verifiedResult = verifyPlanDocSourceExcerpts(workingText, updatedResult, sectionRanges);

    // Re-check hard cap (self-check could push us over)
    if (verifiedResult.costUsd > COST_HARD_CAP_USD) {
      throw new Error(
        `plan_doc_cost_hard_cap_breached_post_self_check:${documentId}:cost=${verifiedResult.costUsd.toFixed(4)}`,
      );
    }
  }

  return verifiedResult;
}
