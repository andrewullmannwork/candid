/**
 * Thin Pattern P-8 verifier wrapper for the harness.
 *
 * Reuses normalizeWhitespace + findBridgedMatch from live PROD code so the harness
 * exercises the same verification logic that ships in production. No section-attribution
 * (sectionRanges) needed — the harness's primary check is "is the excerpt verifiable
 * anywhere in the OCR?" Section attribution is a PROD-pipeline concern.
 */

import { normalizeWhitespace, findBridgedMatch } from '../../../src/lib/parser/verify-source-excerpts';

export type VerifyMethod = 'exact' | 'normalized' | 'bridge' | 'not_found' | 'no_excerpt';

export interface VerifyResult {
  verified: boolean;
  method: VerifyMethod;
}

/**
 * Augment PROD `normalizeWhitespace` with U+00AD SOFT HYPHEN folding.
 *
 * Finding (S2 harness drill 2026-05-28): Haiku 4.5 tool-use emits "out-of­network"
 * with U+00AD SOFT HYPHEN between "of" and "network" (likely OCR or schema-prompt
 * artifact). PROD `normalizeWhitespace` folds U+2010-U+2015 + U+2212 but NOT U+00AD.
 * 8 Ambetter tool-use fields had correct values agreeing with Opus but failed P-8
 * verification because of this single-character gap. Tracked as carry-forward for
 * a tiny PROD verifier PR (`src/lib/parser/verify-source-excerpts.ts` regex
 * extension — append U+00AD to the hyphen-fold class).
 */
function normalizeForHarness(text: string): string {
  // U+00AD SOFT HYPHEN — fold to ASCII hyphen-minus to match PROD verifier's
  // existing fold of U+2010-U+2015 + U+2212. Use explicit unicode escape since
  // the literal char is invisible in source files.
  return normalizeWhitespace(text.replace(/­/g, '-'));
}

export function verifyExcerpt(excerpt: string | null | undefined, ocrText: string): VerifyResult {
  if (!excerpt || excerpt.trim().length === 0) {
    return { verified: false, method: 'no_excerpt' };
  }
  if (ocrText.includes(excerpt)) {
    return { verified: true, method: 'exact' };
  }
  const normalizedOcr = normalizeForHarness(ocrText);
  const normalizedExcerpt = normalizeForHarness(excerpt);
  if (normalizedExcerpt.length === 0) {
    return { verified: false, method: 'not_found' };
  }
  if (normalizedOcr.includes(normalizedExcerpt)) {
    return { verified: true, method: 'normalized' };
  }
  const bridged = findBridgedMatch(normalizedExcerpt, normalizedOcr);
  if (bridged) {
    return { verified: true, method: 'bridge' };
  }
  return { verified: false, method: 'not_found' };
}
