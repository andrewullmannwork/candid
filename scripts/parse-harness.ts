/**
 * Empirical parse harness — Phase 3 Task 3H per Q-P3-5 lock + DR-3D dogfood findings.
 *
 * Runs parseBillWithHaiku against EOB fixtures, captures cost + tokens + structural
 * completeness, writes per-attempt rows to parse_audit_runs (migration 055).
 *
 * v1 scope (Session 47):
 *   - EOB fixtures only (SBC harness deferred to Phase 3.2)
 *   - Pre-OCR'd source.txt input (PDF→OCR upstream)
 *   - Single-pass per fixture (N=3 stochastic-variance integration deferred to Task 3I)
 *   - Structural completeness check (NOT recall vs ground truth — fixture annotation deferred to Phase 3.1)
 *   - Cost telemetry from response.usage (input/output/cache_read/cache_create tokens + computed $USD)
 *   - Writes to parse_audit_runs table (per migration 055)
 *
 * Future extensions (Phase 3.1+ / Task 3I):
 *   - N=3 voting with variance metrics
 *   - Ground truth comparison via expected.json files (recall + precision)
 *   - PDF→OCR upstream integration
 *   - SBC fixtures (Phase 3.2)
 *
 * Usage:
 *   npx tsx scripts/parse-harness.ts --run-id session_47_dr3d_baseline
 *   npx tsx scripts/parse-harness.ts --run-id <id> --fixtures-dir tests/fixtures/eobs --dry-run
 *
 * See plans/findings/dr3d_dogfood_findings.md for empirical methodology.
 */

import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";
import { resolve } from "path";
import * as fs from "fs";
import { execSync } from "child_process";
import { parseBillWithHaiku } from "../src/lib/billing/haiku-bill-parser";
import type { ParsedBill } from "../src/lib/billing/types";
import { parseEOC } from "../src/lib/eoc/parser";
import type { EOCParseResult } from "../src/lib/eoc/types";
import { parseSBC } from "../src/lib/sbc/parser";
import { votedParseSBC } from "../src/lib/sbc/voted-parser";
import type { SBCHaikuParseResult } from "../src/lib/sbc/types";

config({ path: resolve(__dirname, "../.env.local"), override: true });

interface PatternP8Metrics {
  field_provenance_size_bytes: number; // JSON.stringify(fieldProvenance).length
  source_excerpt_coverage_rate: number | null; // verified='verified' / total with excerpt; null when no excerpts
  source_section_hint_match_rate: number | null; // section_verified=true / total with section_hint; null when none
  section_ranges_found: number; // total ranges from segmentEOBSections() (sanity check segmentation found boilerplate)
  do_not_extract_extractions: number; // count of fields claiming a *_DO_NOT_EXTRACT source (suppression check)
  fields_with_excerpt: number;
  fields_with_section_hint: number;
  fields_total_in_provenance: number;
}

interface HarnessRow {
  run_id: string;
  parser_version: string;
  parser_name: "eob" | "bill" | "sbc" | "card" | "eoc";
  fixture_id: string;
  fixture_kind: "annotated" | "bulk_unannotated" | "synthetic";
  fields_captured: number;
  fields_total: number;
  cost_usd: number;
  haiku_tokens_input: number;
  haiku_tokens_output: number;
  haiku_cache_read_tokens: number;
  haiku_cache_create_tokens: number;
  per_field_results: Record<string, unknown>;
  warnings: {
    meta_warnings: string[];
    accumulator_warnings: string[];
    excerpt_verification_warnings: string[]; // Pattern P-8 — section_mismatch, ocr_unverifiable, do_not_extract pulls
    pattern_p8_metrics: PatternP8Metrics;
  };
  parse_duration_ms: number;
  parse_attempt_idx: number;
  parse_status: "success" | "timed_out" | "extraction_failed" | "truncated";
}

const HIGH_LEVERAGE_FIELDS = [
  "external_claim_number",
  "eob_date",
  "service_date",
  "network_status",
  "provider.name",
  "patient.name",
  "insurer.name",
  "lineItems[*].procedureCode",
  "lineItems[*].billedAmount",
  "lineItems[*].claim_line_status",
  "lineItems[*].denied_amount",
  "lineItems[*].carc_codes",
  "lineItems[*].rarc_codes",
  "lineItems[*].ex_codes",
  "lineItems[*].member_copay",
  "lineItems[*].member_applied_to_deductible",
  "accumulators[*].deductible_applied",
  "accumulators[*].oop_applied",
  "totals.totalBilled",
  "totals.totalInsurancePaid",
];

