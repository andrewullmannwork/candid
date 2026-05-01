/**
 * Shared parser types + conventions for Pattern P-8 citation-grade source provenance.
 *
 * Each text-based parser (bill/EOB, SBC, EOC, formulary) defines its own
 * `<X>SectionHint` string-literal-union enum. Section hint values are stored as
 * opaque strings in `field_provenance.{field}.source_section_hint` JSONB; consumers
 * format them via `formatSectionHint()` in `source-display.ts`.
 *
 * Convention: any section hint ending in `_DO_NOT_EXTRACT` indicates a boilerplate
 * region (appeal rights, glossary, footer legalese) where Haiku should NEVER pull
 * data from. The verification utility forces `verified='not_found'` and emits a
 * warning when an extracted field claims a `_DO_NOT_EXTRACT` source — this is a
 * self-reported hallucination admission.
 */

/**
 * Half-open character-offset range within a raw document text. End is exclusive.
 */
export interface SectionRange {
  start: number;
  end: number;
}

/**
 * Map of section-hint string → list of character ranges where that section appears
 * in the raw document. Multiple ranges per hint are allowed (e.g., multi-claim EOBs
 * have multiple "CLAIM DETAIL" sections).
 *
 * Generic over key string to keep the verification utility parser-agnostic. Each
 * parser's segmentation function may type its return value with a parser-specific
 * enum (e.g., `Record<EOBSectionHint, SectionRange[]>`); the utility downcasts to
 * `Record<string, SectionRange[]>` at the call site.
 */
export type SectionRanges = Record<string, SectionRange[]>;

/**
 * Suffix marker for boilerplate sections. Sections named with this suffix are
 * treated as do-not-extract zones — verifySourceExcerpts forces verified='not_found'
 * and emits a warning when a field claims them as a source.
 */
export const DO_NOT_EXTRACT_SUFFIX = "_DO_NOT_EXTRACT" as const;

/**
 * Type predicate for boilerplate section hints.
 */
export function isDoNotExtractSection(sectionHint: string | undefined): boolean {
  return sectionHint?.endsWith(DO_NOT_EXTRACT_SUFFIX) ?? false;
}

/**
 * Pattern P-8 — three-state verification result.
 *
 * - `verified`: exact substring match against raw doc text (citation-grade; consumers
 *   filter on this for evidence-grade reads).
 * - `not_found`: no match; likely Haiku hallucination. Field NOT auto-blanked; flagged
 *   for review.
 * - `ocr_unverifiable`: OCR-extracted text noisy enough that exact substring match
 *   fails. Honest signal that we can't verify excerpt without fuzzy matching (which
 *   we explicitly DO NOT do — fuzzy matching would corrupt the citation-grade
 *   contract on short excerpts).
 */
export type SourceExcerptVerified = "verified" | "not_found" | "ocr_unverifiable";

/**
 * How the raw document text was extracted. Drives the verification path:
 * - `pdftotext` / `native_pdf_text`: exact substring match expected.
 * - `ocr`: exact match still attempted; on miss → `ocr_unverifiable` (no fuzzy fallback).
 */
export type ExtractionMethod = "pdftotext" | "native_pdf_text" | "ocr";
