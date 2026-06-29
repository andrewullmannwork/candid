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
import { extractServicesCostSharing, type RawService } from "./haiku-prompts/services-cost-sharing";
import { extractAccessInstructions } from "./haiku-prompts/access-instructions";
import { detectLayout } from "./layout-detector";
import { verifyPlanDocSourceExcerpts } from "./verify-source-excerpts";
import { isSelfCheckEnabled, selfCheckPlanDocExcerpts } from "./self-check";
import { isFeatureEnabled, readFeatureFlagConfig } from "@/lib/config/product-flags";
import { estimateTokens } from "@/lib/haiku-client/base";

const COST_HARD_CAP_USD = 2.0;
const COST_GUARD_THRESHOLD_USD = 0.9; // 90% of hard cap; pre-dispatch chunk-skip guard
const COST_SOFT_ALARM_USD = 0.5;

// S215 cold-start regen — default input-size ceiling (estimated tokens) for the whole-text-primary
// services path. Small docs (SBCs; ≤ ~8.4K tok observed in the 19-plan sample) get whole-text extraction
// (the model sees the plan-level deductible/PA/place context the isolated services section never showed it);
// larger booklets/EOCs stay on the segmented path (cost + the 180s timeout the 436KB Blue Shield SBC hit).
// Tunable via plan_doc_extraction_v2.config.whole_text_max_input_tokens. The size gate just needs generous
// margin — a mis-sized doc that truncates self-heals to the segmented path (the truncation-fallback is the guarantee).
const WHOLE_TEXT_MAX_INPUT_TOKENS_DEFAULT = 16000;