function getNestedValue(obj: unknown, path: string): unknown {
  const parts = path.split(/\.|\[(\*|\d+)\]/).filter(Boolean);
  let cur: unknown = obj;
  for (const part of parts) {
    if (cur == null) return undefined;
    if (part === "*") {
      // Array wildcard: check if at least one element has subsequent path populated
      if (!Array.isArray(cur)) return undefined;
      return cur; // return the array; caller checks subsequent path on each element
    }
    if (Array.isArray(cur)) {
      const idx = parseInt(part, 10);
      cur = isNaN(idx) ? undefined : cur[idx];
    } else {
      cur = (cur as Record<string, unknown>)[part];
    }
  }
  return cur;
}

function fieldIsCaptured(parsed: ParsedBill, dotPath: string): boolean {
  // Handle [*] wildcard: field is "captured" if any line item / accumulator has it populated
  if (dotPath.includes("[*]")) {
    const [arrayPath, ...rest] = dotPath.split("[*].");
    const arr = getNestedValue(parsed as unknown as Record<string, unknown>, arrayPath);
    if (!Array.isArray(arr) || arr.length === 0) return false;
    const subPath = rest.join("[*].");
    return arr.some((item) => {
      const v = getNestedValue(item, subPath);
      return v != null && (Array.isArray(v) ? v.length > 0 : true);
    });
  }
  const v = getNestedValue(parsed as unknown as Record<string, unknown>, dotPath);
  return v != null && (Array.isArray(v) ? v.length > 0 : true);
}

function emptyPatternP8Metrics(): PatternP8Metrics {
  return {
    field_provenance_size_bytes: 0,
    source_excerpt_coverage_rate: null,
    source_section_hint_match_rate: null,
    section_ranges_found: 0,
    do_not_extract_extractions: 0,
    fields_with_excerpt: 0,
    fields_with_section_hint: 0,
    fields_total_in_provenance: 0,
  };
}

// Pattern P-8 watch metrics per Q-P3.1B-7 (revised v2 — 3-state verified enum).
function computePatternP8Metrics(
  parsed: ParsedBill,
  excerptVerificationWarnings: string[],
): PatternP8Metrics {
  const fp = parsed.extractionMeta?.fieldProvenance ?? {};
  const entries = Object.values(fp);

  let withExcerpt = 0;
  let excerptVerified = 0;
  let withSectionHint = 0;
  let sectionVerified = 0;
  let doNotExtractCount = 0;

  for (const meta of entries) {
    if (meta.source_excerpt) {
      withExcerpt++;
      if (meta.source_excerpt_verified === "verified") excerptVerified++;
    }
    if (meta.source_section_hint) {
      withSectionHint++;
      if (meta.source_section_verified === true) sectionVerified++;
      if (meta.source_section_hint.endsWith("_DO_NOT_EXTRACT")) doNotExtractCount++;
    }
  }

  // section_ranges_found is encoded in excerptVerificationWarnings indirectly; we
  // approximate by counting `source_section_unknown:` warnings (failures to find named
  // sections). For an absolute count we'd need to plumb the segmentation result through —
  // deferred since it's a sanity check, not a target metric.
  const sectionRangesFound = excerptVerificationWarnings.filter((w) =>
    w.startsWith("source_section_mismatch:") || w.startsWith("source_section_unknown:"),
  ).length;

  return {
    field_provenance_size_bytes: JSON.stringify(fp).length,
    source_excerpt_coverage_rate: withExcerpt > 0 ? excerptVerified / withExcerpt : null,
    source_section_hint_match_rate: withSectionHint > 0 ? sectionVerified / withSectionHint : null,
    section_ranges_found: sectionRangesFound,
    do_not_extract_extractions: doNotExtractCount,
    fields_with_excerpt: withExcerpt,
    fields_with_section_hint: withSectionHint,
    fields_total_in_provenance: entries.length,
  };
}

