/**
 * EOC-specific Pattern P-8 verifier orchestrator.
 *
 * Walks the EOCParseResult tree (prior_auth_codes, medical_necessity, appeals_procedures,
 * cob_rules, eligibility_rules, definitions) and verifies each Pattern P-8 provenance
 * entry via shared `verifyOne()` helper.
 *
 * Generic verification logic (normalizeWhitespace, findContainingSection, verifyOne)
 * extracted to `src/lib/parser/verify-source-excerpts.ts` at Phase 3.2 Task A so SBC +
 * future formulary parsers can share the same insurer-/format-agnostic helpers without
 * drift risk.
 */

import type { SectionRanges } from "../parser/types";
import { verifyOne } from "../parser/verify-source-excerpts";
import type { VerifyContext } from "../parser/verify-source-excerpts";
import type { EOCParseResult, EOCSectionHint, EOCSectionResult, PatternP8Provenance } from "./types";

// Non-DO_NOT_EXTRACT EOC sections that get Haiku-dispatched. Per Q-P4.0.5-2 LOCK:
// `verbatim_absent` derives only when dispatched_sections covers ALL of these.
const NON_DO_NOT_EXTRACT_EOC_SECTIONS: EOCSectionHint[] = [
  "prior_auth_codes",
  "medical_necessity",
  "appeals_procedures",
  "cob_rules",
  "eligibility_rules",
  "definitions",
];

function coversAllNonDoNotExtractEOC(dispatched: EOCSectionHint[] | undefined): boolean {
  if (!dispatched || dispatched.length === 0) return false;
  const set = new Set(dispatched);
  return NON_DO_NOT_EXTRACT_EOC_SECTIONS.every((s) => set.has(s));
}

function deriveVerbatimAbsentEOC(
  patternP8: PatternP8Provenance,
  dispatched: EOCSectionHint[] | undefined,
): void {
  if (
    patternP8.source_excerpt_verified === "not_found" &&
    coversAllNonDoNotExtractEOC(dispatched)
  ) {
    patternP8.source_excerpt_verified = "verbatim_absent";
  }
}

/**
 * Walk the EOCParseResult tree and verify all Pattern P-8 entries.
 *
 * Returns a NEW result object with verified fields + accumulated warnings.
 * Mutates section result data in-place (deep copy first to avoid mutating input).
 */
export function verifyEOCSourceExcerpts(
  rawDocText: string,
  result: EOCParseResult,
  sectionRanges: SectionRanges,
): EOCParseResult {
  const ctx: VerifyContext = { normalizedRawDocText: null };
  const warnings: string[] = [...result.warnings];

  // Deep copy section results to avoid mutating caller input.
  const sections = { ...result.sections };

  // Section A: prior_auth_codes — array of codes
  if (sections.prior_auth_codes) {
    const sec: EOCSectionResult<typeof sections.prior_auth_codes.data> = JSON.parse(
      JSON.stringify(sections.prior_auth_codes),
    );
    sec.data.codes.forEach((code, i) => {
      const w = verifyOne(code, rawDocText, sectionRanges, `prior_auth_codes[${i}]`, ctx);
      warnings.push(...w);
    });
    sections.prior_auth_codes = sec;
  }

  // Section B: medical_necessity — array of criteria
  if (sections.medical_necessity) {
    const sec: EOCSectionResult<typeof sections.medical_necessity.data> = JSON.parse(
      JSON.stringify(sections.medical_necessity),
    );
    sec.data.criteria.forEach((c, i) => {
      const w = verifyOne(c, rawDocText, sectionRanges, `medical_necessity[${i}]`, ctx);
      warnings.push(...w);
    });
    sections.medical_necessity = sec;
  }

  // Section C: appeals_procedures — single block
  if (sections.appeals_procedures) {
    const sec: EOCSectionResult<typeof sections.appeals_procedures.data> = JSON.parse(
      JSON.stringify(sections.appeals_procedures),
    );
    const w = verifyOne(sec.data, rawDocText, sectionRanges, "appeals_procedures", ctx);
    warnings.push(...w);
    sections.appeals_procedures = sec;
  }

  // Section D: cob_rules — single block
  if (sections.cob_rules) {
    const sec: EOCSectionResult<typeof sections.cob_rules.data> = JSON.parse(JSON.stringify(sections.cob_rules));
    const w = verifyOne(sec.data, rawDocText, sectionRanges, "cob_rules", ctx);
    warnings.push(...w);
    sections.cob_rules = sec;
  }

  // Section F: eligibility_rules — single block
  if (sections.eligibility_rules) {
    const sec: EOCSectionResult<typeof sections.eligibility_rules.data> = JSON.parse(
      JSON.stringify(sections.eligibility_rules),
    );
    const w = verifyOne(sec.data, rawDocText, sectionRanges, "eligibility_rules", ctx);
    warnings.push(...w);
    sections.eligibility_rules = sec;
  }

  // Section K: definitions — array of definitions
  if (sections.definitions) {
    const sec: EOCSectionResult<typeof sections.definitions.data> = JSON.parse(JSON.stringify(sections.definitions));
    sec.data.definitions.forEach((d, i) => {
      const w = verifyOne(d, rawDocText, sectionRanges, `definitions[${i}]`, ctx);
      warnings.push(...w);
    });
    sections.definitions = sec;
  }

  // Phase 4.0.5: post-pass derives `verbatim_absent` for fields where verifier
  // emitted `not_found` AND parser dispatched all non-DO_NOT_EXTRACT EOC sections.
  // Per Q-P4.0.5-2 LOCK = (A) ALL non-DO_NOT_EXTRACT.
  const dispatched = result.dispatched_sections;
  if (sections.prior_auth_codes) {
    sections.prior_auth_codes.data.codes.forEach((c) => deriveVerbatimAbsentEOC(c, dispatched));
  }
  if (sections.medical_necessity) {
    sections.medical_necessity.data.criteria.forEach((c) => deriveVerbatimAbsentEOC(c, dispatched));
  }
  if (sections.appeals_procedures) {
    deriveVerbatimAbsentEOC(sections.appeals_procedures.data, dispatched);
  }
  if (sections.cob_rules) {
    deriveVerbatimAbsentEOC(sections.cob_rules.data, dispatched);
  }
  if (sections.eligibility_rules) {
    deriveVerbatimAbsentEOC(sections.eligibility_rules.data, dispatched);
  }
  if (sections.definitions) {
    sections.definitions.data.definitions.forEach((d) => deriveVerbatimAbsentEOC(d, dispatched));
  }

  return { ...result, sections, warnings };
}
