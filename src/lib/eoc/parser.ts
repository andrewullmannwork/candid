/**
 * EOC parser main orchestrator per Phase 3.1A Subplan + DR-3.1A-C, refactored
 * for Phase 3.1A.1 sub-segmentation per DR-3.1A.1-B v3 (Phase 2 EOC
 * subtractive-cleanup adoption — S73 Session 76).
 *
 * Architecture (Phase 3.1A.1 v3 + S73 subtractive-cleanup):
 *   0. Subtractive boilerplate cleanup — strip TOC + repeated page furniture
 *      (NEW S73 — adopted from plan_doc parser per S72-COMMIT-7 BSCA EOC services
 *      19 → 89 lift). Conservative bias (when in doubt, KEEP). Definitions section
 *      protected — TOC detector requires ≥5 consecutive TOC-pattern lines; alphabetical
 *      definitions are typically prose paragraphs, not TOC patterns.
 *   1. Plan identity REUSE — invokes parsePlanDocument() (Q-P3.1A-11) on CLEANED text
 *   2. Section segmentation — regex first; Haiku discovery fallback if <2 of 6 priority
 *   3. Preamble synthesis (Phase 3.1B.1 universal pattern)
 *   4. Per-section sub-segmentation — line/paragraph/term granularity per Q-P3.1A.1-1
 *   5. Sequential per-chunk Haiku dispatch within section; sections in parallel via
 *      Promise.allSettled. Cost-cap 90% threshold pre-dispatch guard.
 *   6. Result combine — array sections concat (NO dedup per DR-3.1A.1-B-2);
 *      single-block sections field-merge per Q-P3.1A.1-6 v3
 *   7. full_text for single-blocks = sectionText (per DR-3.1A.1-B-3)
 *   8. Pattern P-8 verification (whitespace-normalized fallback per Phase 3.1B.1)
 *      operates on CLEANED text (downstream dispatch + verifier coordinate space
 *      preserved)
 *   9. Self-check loop (Iter 2 contingency) — env-var gated per DR-3.1A.1-B-4
 *  10. Cost hard cap $1/EOC (Q-P3.1A-6 LOCK)
 *
 * Recall-maximize bias per `feedback_candid_recall_over_precision`. Citation-grade
 * strictness preserved at consumer-read layer (Pattern P-8 hard rule unchanged).
 *
 * S73 (Session 76) regression check: Blue Shield + Aetna + Kaiser EOC fixtures
 * must preserve Phase 3.1A.1 baseline (97-100% Pattern P-8 verified rate) after
 * subtractive-cleanup adoption. Run via `npx tsx scripts/parse-harness.ts
 * --fixtures-dir tests/fixtures/eocs --run-id session_76_s73_eoc_cleanup_baseline`.
 */

import { parsePlanDocument } from "../plan/plan-doc-parser";
import type { ExtractionMethod, SectionRanges } from "../parser/types";
import { cleanupBoilerplate } from "../plan_doc/subtractive-cleanup";
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
import { extractAcaCompliance, type EocAcaComplianceData } from "./haiku-prompts/aca-compliance";
import { type Chunk, type Granularity, subSegmentSection } from "./sub-segment";
import { isSelfCheckEnabled, selfCheckExcerpts } from "./self-check";
import { computeColumnWrapDecision } from "../sbc/column-wrap-detector";

const COST_HARD_CAP_USD = 1.0;
const COST_GUARD_THRESHOLD_USD = 0.9; // 90% of hard cap; pre-dispatch chunk-skip guard
const COST_SOFT_ALARM_USD = 0.45;
const COST_SOFT_TARGET_USD = 0.3;
const FULL_TEXT_SIZE_WARN_BYTES = 50_000; // DR-3.1A.1-B-3 LOCK
// S74.6 D1 §A.1 — ACA-compliance signal lives in cover page / preamble /
// plan-summary box. Cap at 15k chars of cleaned text (~3.75k tokens input)
// keeps the call cheap (~$0.005) while covering the regions where the
// signal universally appears. Doc-short cases pass the whole doc.
const ACA_SCAN_CHAR_BUDGET = 15_000;

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
 * Per-in-flight cost reservation for the pooled path (S187 D8). Conservative upper bound on one
 * chunk call at the RECORDED rates the tracker uses: padded-prompt cold cache-write (~8K tok x
 * $0.8/M x 1.25 ~= $0.008) + worst observed chunk input (~1.8K tok ~= $0.0015) + output reserve
 * (~1.5K tok x $4/M = $0.006) ~= $0.016 -> $0.02. Keeps accumulated + reserved <= the 90% guard so
 * concurrent chunks can NEVER push past the $1.00 hard cap (which THROWS the whole parse).
 */