function computeCost(usage: {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}): number {
  const inputCost = (usage.input_tokens / 1e6) * 1.0;
  const outputCost = (usage.output_tokens / 1e6) * 5.0;
  const cacheWriteCost = ((usage.cache_creation_input_tokens ?? 0) / 1e6) * 1.25;
  const cacheReadCost = ((usage.cache_read_input_tokens ?? 0) / 1e6) * 0.10;
  return inputCost + outputCost + cacheWriteCost + cacheReadCost;
}

async function runFixture(
  fixturePath: string,
  fixtureId: string,
  runId: string,
  parserVersion: string,
  attemptIdx: number,
): Promise<HarnessRow> {
  const sourceText = fs.readFileSync(`${fixturePath}/source.txt`, "utf-8");
  const fixtureKind: HarnessRow["fixture_kind"] = fixtureId.startsWith("synthetic-") ? "synthetic" : "annotated";

  const t0 = Date.now();
  // Pre-call: capture stderr so we can read response.usage indirectly via parser logs.
  // NOTE: parseBillWithHaiku doesn't return usage; we'd need to extend the API or
  // re-architect. For v1, log-scrape from stderr is acceptable; v2 should return usage.
  // Workaround: invoke directly via dummy ids; track total cost via process-level usage if needed.
  const parsed = await parseBillWithHaiku(sourceText, `harness-${fixtureId}`, "harness-user", "eob");
  const durationMs = Date.now() - t0;

  if (!parsed) {
    return {
      run_id: runId,
      parser_version: parserVersion,
      parser_name: "eob",
      fixture_id: fixtureId,
      fixture_kind: fixtureKind,
      fields_captured: 0,
      fields_total: HIGH_LEVERAGE_FIELDS.length,
      cost_usd: 0,
      haiku_tokens_input: 0,
      haiku_tokens_output: 0,
      haiku_cache_read_tokens: 0,
      haiku_cache_create_tokens: 0,
      per_field_results: {},
      warnings: {
        meta_warnings: [],
        accumulator_warnings: [],
        excerpt_verification_warnings: [],
        pattern_p8_metrics: emptyPatternP8Metrics(),
      },
      parse_duration_ms: durationMs,
      parse_attempt_idx: attemptIdx,
      parse_status: "extraction_failed",
    };
  }

  // Compute structural completeness across high-leverage fields
  const perField: Record<string, boolean> = {};
  let captured = 0;
  for (const f of HIGH_LEVERAGE_FIELDS) {
    const isCaptured = fieldIsCaptured(parsed, f);
    perField[f] = isCaptured;
    if (isCaptured) captured++;
  }

  // Pull warnings off parsed.parseErrors. Post-process pushes 3 categories there:
  // accumulator_*, source_* (Pattern P-8 verification), and meta_* (everything else).
  const warningBuckets = parsed.parseErrors.reduce(
    (acc, w) => {
      if (w.startsWith("accumulator_")) acc.accumulator_warnings.push(w);
      else if (w.startsWith("source_")) acc.excerpt_verification_warnings.push(w);
      else acc.meta_warnings.push(w);
      return acc;
    },
    {
      meta_warnings: [] as string[],
      accumulator_warnings: [] as string[],
      excerpt_verification_warnings: [] as string[],
    },
  );

  const patternP8Metrics = computePatternP8Metrics(parsed, warningBuckets.excerpt_verification_warnings);

  const warnings = {
    ...warningBuckets,
    pattern_p8_metrics: patternP8Metrics,
  };

  // NOTE v1: cost / token tracking not directly accessible from parseBillWithHaiku return.
  // Stub values; v2 will require parser to expose usage in its return.
  return {
    run_id: runId,
    parser_version: parserVersion,
    parser_name: "eob",
    fixture_id: fixtureId,
    fixture_kind: fixtureKind,
    fields_captured: captured,
    fields_total: HIGH_LEVERAGE_FIELDS.length,
    cost_usd: 0, // TODO v2: parser must return usage
    haiku_tokens_input: 0,
    haiku_tokens_output: 0,
    haiku_cache_read_tokens: 0,
    haiku_cache_create_tokens: 0,
    per_field_results: { ...perField, line_count: parsed.lineItems.length, accumulator_count: parsed.accumulators?.length ?? 0 },
    warnings,
    parse_duration_ms: durationMs,
    parse_attempt_idx: attemptIdx,
    parse_status: "success",
  };
}