interface CostTracker {
  totalUsd: number;
  /** S187: real token telemetry accumulated at the same sites as cost (was hardcoded 0 in the result). */
  tokensInput: number;
  tokensOutput: number;
  cacheCreateTokens: number;
  cacheReadTokens: number;
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
 * S187 D8 — per-in-flight cost reservation for the pooled path. Conservative per-chunk upper
 * bound at the RECORDED rates the tracker uses (padded-prompt cold cache-write + chunk input +
 * output reserve ~= $0.016 -> $0.02); keeps accumulated + reserved <= the 90% guard so concurrent
 * chunks cannot overrun the $2 hard cap.
 */
const PD_CHUNK_INFLIGHT_RESERVE_USD = 0.02;

/**
 * Sub-segment a section's text into chunks per the config and dispatch each chunk to `fn`.
 * `chunkConcurrency <= 1` (the PROD default until the plan_doc_parser_v2.config flip) takes the
 * EXACT pre-S187 sequential path. `> 1` runs a bounded worker pool: chunk 0 completes SOLO first
 * (warm-then-fan — writes the padded cache prefix once, the fanned chunks read it), results land
 * at their chunk INDEX and are compacted in order (pre-S187 semantics: failures dropped, order
 * preserved — the merge fns are order-sensitive), and admission reserves in-flight cost so the
 * 90% pre-dispatch guard cannot be overrun. Both paths emit a per-section `plan_doc_chunks`
 * summary warning (probe + G7 telemetry).
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
  ) => Promise<{ data: T; haiku_input_tokens: number; haiku_output_tokens: number; haiku_cost_usd: number; haiku_cache_create_tokens: number; haiku_cache_read_tokens: number; warnings: string[] }>,
  extractionMethod: ExtractionMethod,
  costTracker: CostTracker,
  warnings: string[],
  sectionHintOverride?: PlanDocSectionHint,
  chunkConcurrency = 1,
): Promise<T[]> {
  const config = SECTION_CONFIGS[hint];
  if (!config) return [];

  const chunks = subSegmentSection(sectionText, config.granularity, config.maxTokens, config.fallback);
  if (chunks.length === 0) return [];

  const effectiveHint = sectionHintOverride ?? hint;
  let dispatched = 0;
  let failed = 0;
  let skipped = 0;

  const absRangeOf = (chunk: { start: number; end: number }): { start: number; end: number } => ({
    start: sectionRange.start + chunk.start,
    end: sectionRange.start + chunk.end,
  });
  const fold = (r: { haiku_input_tokens: number; haiku_output_tokens: number; haiku_cost_usd: number; haiku_cache_create_tokens: number; haiku_cache_read_tokens: number; warnings: string[] }): void => {
    costTracker.totalUsd += r.haiku_cost_usd;
    costTracker.tokensInput += r.haiku_input_tokens;
    costTracker.tokensOutput += r.haiku_output_tokens;
    costTracker.cacheCreateTokens += r.haiku_cache_create_tokens;
    costTracker.cacheReadTokens += r.haiku_cache_read_tokens;
    warnings.push(...r.warnings);
  };

  if (chunkConcurrency <= 1) {
    // EXACT pre-S187 sequential path (PROD default; byte-equivalent behavior).
    const results: T[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      if (costTracker.totalUsd > COST_HARD_CAP_USD * COST_GUARD_THRESHOLD_USD) {
        warnings.push(`chunk_skipped_near_cost_cap:${effectiveHint}:${chunk.start}`);
        skipped = chunks.length - i;
        break;
      }
      if (chunk.tokenEstimate > config.maxTokens) {
        warnings.push(`chunk_oversized:${effectiveHint}:${chunk.start}:${chunk.tokenEstimate}`);
      }
      try {
        dispatched++;
        const r = await fn(chunk.text, absRangeOf(chunk), extractionMethod, effectiveHint);
        fold(r);
        results.push(r.data);
      } catch (err) {
        failed++;
        const msg = err instanceof Error ? err.message : String(err);
        warnings.push(`chunk_failed:${effectiveHint}:${chunk.start}:${msg}`);
      }
    }
    warnings.push(`plan_doc_chunks:${effectiveHint}:planned=${chunks.length}:dispatched=${dispatched}:failed=${failed}:skipped=${skipped}`);
    return results;
  }

  // Bounded pool — indexed slots, order-preserving compaction (failures dropped, as today).
  for (const chunk of chunks) {
    if (chunk.tokenEstimate > config.maxTokens) {
      warnings.push(`chunk_oversized:${effectiveHint}:${chunk.start}:${chunk.tokenEstimate}`);
    }
  }
  const slots: Array<{ data: T } | null> = new Array<{ data: T } | null>(chunks.length).fill(null);
  let next = 0;
  let inflight = 0;
  let firstSkipWarned = false;
  const wakers: Array<() => void> = [];
  const settle = (): void => {
    wakers.splice(0).forEach((w) => w());
  };
  const waitSettle = (): Promise<void> => new Promise<void>((res) => wakers.push(res));

  const runIdx = async (i: number): Promise<void> => {
    const chunk = chunks[i];
    inflight++;
    dispatched++;
    try {
      const r = await fn(chunk.text, absRangeOf(chunk), extractionMethod, effectiveHint);
      fold(r);
      slots[i] = { data: r.data };
    } catch (err) {
      failed++;
      const msg = err instanceof Error ? err.message : String(err);
      warnings.push(`chunk_failed:${effectiveHint}:${chunk.start}:${msg}`);
    } finally {
      inflight--;
      settle();
    }
  };

  const workerLoop = async (): Promise<void> => {
    for (;;) {
      if (next >= chunks.length) return;
      if (costTracker.totalUsd > COST_HARD_CAP_USD * COST_GUARD_THRESHOLD_USD) {
        if (!firstSkipWarned) {
          firstSkipWarned = true;
          warnings.push(`chunk_skipped_near_cost_cap:${effectiveHint}:${chunks[next].start}`);
        }
        skipped += chunks.length - next;
        next = chunks.length;
        return;
      }
      if (inflight > 0 && costTracker.totalUsd + inflight * PD_CHUNK_INFLIGHT_RESERVE_USD > COST_HARD_CAP_USD * COST_GUARD_THRESHOLD_USD) {
        await waitSettle();
        continue;
      }
      const i = next++;
      await runIdx(i);
    }
  };

  next = 1;
  await runIdx(0);
  const workerCount = Math.min(chunkConcurrency, Math.max(chunks.length - 1, 0));
  if (workerCount > 0) {
    await Promise.all(Array.from({ length: workerCount }, () => workerLoop()));
  }
  warnings.push(`plan_doc_chunks:${effectiveHint}:planned=${chunks.length}:dispatched=${dispatched}:failed=${failed}:skipped=${skipped}`);
  return slots.filter((s): s is { data: T } => s !== null).map((s) => s.data);
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
  ) => Promise<{ data: T; haiku_input_tokens: number; haiku_output_tokens: number; haiku_cost_usd: number; haiku_cache_create_tokens: number; haiku_cache_read_tokens: number; warnings: string[] }>,
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
    costTracker.tokensInput += r.haiku_input_tokens;
    costTracker.tokensOutput += r.haiku_output_tokens;
    costTracker.cacheCreateTokens += r.haiku_cache_create_tokens;
    costTracker.cacheReadTokens += r.haiku_cache_read_tokens;
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
  /** S187 D8 — bounded per-chunk concurrency (caller-resolved: the plan-doc-parser dispatcher
   *  reads plan_doc_parser_v2.config.chunk_concurrency; harnesses pass it explicitly). 1/absent
   *  = exact pre-S187 sequential dispatch. Clamped 1..16 here. */
  chunkConcurrency?: number;
  /** S215 cold-start regen — override for `plan_doc_extraction_v2` (calibration independence).
   *  undefined → read the live flag. Gates BOTH the codified-learnings prompt supplement AND the
   *  whole-text OCR-collapse fallback. */
  extractionV2?: boolean;
  /** A3 (S235) — override for `thesaurus_phase1a_v1` at the PROMPT leg (gates rawLabel emission,
   *  the synonym cache's input). undefined → read the live flag (byte-identical). Set by the in-vivo
   *  smoke so the whole synonym path runs flag-ON without flipping global PROD. */
  thesaurusPhase1a?: boolean;
  /** coverage_dims_v1 — override for the per-service referral + visit/day-count-cap prompt fields.
   *  undefined → read the live flag (OFF → byte-identical). Set by the §13 oracle harness to measure
   *  flag-ON without flipping global PROD. */
  coverageDims?: boolean;
  /** S253 cold-start regen Stage C — inject the Sonnet sub-agent's cached raw services. When set,
   *  parsePlanDocumentHaiku skips ALL LLM dispatch and returns them post-processed (deterministic,
   *  services-only; identity/access skipped, owned by the identity phase). undefined → normal parse. */
  rawServicesOverride?: RawService[];
}