const CHUNK_INFLIGHT_RESERVE_USD = 0.02;

/** S187 D8 — chunk-concurrency clamp (1..16; non-finite/absent → 1 = exact pre-S187 dispatch). */
function clampChunkConcurrency(k: number | undefined): number {
  if (typeof k !== "number" || !Number.isFinite(k) || k < 1) return 1;
  return Math.min(Math.floor(k), 16);
}

/**
 * Dispatch chunks for one section. `chunkConcurrency <= 1` (the PROD default until the
 * eoc_parser_v1.config flip) takes the EXACT pre-S187 sequential path. `> 1` runs a bounded
 * worker pool: chunk 0 completes SOLO first (warm-then-fan — a cache entry is readable only
 * after the first response begins, so the warm call writes the padded prefix and the fanned
 * chunks read it), results land at their chunk INDEX (`new Array(n).fill(null)` — combine fns
 * filter `c !== null`, and `undefined !== null` would pass the filter and TypeError; explicit
 * nulls reproduce failed/skipped semantics exactly), and admission reserves in-flight cost so
 * the 90% pre-dispatch guard cannot be overrun into the post-aggregation $1 hard-cap THROW.
 * Sections themselves run in PARALLEL via Promise.allSettled at the orchestrator level.
 * Every path emits the per-section `eoc_chunks` summary warning (probe + G7 telemetry).
 */