// ── Phase 3.1A — EOC fixture runner ──────────────────────────────────────────
//
// Mirrors runFixture() but invokes parseEOC() instead of parseBillWithHaiku().
// Pattern P-8 metrics computed by walking EOCParseResult sections; structural
// completeness = sections_extracted / 6 priority sections (A/B/C/D/F/K).
// Cost telemetry comes directly from EOCParseResult (parser tracks per-section costs).

const EOC_PRIORITY_SECTIONS = [
  "prior_auth_codes",
  "medical_necessity",
  "appeals_procedures",
  "cob_rules",
  "eligibility_rules",
  "definitions",
] as const;

interface EOCPatternP8Metrics {
  fields_total: number; // total Pattern P-8 fields across all sections
  fields_with_excerpt: number;
  fields_verified: number; // verified='verified'
  fields_section_verified: number; // section_verified=true (non-DO_NOT_EXTRACT)
  source_excerpt_coverage_rate: number | null;
  source_section_match_rate: number | null;
}

function computeEOCPatternP8Metrics(parsed: EOCParseResult): EOCPatternP8Metrics {
  let fieldsTotal = 0;
  let fieldsWithExcerpt = 0;
  let fieldsVerified = 0;
  let fieldsSectionVerified = 0;

  const visitOne = (
    item: { source_excerpt?: string; source_excerpt_verified?: string; source_section_verified?: boolean },
  ) => {
    fieldsTotal++;
    if (item.source_excerpt && item.source_excerpt.length > 0) {
      fieldsWithExcerpt++;
      if (item.source_excerpt_verified === "verified") fieldsVerified++;
      if (item.source_section_verified === true) fieldsSectionVerified++;
    }
  };

  if (parsed.sections.prior_auth_codes) {
    parsed.sections.prior_auth_codes.data.codes.forEach(visitOne);
  }
  if (parsed.sections.medical_necessity) {
    parsed.sections.medical_necessity.data.criteria.forEach(visitOne);
  }
  if (parsed.sections.appeals_procedures) {
    visitOne(parsed.sections.appeals_procedures.data);
  }
  if (parsed.sections.cob_rules) {
    visitOne(parsed.sections.cob_rules.data);
  }
  if (parsed.sections.eligibility_rules) {
    visitOne(parsed.sections.eligibility_rules.data);
  }
  if (parsed.sections.definitions) {
    parsed.sections.definitions.data.definitions.forEach(visitOne);
  }

  return {
    fields_total: fieldsTotal,
    fields_with_excerpt: fieldsWithExcerpt,
    fields_verified: fieldsVerified,
    fields_section_verified: fieldsSectionVerified,
    source_excerpt_coverage_rate: fieldsWithExcerpt > 0 ? fieldsVerified / fieldsWithExcerpt : null,
    source_section_match_rate: fieldsWithExcerpt > 0 ? fieldsSectionVerified / fieldsWithExcerpt : null,
  };
}

