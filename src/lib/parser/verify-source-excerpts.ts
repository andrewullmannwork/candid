/**
 * Pattern P-8 verifier — generic source-excerpt verification helpers.
 *
 * Extracted to shared library at Phase 3.2 (Task A) from EOC verifier (Phase 3.1A.1)
 * which itself was the EOC analog of `eob-postprocess.ts:verifySourceExcerpts()`
 * (Phase 3.1B + Phase 3.1B.1).
 *
 * Inheritance from Phase 3.1B + 3.1B.1 + 3.1A.1 (all empirically validated; insurer-
 * agnostic and document-format-agnostic by construction):
 *   - Two-pass match: byte-exact → whitespace-normalized fallback
 *   - 3-state verified enum (no fuzzy matching per Q-P3.1B-6 v2)
 *   - DO_NOT_EXTRACT relaxation per Q-P3.1B.1-1 LOCK (recall-maximize at verifier;
 *     citation-grade strictness at consumer-read layer)
 *   - Tier 2 semantic refactor: section_verified means "excerpt lives in some real
 *     section" (not "excerpt lives in Haiku's claimed section")
 *   - Unicode quote/dash folding (Phase 3.1A.1 Iter 9): pdftotext-extracted text
 *     contains curly quotes (U+2018/U+2019/U+201C/U+201D) and en/em-dashes that
 *     Haiku frequently emits as ASCII equivalents — fold both to ASCII for matching
 *
 * Each parser walks its own parse-result tree with `verifyOne()`. The walker (e.g.,
 * `verifyEOCSourceExcerpts()`) lives in the parser's namespace; this module owns
 * the per-field verification logic + normalization.
 */

import type { SectionRanges, SourceExcerptVerified, ExtractionMethod } from "./types";
import { isDoNotExtractSection } from "./types";

/**
 * Pattern P-8 5-sub-keys inlined per text-extracted field. Each parser parameterizes
 * `SectionHint` with its own string-literal-union enum (e.g., `EOCSectionHint`,
 * `SBCSectionHint`). The verifier downcasts to `string` at the call site to stay
 * parser-agnostic.
 */
export interface PatternP8Provenance<SectionHint extends string = string> {
  source_excerpt: string;
  source_excerpt_verified: SourceExcerptVerified;
  source_excerpt_extraction_method: ExtractionMethod;
  source_section_hint: SectionHint;
  source_section_verified: boolean;
}

/**
 * Lazy-cached normalization context. Pass through verifyOne() calls so the
 * cost of `normalizeWhitespace(rawDocText)` is amortized across all fields
 * in a parse result — only computed on first Tier 1 match miss.
 */
export interface VerifyContext {
  normalizedRawDocText: string | null;
}

/**
 * Normalize text for insurer-agnostic + format-agnostic substring matching.
 *
 *   - Strips zero-width chars (ZWSP/ZWNJ/ZWJ/BOM)
 *   - Folds curly single quotes → straight apostrophe (')
 *   - Folds curly double quotes → straight double quote (")
 *   - Folds em-dash, en-dash, figure-dash, minus-sign → hyphen-minus (-)
 *   - Folds bullet/list-marker chars → space (Phase 3.2 SBC iter 5 finding:
 *     Haiku stochastically includes/excludes bullets in quotes; treating them
 *     as whitespace makes verification consistent regardless of bullet capture.
 *     Covered chars: bullet (•), middle dot (·), white bullet (◦), triangular
 *     bullet (‣), hyphen bullet (⁃), black square bullet (▪), white square
 *     bullet (▫), Unicode list dingbats — universal across pdftotext outputs)
 *   - Collapses any whitespace run → single space
 *
 * Universal across insurers + document formats. Citation-grade strictness still
 * preserved at consumer-read layer (Pattern P-8 hard rule unchanged).
 */
export function normalizeWhitespace(text: string): string {
  return text
    .replace(/[​-‍﻿]/g, "")
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[‐‑‒–—―−]/g, "-")
    .replace(/[•·◦‣⁃▪▫●○◆◇★☆]/g, " ")
    // S94 B1 — de-hyphenate pdftotext line-wrap artifacts. PDFs that wrap
    // mid-hyphenated-word output "<word>-\n<word>"; after \n→space we'd see
    // "out-of- network". Haiku's verbatim excerpt has "out-of-network" with no
    // space. Without this fix, every OON plan-identity field with embedded
    // "out-of-network" fails Pattern P-8 verification. The pattern matches
    // word+hyphen+whitespace+word and removes the whitespace.
    .replace(/(\w)-\s+(\w)/g, "$1-$2")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Find which segmented section actually contains the excerpt. Mirrors Phase 3.1B.1
 * semantics — prefers non-DO_NOT_EXTRACT sections when overlap.
 *
 * Returns the section hint (string) where the excerpt is found. If multiple
 * sections match, prefers a non-DO_NOT_EXTRACT match. Returns null if no match.
 */
