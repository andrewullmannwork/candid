/**
 * Pattern P-8 verifier — EOC analog of eob-postprocess.ts:verifySourceExcerpts().
 *
 * Inheritance from Phase 3.1B + Phase 3.1B.1:
 *   - Two-pass match: byte-exact → whitespace-normalized fallback
 *   - 3-state verified enum (no fuzzy matching per Q-P3.1B-6 v2)
 *   - DO_NOT_EXTRACT relaxation per Q-P3.1B.1-1 LOCK (recall-maximize at verifier;
 *     citation-grade strictness at consumer-read layer)
 *   - Tier 2 semantic refactor: section_verified means "excerpt lives in some real
 *     section" (not "excerpt lives in Haiku's claimed section")
 *
 * Different from EOB verifier: EOC fields live inside per-section result data
 * (not a flat fieldProvenance map). Walks the EOCParseResult tree and updates
 * each item's source_excerpt_verified + source_section_verified in place.
 */

import type { SectionRanges } from "../parser/types";
import { isDoNotExtractSection } from "../parser/types";
import type { EOCParseResult, EOCSectionResult, PatternP8Provenance } from "./types";

/**
 * Normalize text for insurer-agnostic + format-agnostic substring matching.
 * Mirrors eob-postprocess.ts:normalizeWhitespace() but adds Unicode punctuation
 * normalization (smart quotes, dashes) per Phase 3.1A.1 empirical finding —
 * pdftotext-extracted text contains curly quotes (U+2018/U+2019/U+201C/U+201D)
 * and en/em-dashes that Haiku frequently emits as ASCII equivalents (U+0027/U+0022/U+002D).
 *
 *   - Strips zero-width chars (ZWSP/ZWNJ/ZWJ/BOM)
 *   - Folds curly single quotes → straight apostrophe (')
 *   - Folds curly double quotes → straight double quote (")
 *   - Folds em-dash, en-dash, figure-dash, minus-sign → hyphen-minus (-)
 *   - Collapses any whitespace run → single space
 *
 * Universal across insurers + document formats. Citation-grade strictness still
 * preserved at consumer-read layer (Pattern P-8 hard rule unchanged).
 */
function normalizeWhitespace(text: string): string {
  return text
    .replace(/[​-‍﻿]/g, "")
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[‐‑‒–—―−]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Find which segmented section actually contains the excerpt. Mirrors Phase 3.1B.1
 * findContainingSection() — prefers non-DO_NOT_EXTRACT sections when overlap.
 */
function findContainingSection(
  excerpt: string,
  rawDocText: string,
  sectionRanges: SectionRanges,
  getNormalizedExcerpt: () => string,
): string | null {
  let doNotExtractMatch: string | null = null;
  for (const [hint, ranges] of Object.entries(sectionRanges)) {
    if (!ranges?.length) continue;
    const found = ranges.some(({ start, end }) => {
      const sect = rawDocText.slice(start, end);
      if (sect.includes(excerpt)) return true;
      const ne = getNormalizedExcerpt();
      return ne.length > 0 && normalizeWhitespace(sect).includes(ne);
    });
    if (found) {
      if (!hint.endsWith("_DO_NOT_EXTRACT")) {
        return hint;
      }
      doNotExtractMatch = hint;
    }
  }
  return doNotExtractMatch;
}

/**
 * Verify a single Pattern P-8 provenance entry. Mutates `meta` in place + returns warnings.
 *
 * Lazy-cached normalized doc text passed by caller (so cost is amortized across all
 * fields in an EOCParseResult — only computed on first Pass-2 fallback).
 */
function verifyOne(
  meta: PatternP8Provenance,
  rawDocText: string,
  sectionRanges: SectionRanges,
  fieldPath: string,
  ctx: { normalizedRawDocText: string | null },
): string[] {
  const warnings: string[] = [];
  if (!meta.source_excerpt) {
    return warnings;
  }

  const excerpt = meta.source_excerpt;
  let normalizedExcerpt: string | null = null;

  // Tier 1: two-pass match against full raw doc.
  let matched = rawDocText.includes(excerpt);
  if (!matched) {
    if (ctx.normalizedRawDocText === null) ctx.normalizedRawDocText = normalizeWhitespace(rawDocText);
    normalizedExcerpt = normalizeWhitespace(excerpt);
    if (normalizedExcerpt.length > 0 && ctx.normalizedRawDocText.includes(normalizedExcerpt)) {
      matched = true;
      warnings.push(`source_excerpt_verified_via_normalization:${fieldPath}`);
    }
  }

  if (matched) {
    meta.source_excerpt_verified = "verified";
  } else if (meta.source_excerpt_extraction_method === "ocr") {
    meta.source_excerpt_verified = "ocr_unverifiable";
    warnings.push(`source_excerpt_ocr_unverifiable:${fieldPath}`);
  } else {
    meta.source_excerpt_verified = "not_found";
    warnings.push(`source_excerpt_not_found:${fieldPath}`);
  }

  // Tier 2: section attribution — recall-maximize semantics per Phase 3.1B.1.
  const actualSection = findContainingSection(excerpt, rawDocText, sectionRanges, () => {
    if (normalizedExcerpt === null) normalizedExcerpt = normalizeWhitespace(excerpt);
    return normalizedExcerpt;
  });

  meta.source_section_verified = actualSection !== null && !actualSection.endsWith("_DO_NOT_EXTRACT");

  if (actualSection !== meta.source_section_hint && meta.source_excerpt_verified === "verified") {
    warnings.push(
      `source_section_mismatch:${fieldPath}:${meta.source_section_hint}` +
        (actualSection ? `:actual=${actualSection}` : `:not_in_any_segmented_section`),
    );
  }

  if (isDoNotExtractSection(meta.source_section_hint)) {
    warnings.push(`source_section_do_not_extract:${fieldPath}:${meta.source_section_hint}`);
  }

  return warnings;
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
  const ctx: { normalizedRawDocText: string | null } = { normalizedRawDocText: null };
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