async function runEOCFixture(
  fixturePath: string,
  fixtureId: string,
  runId: string,
  parserVersion: string,
  attemptIdx: number,
): Promise<HarnessRow> {
  const sourceText = fs.readFileSync(`${fixturePath}/source.txt`, "utf-8");
  const fixtureKind: HarnessRow["fixture_kind"] = fixtureId.startsWith("synthetic-") ? "synthetic" : "annotated";

  const t0 = Date.now();
  let parsed: EOCParseResult;
  try {
    parsed = await parseEOC(sourceText, {
      documentId: `harness-${fixtureId}`,
      extractionMethod: "pdftotext",
    });
  } catch (err) {
    const durationMs = Date.now() - t0;
    return {
      run_id: runId,
      parser_version: parserVersion,
      parser_name: "eoc",
      fixture_id: fixtureId,
      fixture_kind: fixtureKind,
      fields_captured: 0,
      fields_total: EOC_PRIORITY_SECTIONS.length,
      cost_usd: 0,
      haiku_tokens_input: 0,
      haiku_tokens_output: 0,
      haiku_cache_read_tokens: 0,
      haiku_cache_create_tokens: 0,
      per_field_results: { error: err instanceof Error ? err.message : String(err) },
      warnings: {
        meta_warnings: [String(err)],
        accumulator_warnings: [],
        excerpt_verification_warnings: [],
        pattern_p8_metrics: emptyPatternP8Metrics(),
      },
      parse_duration_ms: durationMs,
      parse_attempt_idx: attemptIdx,
      parse_status: "extraction_failed",
    };
  }
  const durationMs = Date.now() - t0;

  // Structural completeness: how many of 6 priority sections were extracted.
  const sectionsCaptured = EOC_PRIORITY_SECTIONS.filter((s) => parsed.sections[s] !== undefined).length;

  // Section result row counts (drilldown for admin debug).
  const perFieldResults: Record<string, unknown> = {
    segmentation_used: parsed.segmentation_used,
    sections_extracted: Object.keys(parsed.sections),
    parse_errors: parsed.parse_errors,
    pa_codes_count: parsed.sections.prior_auth_codes?.data.codes.length ?? 0,
    medical_necessity_count: parsed.sections.medical_necessity?.data.criteria.length ?? 0,
    definitions_count: parsed.sections.definitions?.data.definitions.length ?? 0,
    appeals_present: !!parsed.sections.appeals_procedures,
    cob_present: !!parsed.sections.cob_rules,
    eligibility_present: !!parsed.sections.eligibility_rules,
  };

  // Pattern P-8 metrics (EOC analog of EOB metrics).
  const eocP8 = computeEOCPatternP8Metrics(parsed);

  // Bucket warnings (mirror EOB harness convention)
  const excerptWarnings = parsed.warnings.filter((w) => w.startsWith("source_"));
  const otherWarnings = parsed.warnings.filter((w) => !w.startsWith("source_"));

  return {
    run_id: runId,
    parser_version: parserVersion,
    parser_name: "eoc",
    fixture_id: fixtureId,
    fixture_kind: fixtureKind,
    fields_captured: sectionsCaptured,
    fields_total: EOC_PRIORITY_SECTIONS.length,
    cost_usd: parsed.total_cost_usd,
    haiku_tokens_input: parsed.total_input_tokens,
    haiku_tokens_output: parsed.total_output_tokens,
    haiku_cache_read_tokens: parsed.total_cache_read_tokens, // S187: real cache classes (cache_pad_v1 engagement evidence)
    haiku_cache_create_tokens: parsed.total_cache_create_tokens,
    per_field_results: perFieldResults,
    warnings: {
      meta_warnings: otherWarnings,
      accumulator_warnings: [], // EOC has no accumulators concept
      excerpt_verification_warnings: excerptWarnings,
      pattern_p8_metrics: {
        // Reuse the EOB shape; map EOC metrics to compatible field names.
        field_provenance_size_bytes: JSON.stringify(parsed.sections).length,
        source_excerpt_coverage_rate: eocP8.source_excerpt_coverage_rate,
        source_section_hint_match_rate: eocP8.source_section_match_rate,
        section_ranges_found: Object.keys(parsed.sections).length,
        do_not_extract_extractions: parsed.warnings.filter((w) => w.includes("do_not_extract")).length,
        fields_with_excerpt: eocP8.fields_with_excerpt,
        fields_with_section_hint: eocP8.fields_with_excerpt, // same denominator for EOC
        fields_total_in_provenance: eocP8.fields_total,
      },
    },
    parse_duration_ms: durationMs,
    parse_attempt_idx: attemptIdx,
    parse_status: parsed.parse_errors.length === 0 ? "success" : "extraction_failed",
  };
}

// ── Phase 3.2 — SBC fixture runner ──────────────────────────────────────────
//
// Mirrors runFixture() but invokes parseSBC() / votedParseSBC() instead of
// parseBillWithHaiku(). Pattern P-8 metrics computed by walking SBCHaikuParseResult
// (planIdentity scalars + services + otherCoveredServices + appealsContacts +
// excludedServices); structural completeness = sections_extracted / 5 priority
// sections (Important Questions / Common Medical Events / Other Covered /
// Excluded / Appeals).