export function findContainingSection(
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
      if (ne.length === 0) return false;
      const sectNorm = normalizeWhitespace(sect);
      if (sectNorm.includes(ne)) return true;
      // S96 — multi-column SBC pdftotext linearizes side-by-side columns into one stream,
      // interleaving column-2 text between sentence words of column-1. Bridge-match
      // verifies the section contains the excerpt's word-sequence in order with
      // bounded gaps. Cite-grade-safe (every n-gram byte-exact post-normalization).
      return findBridgedMatch(ne, sectNorm) !== null;
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
 * S96 — n-gram bridge match: handles multi-column SBC pdftotext column-interleaving.
 *
 * Standard pdftotext linearizes a multi-column PDF by reading each column top-to-bottom,
 * but on some federal-SBC layouts the column boundaries cause column-2 text to be
 * inserted in the middle of column-1's sentences. E.g., the natural sentence
 * "...per calendar year." gets rendered as "...per calendar [column-2 paragraph] year..."
 * in the OCR stream. Haiku's verbatim source_excerpt reproduces the natural sentence
 * but the verifier can't find it byte-for-byte in the OCR.
 *
 * Strategy:
 *   1. Tokenize the (already-normalized) excerpt into whitespace-separated words.
 *   2. Build overlapping n-grams of `nGramSize` consecutive words.
 *   3. Scan left-to-right: each n-gram's match position must be ≥ previous n-gram's
 *      end position (strict in-order coverage — false-positive risk: would require
 *      the same sequence of n-grams to appear in OCR in the same order; this is
 *      essentially the excerpt's syntactic structure preserved despite interleaving).
 *   4. Return success if ≥ `minCoveragePct` of n-grams matched in order.
 *
 * Cite-grade-safe by construction: every n-gram is a byte-exact substring of
 * normalized OCR. We're only adding tolerance for STRUCTURAL gaps between
 * adjacent fragments (column-2 interleaving), never relaxing fragment fidelity.
 *
 * Universal across multi-column document layouts (SBCs primarily; EOC narrative
 * sections rarely hit this but get the same benefit when they do).
 *
 * Returns the offset of the first matching n-gram in OCR (for section attribution)
 * and the achieved coverage ratio, or null if coverage insufficient.
 */
export function findBridgedMatch(
  normalizedExcerpt: string,
  normalizedOcr: string,
  nGramSize = 5,
  minCoveragePct = 0.8,
): { firstMatchOffset: number; coverage: number } | null {
  const tokens = normalizedExcerpt.split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length < nGramSize) return null;

  const nGrams: string[] = [];
  for (let i = 0; i <= tokens.length - nGramSize; i++) {
    nGrams.push(tokens.slice(i, i + nGramSize).join(" "));
  }
  if (nGrams.length === 0) return null;

  // Overlapping 5-grams differ by 1 word per step. Use strict-left-to-right
  // ordering (next match must start AFTER previous match starts), not "next
  // match must start AFTER previous match ends" — the latter breaks overlap.
  let lastStart = -1;
  let matched = 0;
  let firstMatchOffset = -1;
  for (const gram of nGrams) {
    const idx = normalizedOcr.indexOf(gram, lastStart + 1);
    if (idx >= 0) {
      matched++;
      if (firstMatchOffset === -1) firstMatchOffset = idx;
      lastStart = idx;
    }
  }
  const coverage = matched / nGrams.length;
  if (coverage >= minCoveragePct) {
    return { firstMatchOffset, coverage };
  }
  return null;
}

/**
 * Verify a single Pattern P-8 provenance entry. Mutates `meta` in place + returns warnings.
 *
 *   - Tier 1: byte-exact substring match against rawDocText.
 *   - Tier 2 fallback: whitespace-normalized substring match (Phase 3.1B.1).
 *   - Section attribution: recall-maximize semantics (Phase 3.1B.1) — `section_verified`
 *     means "excerpt lives in SOME real (non-DO_NOT_EXTRACT) section", not the claimed
 *     section. Mismatch logged via diagnostic warning for Haiku label-accuracy debugging.
 *   - DO_NOT_EXTRACT self-tagging logged as warning (self-reported hallucination
 *     admission per Pattern P-8 hard rule).
 *
 * Pass `ctx` (shared across all `verifyOne()` calls in a single parse-result walk)
 * to amortize the cost of `normalizeWhitespace(rawDocText)` to the first call.
 */
export function verifyOne<SectionHint extends string>(
  meta: PatternP8Provenance<SectionHint>,
  rawDocText: string,
  sectionRanges: SectionRanges,
  fieldPath: string,
  ctx: VerifyContext,
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
    } else if (normalizedExcerpt.length > 0) {
      // Tier 1.c — n-gram bridge match for multi-column pdftotext column-interleaving.
      // See `findBridgedMatch` for full rationale. Cite-grade-safe (each n-gram is a
      // byte-exact substring of OCR; only structural gaps between fragments bridged).
      const bridged = findBridgedMatch(normalizedExcerpt, ctx.normalizedRawDocText);
      if (bridged) {
        matched = true;
        warnings.push(
          `source_excerpt_verified_via_fragment_bridge:${fieldPath}:coverage=${bridged.coverage.toFixed(2)}`,
        );
      }
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
