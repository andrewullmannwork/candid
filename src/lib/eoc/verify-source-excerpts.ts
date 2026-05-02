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
import type { EOCParseResult, EOCSectionResult } from "./types";

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

  return { ...result, sections, warnings };
}