const SBC_PRIORITY_SECTIONS = [
  "important_questions",
  "common_medical_events",
  "other_covered_services",
  "excluded_services",
  "appeals_grievances",
] as const;

interface SBCPatternP8Metrics {
  fields_total: number;
  fields_with_excerpt: number;
  fields_verified: number;
  fields_section_verified: number;
  source_excerpt_coverage_rate: number | null;
  source_section_match_rate: number | null;
}

function computeSBCPatternP8Metrics(parsed: SBCHaikuParseResult): SBCPatternP8Metrics {
  let fieldsTotal = 0;
  let fieldsWithExcerpt = 0;
  let fieldsVerified = 0;
  let fieldsSectionVerified = 0;

  const visitOne = (p8: {
    source_excerpt?: string;
    source_excerpt_verified?: string;
    source_section_verified?: boolean;
  } | null | undefined) => {
    if (!p8) return;
    fieldsTotal++;
    if (p8.source_excerpt && p8.source_excerpt.length > 0) {
      fieldsWithExcerpt++;
      if (p8.source_excerpt_verified === "verified") fieldsVerified++;
      if (p8.source_section_verified === true) fieldsSectionVerified++;
    }
  };

  // Plan identity scalars (15 fields)
  const planIdentity = parsed.planIdentity;
  for (const key of Object.keys(planIdentity) as Array<keyof typeof planIdentity>) {
    visitOne(planIdentity[key].patternP8);
  }
  // Services + otherCoveredServices
  parsed.services.forEach((svc) => visitOne(svc.patternP8));
  parsed.otherCoveredServices.forEach((svc) => visitOne(svc.patternP8));
  // Excluded services list (single P-8)
  visitOne(parsed.excludedServicesPatternP8);
  // Appeals contacts
  parsed.appealsContacts.forEach((contact) => visitOne(contact.patternP8));

  return {
    fields_total: fieldsTotal,
    fields_with_excerpt: fieldsWithExcerpt,
    fields_verified: fieldsVerified,
    fields_section_verified: fieldsSectionVerified,
    source_excerpt_coverage_rate: fieldsWithExcerpt > 0 ? fieldsVerified / fieldsWithExcerpt : null,
    source_section_match_rate: fieldsWithExcerpt > 0 ? fieldsSectionVerified / fieldsWithExcerpt : null,
  };
}