async function dispatchChunks<T>(
  hint: EOCSectionHint,
  config: DispatchConfig,
  sectionRange: { start: number; end: number },
  sectionText: string,
  fn: (text: string, range: { start: number; end: number }, em: ExtractionMethod) => Promise<EOCSectionResult<T>>,
  extractionMethod: ExtractionMethod,
  costTracker: CostTracker,
  chunkConcurrency: number,
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

  let dispatched = 0;
  let failed = 0;
  let skipped = 0;

  if (chunkConcurrency <= 1) {
    // EXACT pre-S187 sequential path (PROD default; byte-equivalent behavior).
    const chunkResults: Array<EOCSectionResult<T> | null> = [];
    for (const chunk of chunks) {
      if (costTracker.totalUsd > COST_HARD_CAP_USD * COST_GUARD_THRESHOLD_USD) {
        warnings.push(`chunk_skipped_near_cost_cap:${hint}:${chunk.start}`);
        skipped = chunks.length - chunkResults.length;
        break;
      }
      const absRange = { start: sectionRange.start + chunk.start, end: sectionRange.start + chunk.end };
      try {
        dispatched++;
        const r = await fn(chunk.text, absRange, extractionMethod);
        chunkResults.push(r);
        costTracker.totalUsd += r.haiku_cost_usd;
      } catch (err) {
        failed++;
        chunkResults.push(null);
        warnings.push(`chunk_failed:${hint}:${chunk.start}:${err instanceof Error ? err.message : String(err)}`);
      }
    }
    warnings.push(`eoc_chunks:${hint}:planned=${chunks.length}:dispatched=${dispatched}:failed=${failed}:skipped=${skipped}`);
    return { chunkResults, warnings };
  }

  // Bounded pool (indexed writes preserve document order for the order-sensitive combine fns
  // + the S185 accumulator's first-passage semantics, regardless of completion order).
  const chunkResults: Array<EOCSectionResult<T> | null> = new Array<EOCSectionResult<T> | null>(chunks.length).fill(null);
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
    const absRange = { start: sectionRange.start + chunk.start, end: sectionRange.start + chunk.end };
    inflight++;
    dispatched++;
    try {
      const r = await fn(chunk.text, absRange, extractionMethod);
      chunkResults[i] = r;
      costTracker.totalUsd += r.haiku_cost_usd;
    } catch (err) {
      failed++;
      warnings.push(`chunk_failed:${hint}:${chunk.start}:${err instanceof Error ? err.message : String(err)}`);
    } finally {
      inflight--;
      settle();
    }
  };

  const workerLoop = async (): Promise<void> => {
    for (;;) {
      if (next >= chunks.length) return;
      if (costTracker.totalUsd > COST_HARD_CAP_USD * COST_GUARD_THRESHOLD_USD) {
        // Hard stop: skip every remaining chunk (single warning, today's semantics).
        if (!firstSkipWarned) {
          firstSkipWarned = true;
          warnings.push(`chunk_skipped_near_cost_cap:${hint}:${chunks[next].start}`);
        }
        skipped += chunks.length - next;
        next = chunks.length;
        return;
      }
      if (inflight > 0 && costTracker.totalUsd + inflight * CHUNK_INFLIGHT_RESERVE_USD > COST_HARD_CAP_USD * COST_GUARD_THRESHOLD_USD) {
        // Reservation pressure: wait for an in-flight settle, then re-check (do NOT skip yet —
        // only an actual totalUsd breach above breaks the section).
        await waitSettle();
        continue;
      }
      const i = next++;
      await runIdx(i);
    }
  };

  // Warm-then-fan: chunk 0 solo writes the cache prefix, then K workers over the rest.
  next = 1;
  await runIdx(0);
  const workerCount = Math.min(chunkConcurrency, Math.max(chunks.length - 1, 0));
  if (workerCount > 0) {
    await Promise.all(Array.from({ length: workerCount }, () => workerLoop()));
  }
  warnings.push(`eoc_chunks:${hint}:planned=${chunks.length}:dispatched=${dispatched}:failed=${failed}:skipped=${skipped}`);
  return { chunkResults, warnings };
}

function sumTelemetry<T>(
  chunks: Array<EOCSectionResult<T> | null>,
): { input: number; output: number; cost: number; cacheCreate: number; cacheRead: number; warnings: string[] } {
  let input = 0;
  let output = 0;
  let cost = 0;
  let cacheCreate = 0;
  let cacheRead = 0;
  const warnings: string[] = [];
  for (const c of chunks) {
    if (!c) continue;
    input += c.haiku_input_tokens;
    output += c.haiku_output_tokens;
    cost += c.haiku_cost_usd;
    cacheCreate += c.haiku_cache_create_tokens;
    cacheRead += c.haiku_cache_read_tokens;
    warnings.push(...c.warnings);
  }
  return { input, output, cost, cacheCreate, cacheRead, warnings };
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
    haiku_cache_create_tokens: tel.cacheCreate,
    haiku_cache_read_tokens: tel.cacheRead,
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
    haiku_cache_create_tokens: tel.cacheCreate,
    haiku_cache_read_tokens: tel.cacheRead,
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
    haiku_cache_create_tokens: tel.cacheCreate,
    haiku_cache_read_tokens: tel.cacheRead,
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
    haiku_cache_create_tokens: tel.cacheCreate,
    haiku_cache_read_tokens: tel.cacheRead,
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
    haiku_cache_create_tokens: tel.cacheCreate,
    haiku_cache_read_tokens: tel.cacheRead,
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
    haiku_cache_create_tokens: tel.cacheCreate,
    haiku_cache_read_tokens: tel.cacheRead,
    warnings: tel.warnings,
  };
}

// ── Main parser ───────────────────────────────────────────────────────────