export async function parsePlanDocumentHaiku(
  input: ParsePlanDocInput,
): Promise<PlanDocHaikuParseResult> {
  const { ocrText, extractionMethod, documentId } = input;
  const chunkConcurrency =
    typeof input.chunkConcurrency === "number" && Number.isFinite(input.chunkConcurrency) && input.chunkConcurrency >= 1
      ? Math.min(Math.floor(input.chunkConcurrency), 16)
      : 1;
  const warnings: string[] = [];
  const costTracker: CostTracker = { totalUsd: 0, tokensInput: 0, tokensOutput: 0, cacheCreateTokens: 0, cacheReadTokens: 0 };

  // S215 cold-start regen: resolve the extraction-v2 flag ONCE (input override for calibration
  // independence; else the live flag). Threaded to the services prompt supplement AND the
  // whole-text fallback so both gates stay in lockstep. OFF → byte-identical to the pre-v2 pipeline.
  const extractionV2Enabled = input.extractionV2 ?? (await isFeatureEnabled("plan_doc_extraction_v2"));
  // A3 (S235): resolve the thesaurus-phase1a override for the PROMPT leg (rawLabel emission). The
  // routing leg resolves the same flag in process-plan; threading it here keeps both legs in
  // lockstep so the in-vivo smoke drives the whole synonym path. undefined → live flag → byte-identical.
  const thesaurusPhase1aEnabled = input.thesaurusPhase1a ?? (await isFeatureEnabled("thesaurus_phase1a_v1"));
  // coverage_dims_v1: resolve ONCE here (no per-chunk read / no mid-parse flip) and thread to the
  // services prompt. OFF → byte-identical (the two extra fields are never requested).
  const coverageDimsEnabled = input.coverageDims ?? (await isFeatureEnabled("coverage_dims_v1"));
  const wholeTextMaxInputTokens = await readFeatureFlagConfig(
    "plan_doc_extraction_v2",
    "whole_text_max_input_tokens",
    WHOLE_TEXT_MAX_INPUT_TOKENS_DEFAULT,
  );

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
  ) => extractServicesCostSharing(text, range, em, hint, layout, thesaurusPhase1aEnabled, extractionV2Enabled, coverageDimsEnabled);

  // ── Seed Stage C (S253 cold-start regen): deterministic services-only override, NO LLM ──
  // Inject the Sonnet sub-agent's cached raw services and reuse extractServicesCostSharing's post-processors
  // (referral/visit/cite-grade) against the RAW `ocrText` the agent saw (NOT cleaned `workingText` → the
  // cached excerpts ground verbatim). Forces the single whole-text call regardless of doc size. Identity,
  // access, and discovery are skipped — identity is owned by the dedicated identity phase (§19-D) and is
  // PRESERVED at the persist layer via seedMode (a services-only override carries no identity).
  if (input.rawServicesOverride !== undefined) {
    const r = await extractServicesCostSharing(
      ocrText,
      { start: 0, end: ocrText.length },
      extractionMethod,
      "services_cost_sharing",
      layout,
      thesaurusPhase1aEnabled,
      extractionV2Enabled,
      coverageDimsEnabled,
      input.rawServicesOverride,
    );
    // §19-E (amended S254): the inject's real silent-loss point is the post-processor's slug-less filter
    // (services-cost-sharing.ts) — NOT legacy/haiku length (1:1 via toLegacyPlanDocResult, can't diverge).
    // Surface any drop so the bulk run + degradation gate notice missing services (warn, not throw — a
    // slug-less cached entry is a data-quality issue; keep the valid services per the recall bias).
    const injectedCount = input.rawServicesOverride.length;
    const survivedCount = r.data.services.length;
    if (survivedCount !== injectedCount) {
      warnings.push(`seed_override_drop:${injectedCount - survivedCount}_of_${injectedCount}_at_post_processor`);
      console.warn(
        `[parser] seed inject dropped ${injectedCount - survivedCount}/${injectedCount} override services (slug-less) for ${documentId}`,
      );
    }
    const seedResult: PlanDocHaikuParseResult = {
      planIdentity: emptyPlanIdentity(extractionMethod),
      services: r.data.services,
      accessInstructions: null,
      parseWarnings: [
        ...warnings,
        ...r.warnings,
        `seed_override:${documentId}:${input.rawServicesOverride.length}_raw_services`,
      ],
      haikuTokensInput: 0,
      haikuTokensOutput: 0,
      haikuCacheCreateTokens: 0,
      haikuCacheReadTokens: 0,
      costUsd: 0,
      parseStrategyV2: true,
      dispatchedSections: ["services_cost_sharing"],
      segmentationUsed: "seed_override",
    };
    // §14 #5 cite-grade (S254): the seed early-returns BEFORE the normal verify post-pass (~line 875),
    // so the cached excerpts would stay source_excerpt_verified="not_found" (not cite-grade). Verify them
    // against the RAW ocrText (the text the sub-agent saw, §19 grounding); verifyOne matches whole-text,
    // so one services_cost_sharing range over [0,len] is correct. ~98-100% of cached excerpts are verbatim
    // → cite-grade. dispatchedSections=[services_cost_sharing] (not all) prevents false verbatim_absent.
    return verifyPlanDocSourceExcerpts(ocrText, seedResult, {
      services_cost_sharing: [{ start: 0, end: ocrText.length }],
    });
  }

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
      undefined,
      chunkConcurrency,
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

  // ── Step 3b: services extraction ──
  let services: PlanDocService[] = [];

  // S215 extraction v2 — WHOLE-TEXT PRIMARY for small docs. A SINGLE call over the whole cleaned document
  // gives the model the plan-level deductible statement + prior-auth prose + place context that the isolated
  // services SECTION never showed it (recovers place / in-ded / PA / limits). Gated on input size so large
  // booklets/EOCs stay on the cheaper segmented path (cost + the 180s timeout the Blue Shield giant hit).
  // HARD-TRUNCATION SELF-HEALS: if the call truncates even at the 32K budget (haiku_truncation_at_max), throws
  // a JSON-parse error (cut mid-array), or returns 0 services, it is discarded and the established segmented
  // path below runs instead — so the size gate only needs generous margin; the fallback is the guarantee.
  if (
    extractionV2Enabled &&
    workingText.trim().length > 0 &&
    estimateTokens(workingText) <= wholeTextMaxInputTokens &&
    costTracker.totalUsd <= COST_HARD_CAP_USD * COST_GUARD_THRESHOLD_USD
  ) {
    try {
      const r = await extractServicesCostSharingWithLayout(
        workingText,
        { start: 0, end: workingText.length },
        extractionMethod,
        "services_cost_sharing",
      );
      // Fold cost/tokens exactly as dispatchSectionAsChunks does (single call, no chunk loop).
      costTracker.totalUsd += r.haiku_cost_usd;
      costTracker.tokensInput += r.haiku_input_tokens;
      costTracker.tokensOutput += r.haiku_output_tokens;
      costTracker.cacheCreateTokens += r.haiku_cache_create_tokens;
      costTracker.cacheReadTokens += r.haiku_cache_read_tokens;
      warnings.push(...r.warnings);
      const truncated = r.warnings.some((w) => w.startsWith("haiku_truncation_at_max"));
      if (truncated) {
        warnings.push(`whole_text_truncated:${documentId}:reparse_segmented`);
      } else if (r.data.services.length > 0) {
        services = r.data.services;
        dispatchedSectionsSet.add("services_cost_sharing");
        segmentationUsed = "whole_text_primary";
      }
    } catch (err) {
      warnings.push(
        `whole_text_failed:${documentId}:reparse_segmented:${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Segmented services dispatch — the ESTABLISHED process. Runs when whole-text-primary was not used
  // (flag off / big doc) OR was discarded (truncated / failed / 0 services). Byte-identical to the pre-S215
  // path whenever whole-text-primary did not produce services.
  if (services.length === 0 && servicesText && servicesRange) {
    const chunks = await dispatchSectionAsChunks<{ services: PlanDocService[] }>(
      "services_cost_sharing",
      servicesText,
      servicesRange,
      extractServicesCostSharingWithLayout,
      extractionMethod,
      costTracker,
      warnings,
      undefined,
      chunkConcurrency,
    );
    if (chunks.length > 0) {
      services = mergeServicesChunks(chunks.map((c) => c.services));
      dispatchedSectionsSet.add("services_cost_sharing");
    }
  }

  // ── Step 3b.5: whole-text services fallback (S215 extraction v2 — OCR-collapse recovery) ──
  // When segmentation finds no services section, or the services dispatch yields ZERO services
  // (the federal_sbc_8page OCR-line-collapse failure: tables OCR into mega-lines so the line-based
  // segmenter finds nothing), re-run services extraction over the WHOLE cleaned document, size-chunked.
  // Reflow-robust: no dependence on line-based section headers. Reuses dispatchSectionAsChunks so the
  // per-chunk cost-cap guard + the $2 hard cap still bound it (a huge doc extracts until ~90% of cap then
  // stops — a partial recovery is strictly better than a 0-service failure). Gated on the flag (OFF → never
  // runs) AND on services.length === 0 (so a normal parse is byte-identical even when the flag is ON).
  if (extractionV2Enabled && services.length === 0 && workingText.trim().length > 0) {
    warnings.push(`whole_text_services_fallback:${documentId}:segmentation_yielded_0_services`);
    const wholeRange = { start: 0, end: workingText.length };
    const chunks = await dispatchSectionAsChunks<{ services: PlanDocService[] }>(
      "services_cost_sharing",
      workingText,
      wholeRange,
      extractServicesCostSharingWithLayout,
      extractionMethod,
      costTracker,
      warnings,
      undefined,
      chunkConcurrency,
    );
    if (chunks.length > 0) {
      services = mergeServicesChunks(chunks.map((c) => c.services));
      dispatchedSectionsSet.add("services_cost_sharing");
      segmentationUsed = "whole_text_fallback";
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
      undefined,
      chunkConcurrency,
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
    haikuTokensInput: costTracker.tokensInput,
    haikuTokensOutput: costTracker.tokensOutput,
    haikuCacheCreateTokens: costTracker.cacheCreateTokens,
    haikuCacheReadTokens: costTracker.cacheReadTokens,
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