async function runSBCFixture(
  fixturePath: string,
  fixtureId: string,
  runId: string,
  parserVersion: string,
  attemptIdx: number,
  withVoting: boolean,
): Promise<HarnessRow> {
  const sourceText = fs.readFileSync(`${fixturePath}/source.txt`, "utf-8");
  const fixtureKind: HarnessRow["fixture_kind"] = fixtureId.startsWith("synthetic-") ? "synthetic" : "annotated";

  const t0 = Date.now();
  let parsed: SBCHaikuParseResult;
  try {
    parsed = withVoting
      ? await votedParseSBC({ ocrText: sourceText, extractionMethod: "pdftotext", canonicalMatchExists: false })
      : await parseSBC({ ocrText: sourceText, extractionMethod: "pdftotext" });
  } catch (err) {
    const durationMs = Date.now() - t0;
    return {
      run_id: runId,
      parser_version: parserVersion,
      parser_name: "sbc",
      fixture_id: fixtureId,
      fixture_kind: fixtureKind,
      fields_captured: 0,
      fields_total: SBC_PRIORITY_SECTIONS.length,
      cost_usd: 0,
      haiku_tokens_input: 0,
      haiku_tokens_output: 0,
      haiku_cache_read_tokens: 0,
      haiku_cache_create_tokens: 0,
      per_field_results: { error: err instanceof Error ? err.message : String(err) },
      warnings: {
        meta_warnings: [String(err)],
        accumulator_warnings: [],
        excerpt_verification_warnings: [],
        pattern_p8_metrics: emptyPatternP8Metrics(),
      },
      parse_duration_ms: durationMs,
      parse_attempt_idx: attemptIdx,
      parse_status: "extraction_failed",
    };
  }
  const durationMs = Date.now() - t0;

  // Structural completeness: how many of 5 priority sections produced output (any field non-null)
  let sectionsCaptured = 0;
  if (parsed.planIdentity.planName.value !== null || parsed.planIdentity.deductibleIndividual.value !== null) {
    sectionsCaptured++; // important_questions
  }
  if (parsed.services.length > 0) sectionsCaptured++;
  if (parsed.otherCoveredServices.length > 0) sectionsCaptured++;
  if (parsed.excludedServices.length > 0) sectionsCaptured++;
  if (parsed.appealsContacts.length > 0) sectionsCaptured++;

  // Section result row counts (drilldown for admin debug)
  const perFieldResults: Record<string, unknown> = {
    plan_name: parsed.planIdentity.planName.value,
    insurer_name: parsed.planIdentity.insurerName.value,
    plan_type: parsed.planIdentity.planType.value,
    metal_tier: parsed.planIdentity.metalTier.value,
    plan_year: parsed.planIdentity.planYear.value,
    deductible_in_individual: parsed.planIdentity.deductibleIndividual.value,
    oop_max_in_individual: parsed.planIdentity.oopMaxIndividual.value,
    services_count: parsed.services.length,
    other_covered_count: parsed.otherCoveredServices.length,
    excluded_count: parsed.excludedServices.length,
    appeals_contacts_count: parsed.appealsContacts.length,
    parse_strategy_v2: parsed.parseStrategyV2,
  };

  // Pattern P-8 metrics
  const sbcP8 = computeSBCPatternP8Metrics(parsed);

  // Bucket warnings
  const excerptWarnings = parsed.parseWarnings.filter((w) => w.startsWith("source_"));
  const otherWarnings = parsed.parseWarnings.filter((w) => !w.startsWith("source_"));

  return {
    run_id: runId,
    parser_version: parserVersion,
    parser_name: "sbc",
    fixture_id: fixtureId,
    fixture_kind: fixtureKind,
    fields_captured: sectionsCaptured,
    fields_total: SBC_PRIORITY_SECTIONS.length,
    cost_usd: parsed.costUsd,
    haiku_tokens_input: parsed.haikuTokensInput,
    haiku_tokens_output: parsed.haikuTokensOutput,
    haiku_cache_read_tokens: parsed.haikuCacheReadTokens,
    haiku_cache_create_tokens: parsed.haikuCacheCreateTokens,
    per_field_results: perFieldResults,
    warnings: {
      meta_warnings: otherWarnings,
      accumulator_warnings: [],
      excerpt_verification_warnings: excerptWarnings,
      pattern_p8_metrics: {
        field_provenance_size_bytes: JSON.stringify({
          planIdentity: parsed.planIdentity,
          services: parsed.services,
          otherCoveredServices: parsed.otherCoveredServices,
          appealsContacts: parsed.appealsContacts,
        }).length,
        source_excerpt_coverage_rate: sbcP8.source_excerpt_coverage_rate,
        source_section_hint_match_rate: sbcP8.source_section_match_rate,
        section_ranges_found: sectionsCaptured,
        do_not_extract_extractions: parsed.parseWarnings.filter((w) => w.includes("do_not_extract")).length,
        fields_with_excerpt: sbcP8.fields_with_excerpt,
        fields_with_section_hint: sbcP8.fields_with_excerpt,
        fields_total_in_provenance: sbcP8.fields_total,
      },
    },
    parse_duration_ms: durationMs,
    parse_attempt_idx: attemptIdx,
    parse_status: parsed.services.length === 0 && parsed.otherCoveredServices.length === 0 ? "extraction_failed" : "success",
  };
}