export async function parseEOC(
  ocrText: string,
  options: {
    documentId: string;
    extractionMethod: ExtractionMethod;
    // Ing-H (CF-44, S129) — caller-resolved cf44_selective_self_check flag.
    // When true, self-check fires only when column_wrap_score > 0.6.
    // When false (or omitted), preserves current always-fire behavior.
    selectiveSelfCheckEnabled?: boolean;
    // S180 thesaurus P1 — live catalog vocabulary block injected into the medical_necessity
    // extraction prompt so Haiku maps to a real slug instead of inventing one (Pattern S #17).
    // Loaded by the caller (process-eoc, which holds the supabase client); omitted by
    // supabase-free callers → the prompt keeps its anti-invention rules without the explicit list.
    serviceVocabulary?: string;
    // S182 thesaurus P2 (M1 fix) — the `eoc_prose_prior_auth_v1` flag, read ONCE by process-eoc and
    // threaded here so a single read gates BOTH the medical_necessity prompt (content-type + C1 split)
    // and the routeCriterion dispatch (no split-brain). OFF/omitted → the frozen pre-P2 prompt, so a
    // flag-OFF parse is byte-identical to post-D1 (no split → no coverage_rules clobber).
    eocContentTypeRoutingOn?: boolean;
    // S187 D8 — bounded per-chunk concurrency within each section. Read ONCE by process-eoc from
    // eoc_parser_v1.config.chunk_concurrency (the parser itself NEVER reads flags — tsx harnesses
    // can't construct the server client; single-read no-split-brain pattern as above). Omitted/1 →
    // the exact pre-S187 sequential dispatch. Clamped 1..16.
    chunkConcurrency?: number;
    // S187 D8 — same knob for the embedded plan-doc leg (threaded into parsePlanDocument's options;
    // PROD leaves it undefined → that dispatcher reads plan_doc_parser_v2.config.chunk_concurrency).
    planDocChunkConcurrency?: number;
    // S187 (calibration/eval ONLY — e.g. T5 measures section extraction, which never consumes
    // plan-identity output). Skips the plan-identity leg entirely; PROD never sets this.
    skipPlanIdentity?: boolean;
  },
): Promise<EOCParseResult> {
  const { documentId, extractionMethod } = options;
  const selectiveSelfCheckEnabled = options.selectiveSelfCheckEnabled ?? false;
  const warnings: string[] = [];
  const parseErrors: Array<{ section: EOCSectionHint; error: string }> = [];

  // 0. Subtractive boilerplate cleanup (S73 — Phase 2 EOC adoption per master plan §S73).
  // Strips TOC region + repeating page furniture. All downstream operations
  // (plan-identity reuse + segmentation + per-section dispatch + verifier) operate
  // in cleaned-text coordinate space.
  //
  // S78: env gate `EOC_SUBTRACTIVE_CLEANUP_ENABLED` REMOVED. Session 78 parse-harness
  // regression check confirmed Phase 3.1A.1 baseline preserved (Aetna excerpt 96%→96%
  // no-op; Blue Shield excerpt 97%→98% +1pt with 8 more fields citing; Kaiser
  // 98%→98% with 1 more field citing). Cleanup is now unconditional.
  const cleanup = cleanupBoilerplate(ocrText);
  const workingText = cleanup.cleanedText;
  warnings.push(...cleanup.warnings);
  warnings.push(
    `eoc_subtractive_cleanup:stripped_${cleanup.strippedLineCount}_of_${cleanup.originalLineCount}_lines:${(
      (cleanup.strippedLineCount / Math.max(cleanup.originalLineCount, 1)) *
      100
    ).toFixed(1)}%`,
  );

  // S187 D8 — leg overlap: the plan-identity + ACA legs ran SERIALLY BEFORE the sections
  // (S187 baseline measured the plan-doc leg alone at ~91 sequential Haiku calls on ecm-14).
  // Both legs were ALREADY failure-isolated (catch → warning), so overlapping them with the
  // sections pipeline preserves failure semantics; their results are awaited before aggregation.
  const parseStartMs = Date.now();
  let planIdentityMs = 0;
  let acaMs = 0;
  const costTracker: CostTracker = { totalUsd: 0 };

  // 1. Plan identity REUSE per Q-P3.1A-11.
  const planIdentityDefaults: EOCPlanIdentity = {
    insurer_name: null,
    plan_name: null,
    plan_year: null,
    in_deductible_individual: null,
    in_oop_max_individual: null,
    out_deductible_individual: null,
    out_oop_max_individual: null,
  };
  const planIdentityLeg = (async (): Promise<EOCPlanIdentity> => {
    const t0 = Date.now();
    if (options.skipPlanIdentity) {
      warnings.push(`plan_identity_skipped_by_option:${documentId}`);
      planIdentityMs = Date.now() - t0;
      return planIdentityDefaults;
    }
    try {
      // Per Q-S72-2 (b) LOCK: parsePlanDocument is now an async flag-gated dispatcher.
      // When `plan_doc_parser_v2` OFF → legacy regex (Q-P3.1A-11 LOCK behavior unchanged).
      // When ON → Haiku-first plan-identity extraction (~49% → ~80%+ recall lift for EOC).
      // Plan-doc parser internally applies its own subtractive cleanup; passing cleanedText
      // is idempotent (second cleanup pass finds nothing to strip — same input shape).
      const planParse = await parsePlanDocument(workingText, {
        documentId,
        extractionMethod,
        chunkConcurrency: options.planDocChunkConcurrency,
      });
      planIdentityMs = Date.now() - t0;
      return {
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
      planIdentityMs = Date.now() - t0;
      return planIdentityDefaults;
    }
  })();

  // 1.5 S74.6 D1 §A.1 — ACA-compliance extraction. Independent of the 6
  // priority sections because ACA signal lives in cover page / preamble /
  // plan-summary box rather than diagnostic sections. Dispatched against a
  // bounded slice of cleaned text (ACA_SCAN_CHAR_BUDGET) to keep cost ~$0.005.
  // Non-fatal: dispatch failure logs a warning + leaves aca_compliance=null
  // so process-eoc.ts falls back to the conservative-for-users default per
  // Subplan §1 LOCK.
  const acaLeg = (async (): Promise<EOCSectionResult<EocAcaComplianceData> | null> => {
    const t0 = Date.now();
    try {
      const acaSliceEnd = Math.min(workingText.length, ACA_SCAN_CHAR_BUDGET);
      const acaText = workingText.slice(0, acaSliceEnd);
      const aca = await extractAcaCompliance(
        acaText,
        { start: 0, end: acaSliceEnd },
        extractionMethod,
      );
      // S187: seed the chunk guard with the ACA spend. Pre-S187 the guard tracker EXCLUDED the
      // ACA call while the post-aggregation $1 hard cap INCLUDED it — a latent mismatch; aligning
      // them is deliberate (guard trips marginally earlier, the throw becomes unreachable-by-guard).
      costTracker.totalUsd += aca.haiku_cost_usd;
      acaMs = Date.now() - t0;
      return aca;
    } catch (err) {
      warnings.push(
        `eoc_aca_compliance_extraction_failed:${documentId}:${err instanceof Error ? err.message : String(err)}`,
      );
      acaMs = Date.now() - t0;
      return null;
    }
  })();

  // 2. Section segmentation — regex first (on cleaned text).
  let sectionRanges = segmentEOCSections(workingText);
  let segmentationUsed: EOCParseResult["segmentation_used"] = "regex_only";

  // 3. Section-discovery Haiku fallback (Q-P3.1A-4 LOCK).
  const regexCount = countPrioritySections(sectionRanges);
  if (regexCount < 2) {
    warnings.push(`eoc_section_discovery_fallback:${documentId}:regex_found_${regexCount}`);
    try {
      const discovered = await discoverSectionsViaHaiku(workingText);
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

  // 4. Per-section sub-segmented dispatch — sections in parallel; chunks sequential (K=1, the
  // PROD default) or bounded-pooled (K>1) within each section per dispatchChunks (S187 D8).
  const chunkConcurrency = clampChunkConcurrency(options.chunkConcurrency);

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
    const sectionText = sliceSection(workingText, range);
    const { chunkResults, warnings: chunkWarnings } = await dispatchChunks(
      hint,
      config,
      range,
      sectionText,
      fn,
      extractionMethod,
      costTracker,
      chunkConcurrency,
    );
    const combined = combineFn(chunkResults, range, sectionText);
    return { result: combined, warnings: chunkWarnings };
  };

  const sectionsStartMs = Date.now();
  const [paOutcome, mnOutcome, apOutcome, cobOutcome, elOutcome, defOutcome] = await Promise.allSettled([
    dispatchSection(
      "prior_auth_codes",
      extractPriorAuthCodes,
      (cs, r) => combinePriorAuthCodes(cs, r),
    ),
    dispatchSection(
      "medical_necessity",
      (text, range, em) =>
        extractMedicalNecessity(text, range, em, options.serviceVocabulary, options.eocContentTypeRoutingOn ?? false),
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

  const sectionsMs = Date.now() - sectionsStartMs;
  // S187 leg overlap: join the plan-identity + ACA legs before aggregation (both are
  // failure-isolated; rejection is impossible by construction — they resolve their values).
  const [planIdentity, acaCompliance] = await Promise.all([planIdentityLeg, acaLeg]);

  // 5. Aggregate + assign.
  const sections: EOCParseResult["sections"] = {};
  let totalCostUsd = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheCreateTokens = 0;
  let totalCacheReadTokens = 0;

  // Fold ACA dispatch telemetry into the run totals (cost-cap + soft-alarm
  // checks below must account for the additional Haiku call).
  if (acaCompliance) {
    totalCostUsd += acaCompliance.haiku_cost_usd;
    totalInputTokens += acaCompliance.haiku_input_tokens;
    totalOutputTokens += acaCompliance.haiku_output_tokens;
    totalCacheCreateTokens += acaCompliance.haiku_cache_create_tokens;
    totalCacheReadTokens += acaCompliance.haiku_cache_read_tokens;
    warnings.push(...acaCompliance.warnings);
  }

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
        totalCacheCreateTokens += r.haiku_cache_create_tokens;
        totalCacheReadTokens += r.haiku_cache_read_tokens;
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
    total_cache_create_tokens: totalCacheCreateTokens,
    total_cache_read_tokens: totalCacheReadTokens,
    timings: {
      plan_identity_ms: planIdentityMs,
      aca_ms: acaMs,
      sections_ms: sectionsMs,
      total_ms: Date.now() - parseStartMs,
    },
    segmentation_used: segmentationUsed,
    aca_compliance: acaCompliance,
    warnings,
    parse_errors: parseErrors,
    dispatched_sections,
  };

  let final = verifyEOCSourceExcerpts(workingText, preliminary, sectionRanges);

  // 8. Self-check loop (Iter 2 contingency) — env-var gated per DR-3.1A.1-B-4.
  //
  // Ing-H (CF-44, S129) selective gate: when cf44_selective_self_check flag
  // is ON (resolved by caller + passed as options.selectiveSelfCheckEnabled),
  // self-check fires ONLY when column_wrap_score > 0.6. When flag OFF,
  // decision.fired=true always (preserves current behavior). Decision struct
  // is attached to result for caller to persist to
  // documents.metadata.column_wrap_decision.
  const columnWrapDecision = computeColumnWrapDecision(
    workingText,
    "eoc",
    selectiveSelfCheckEnabled,
  );
  if (isSelfCheckEnabled() && columnWrapDecision.fired) {
    const { updatedResult } = await selfCheckExcerpts(final, workingText, sectionRanges);
    // Re-run verifier on corrected excerpts to refresh source_excerpt_verified +
    // source_section_verified flags.
    final = verifyEOCSourceExcerpts(workingText, updatedResult, sectionRanges);
    // Hard cap re-check (self-check could push us over).
    if (final.total_cost_usd > COST_HARD_CAP_USD) {
      throw new Error(`eoc_cost_hard_cap_breached_post_self_check:${documentId}:cost=${final.total_cost_usd.toFixed(4)}`);
    }
  }

  return { ...final, column_wrap_decision: columnWrapDecision };
}