async function main() {
  const args = process.argv.slice(2);
  function getArg(flag: string, defaultVal: string): string {
    const idx = args.indexOf(flag);
    return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : defaultVal;
  }
  const runId = getArg("--run-id", `harness_${Date.now()}`);
  const parser = getArg("--parser", "eob") as "eob" | "eoc" | "sbc";
  const defaultFixturesDir =
    parser === "eoc" ? "tests/fixtures/eocs" : parser === "sbc" ? "tests/fixtures/sbcs" : "tests/fixtures/eobs";
  const fixturesDir = getArg("--fixtures-dir", defaultFixturesDir);
  const dryRun = args.includes("--dry-run");
  const withVoting = args.includes("--voting"); // Phase 3.2: --voting enables DR-3C N=3 cold-start path

  const parserVersion = (() => {
    try {
      return execSync("git rev-parse HEAD", { cwd: resolve(__dirname, "..") }).toString().trim();
    } catch {
      return "unknown";
    }
  })();

  console.log(`[harness] run_id=${runId} parser_version=${parserVersion.substring(0, 7)} dry_run=${dryRun}`);
  console.log(`[harness] fixtures_dir=${fixturesDir}`);

  const fixturesPath = resolve(__dirname, "..", fixturesDir);
  const fixtureIds = fs.readdirSync(fixturesPath).filter((f) => fs.statSync(`${fixturesPath}/${f}`).isDirectory());
  console.log(`[harness] discovered ${fixtureIds.length} fixtures: ${fixtureIds.join(", ")}`);

  const rows: HarnessRow[] = [];
  for (const fixtureId of fixtureIds) {
    const fixturePath = `${fixturesPath}/${fixtureId}`;
    if (!fs.existsSync(`${fixturePath}/source.txt`)) {
      console.warn(`[harness] skipping ${fixtureId}: no source.txt`);
      continue;
    }
    console.log(`\n[harness] running fixture ${fixtureId}...`);
    const row =
      parser === "eoc"
        ? await runEOCFixture(fixturePath, fixtureId, runId, parserVersion, 1)
        : parser === "sbc"
          ? await runSBCFixture(fixturePath, fixtureId, runId, parserVersion, 1, withVoting)
          : await runFixture(fixturePath, fixtureId, runId, parserVersion, 1);
    rows.push(row);
    const p8 = row.warnings.pattern_p8_metrics;
    const excerptRate = p8.source_excerpt_coverage_rate;
    const sectionRate = p8.source_section_hint_match_rate;
    console.log(
      `  status=${row.parse_status} captured=${row.fields_captured}/${row.fields_total} (${((row.fields_captured / row.fields_total) * 100).toFixed(0)}%) duration=${row.parse_duration_ms}ms warnings=${row.warnings.meta_warnings.length + row.warnings.accumulator_warnings.length + row.warnings.excerpt_verification_warnings.length}`,
    );
    console.log(
      `  P-8: provenance=${p8.field_provenance_size_bytes}B excerpt_coverage=${excerptRate !== null ? (excerptRate * 100).toFixed(0) + "%" : "n/a"} section_match=${sectionRate !== null ? (sectionRate * 100).toFixed(0) + "%" : "n/a"} fields_with_excerpt=${p8.fields_with_excerpt}/${p8.fields_total_in_provenance} do_not_extract=${p8.do_not_extract_extractions}`,
    );
  }

  console.log("\n=== SUMMARY ===");
  for (const row of rows) {
    console.log(`${row.fixture_id}: ${row.fields_captured}/${row.fields_total} fields (${((row.fields_captured / row.fields_total) * 100).toFixed(0)}%) — ${row.parse_status}`);
  }

  if (dryRun) {
    console.log("\n[harness] --dry-run: skipping DB writes");
    return;
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) {
    console.error("[harness] Missing Supabase credentials; results not persisted");
    return;
  }
  const supabase = createClient(supabaseUrl, supabaseKey);
  const { error } = await supabase.from("parse_audit_runs").insert(
    rows.map((r) => ({
      run_id: r.run_id,
      parser_version: r.parser_version,
      parser_name: r.parser_name,
      fixture_id: r.fixture_id,
      fixture_kind: r.fixture_kind,
      fields_captured: r.fields_captured,
      fields_total: r.fields_total,
      cost_usd: r.cost_usd,
      haiku_tokens_input: r.haiku_tokens_input,
      haiku_tokens_output: r.haiku_tokens_output,
      haiku_cache_read_tokens: r.haiku_cache_read_tokens,
      haiku_cache_create_tokens: r.haiku_cache_create_tokens,
      per_field_results: r.per_field_results,
      warnings: r.warnings,
      parse_duration_ms: r.parse_duration_ms,
      parse_attempt_idx: r.parse_attempt_idx,
      parse_status: r.parse_status,
    }))
  );
  if (error) {
    console.error("[harness] DB write failed:", error);
  } else {
    console.log(`[harness] wrote ${rows.length} rows to parse_audit_runs (run_id=${runId})`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
