/**
 * Phase 4 Task 4-H smoke test — consumer-read filter library (Task 4-A output).
 *
 * Pure-function tests; no DB access required. Verifies:
 *   C1: isCitationGrade() per Pattern P-8 hard rule
 *   C2: corroborationThreshold() per-source thresholds
 *   C3: getDisplayState() for the 4 states + 9 reasons
 *   C4: decorateForDisplay() round-trips with excerpt extraction
 *   C5: decorateRowsWithDisplayState() preserves rows + adds annotations
 *
 * Usage:
 *   npx tsx scripts/test-phase4-consumer-read.ts
 */

import {
  isCitationGrade,
  corroborationThreshold,
  getDisplayState,
  decorateForDisplay,
  decorateRowsWithDisplayState,
  extractPatternP8FromEntry,
  decorateFieldFromEntry,
  DISPLAY_STATE_TOOLTIP_EN,
  type DisplayStateInput,
  type DisplayStateReason,
} from "@/lib/parser/consumer-read";
import type { PatternP8Provenance } from "@/lib/parser/verify-source-excerpts";
import type { FieldProvenanceEntry } from "@/lib/parser/field-categories";

const TAG = "[phase4-consumer-read]";

let passed = 0;
let failed = 0;

function assertEq<T>(actual: T, expected: T, label: string): void {
  if (actual === expected) {
    passed++;
  } else {
    failed++;
    console.error(`${TAG} FAIL ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assert(cond: boolean, label: string): void {
  if (cond) passed++;
  else {
    failed++;
    console.error(`${TAG} FAIL ${label}`);
  }
}

// ─── Fixture provenance shapes ──────────────────────────────────────────────
function provVerified(): PatternP8Provenance {
  return {
    source_excerpt: "Deductible: $1,500 individual",
    source_excerpt_verified: "verified",
    source_excerpt_extraction_method: "pdftotext",
    source_section_hint: "important_questions",
    source_section_verified: true,
  };
}

function provNotFound(): PatternP8Provenance {
  return {
    source_excerpt: "Some Haiku-generated quote not in source",
    source_excerpt_verified: "not_found",
    source_excerpt_extraction_method: "pdftotext",
    source_section_hint: "important_questions",
    source_section_verified: false,
  };
}

function provOcrUnverifiable(): PatternP8Provenance {
  return {
    source_excerpt: "Approximate quote from scanned doc",
    source_excerpt_verified: "ocr_unverifiable",
    source_excerpt_extraction_method: "ocr",
    source_section_hint: "common_medical_events",
    source_section_verified: true,
  };
}

function provDoNotExtract(): PatternP8Provenance {
  return {
    source_excerpt: "Boilerplate footer text",
    source_excerpt_verified: "verified",
    source_excerpt_extraction_method: "pdftotext",
    source_section_hint: "footer_legalese_DO_NOT_EXTRACT",
    source_section_verified: true,
  };
}

// ─── C1: isCitationGrade ────────────────────────────────────────────────────
function testC1_IsCitationGrade() {
  console.log(`${TAG} C1: isCitationGrade() ...`);
  assertEq(isCitationGrade(null), false, "C1.1: null provenance → false");
  assertEq(isCitationGrade(undefined), false, "C1.2: undefined provenance → false");
  assertEq(isCitationGrade(provVerified()), true, "C1.3: verified + section_verified + non-DO_NOT_EXTRACT → true");
  assertEq(isCitationGrade(provNotFound()), false, "C1.4: not_found → false");
  assertEq(isCitationGrade(provOcrUnverifiable()), false, "C1.5: ocr_unverifiable → false");
  assertEq(isCitationGrade(provDoNotExtract()), false, "C1.6: DO_NOT_EXTRACT section → false even if section_verified");
  // Edge: verified but section_verified=false (Haiku misattribution)
  const misattributed: PatternP8Provenance = { ...provVerified(), source_section_verified: false };
  assertEq(isCitationGrade(misattributed), false, "C1.7: section_verified=false → false");
}

// ─── C2: corroborationThreshold ─────────────────────────────────────────────
function testC2_CorroborationThreshold() {
  console.log(`${TAG} C2: corroborationThreshold() ...`);
  assertEq(corroborationThreshold("doc_extraction", 3), 0, "C2.1: doc_extraction → 0 (self)");
  assertEq(corroborationThreshold("admin_verified", 3), 0, "C2.2: admin_verified → 0 (trusted)");
  assertEq(corroborationThreshold("user_correction", 3), 0, "C2.3: user_correction → 0 (self)");
  assertEq(corroborationThreshold("card_corroboration", 3), 0, "C2.4: card_corroboration → 0 (self)");
  assertEq(corroborationThreshold("bill_observed", 3), 0, "C2.5: bill_observed → 0 (self)");
  assertEq(corroborationThreshold("cms_marketplace", 3), 0, "C2.6: cms_marketplace → 0 (trusted)");
  assertEq(corroborationThreshold("canonical_inherited", 3), 3, "C2.7: canonical_inherited → configured (3)");
  assertEq(corroborationThreshold("canonical_inherited", 5), 5, "C2.8: canonical_inherited → configured (5)");
  assertEq(corroborationThreshold("canonical_fallback", 3), 3, "C2.9: canonical_fallback → configured (3)");
  assertEq(corroborationThreshold("provider_submitted", 3), 2, "C2.10: provider_submitted → 2 (hardcoded)");
  assertEq(corroborationThreshold("provider_submitted", 5), 2, "C2.11: provider_submitted → 2 regardless of configured");
  assertEq(corroborationThreshold("totally_fake_source", 3), 0, "C2.12: unknown source → 0 (default trusted)");
}

// ─── C3: getDisplayState — 4 states × 9 reasons ─────────────────────────────
function testC3_GetDisplayState() {
  console.log(`${TAG} C3: getDisplayState() ...`);

  // Tier 0 (hidden): DO_NOT_EXTRACT trumps all
  const hidden = getDisplayState({
    provenance: provDoNotExtract(),
    confidence: 1.0,
    sourceCount: 100,
    source: "doc_extraction",
    multiSourceThreshold: 3,
  });
  assertEq(hidden.state, "hidden", "C3.1.state");
  assertEq(hidden.reason, "do_not_extract_section", "C3.1.reason");

  // Tier 1 (verified) — cite-grade + cross-user corroborated
  const r1 = getDisplayState({
    provenance: provVerified(),
    confidence: 0.9,
    sourceCount: 5,
    source: "canonical_inherited",
    multiSourceThreshold: 3,
  });
  assertEq(r1.state, "verified", "C3.2.state");
  assertEq(r1.reason, "p8_cite_grade_corroborated", "C3.2.reason");

  // Tier 1 (verified) — cite-grade self-source (single user, no corroboration needed)
  const r2 = getDisplayState({
    provenance: provVerified(),
    confidence: 0.5,
    sourceCount: 1,
    source: "doc_extraction",
    multiSourceThreshold: 3,
  });
  assertEq(r2.state, "verified", "C3.3.state");
  assertEq(r2.reason, "p8_cite_grade_self_source", "C3.3.reason");

  // Tier 1 (verified) — corroborated multi-user, no cite (canonical with verification_count >= threshold)
  const r3 = getDisplayState({
    provenance: null,
    confidence: 0.9,
    sourceCount: 5,
    source: "canonical_inherited",
    multiSourceThreshold: 3,
  });
  assertEq(r3.state, "verified", "C3.4.state");
  assertEq(r3.reason, "corroborated_multi_user", "C3.4.reason");

  // Tier 2 (unverified) — Haiku not_found
  const r4 = getDisplayState({
    provenance: provNotFound(),
    confidence: 0.5,
    sourceCount: 1,
    source: "doc_extraction",
    multiSourceThreshold: 3,
  });
  assertEq(r4.state, "unverified", "C3.5.state");
  assertEq(r4.reason, "haiku_not_found", "C3.5.reason");

  // Tier 3 (estimated) — cross-user below threshold (canonical_inherited with sourceCount<3)
  const r5 = getDisplayState({
    provenance: null,
    confidence: 0.7,
    sourceCount: 1,
    source: "canonical_inherited",
    multiSourceThreshold: 3,
  });
  assertEq(r5.state, "estimated", "C3.6.state");
  assertEq(r5.reason, "cross_user_below_threshold", "C3.6.reason");

  // Tier 3 (estimated) — canonical_fallback
  const r6 = getDisplayState({
    provenance: null,
    confidence: 0.5,
    sourceCount: 0,
    source: "canonical_fallback",
    multiSourceThreshold: 3,
  });
  assertEq(r6.state, "estimated", "C3.7.state");
  assertEq(r6.reason, "canonical_fallback", "C3.7.reason");

  // Tier 3 (estimated) — provider_submitted below threshold (needs 2)
  const r7 = getDisplayState({
    provenance: null,
    confidence: 0.5,
    sourceCount: 1,
    source: "provider_submitted",
    multiSourceThreshold: 3, // ignored; provider has hardcoded 2
  });
  assertEq(r7.state, "estimated", "C3.8.state");
  assertEq(r7.reason, "cross_user_below_threshold", "C3.8.reason");

  // Tier 3 (estimated) — provider_submitted ABOVE threshold (sourceCount=2)
  const r8 = getDisplayState({
    provenance: null,
    confidence: 0.7,
    sourceCount: 2,
    source: "provider_submitted",
    multiSourceThreshold: 3,
  });
  assertEq(r8.state, "verified", "C3.9.state");
  assertEq(r8.reason, "corroborated_multi_user", "C3.9.reason");

  // Tier 3 (estimated) — ocr_unverifiable
  const r9 = getDisplayState({
    provenance: provOcrUnverifiable(),
    confidence: 0.6,
    sourceCount: 1,
    source: "doc_extraction",
    multiSourceThreshold: 3,
  });
  assertEq(r9.state, "estimated", "C3.10.state");
  assertEq(r9.reason, "ocr_unverifiable", "C3.10.reason");

  // Tier 3 (estimated) — low_confidence
  const r10 = getDisplayState({
    provenance: null,
    confidence: 0.3,
    sourceCount: 1,
    source: "doc_extraction",
    multiSourceThreshold: 3,
  });
  assertEq(r10.state, "estimated", "C3.11.state");
  assertEq(r10.reason, "low_confidence", "C3.11.reason");

  // Tier 3 (estimated) — self_source_no_cite default
  const r11 = getDisplayState({
    provenance: null,
    confidence: 0.7,
    sourceCount: 1,
    source: "doc_extraction",
    multiSourceThreshold: 3,
  });
  assertEq(r11.state, "estimated", "C3.12.state");
  assertEq(r11.reason, "self_source_no_cite", "C3.12.reason");
}

// ─── C4: decorateForDisplay round-trip ──────────────────────────────────────
function testC4_DecorateForDisplay() {
  console.log(`${TAG} C4: decorateForDisplay() ...`);
  const input: DisplayStateInput = {
    provenance: provVerified(),
    confidence: 0.9,
    sourceCount: 1,
    source: "doc_extraction",
    multiSourceThreshold: 3,
  };
  const result = decorateForDisplay({ deductible: 1500 }, input);
  assertEq(result.value.deductible, 1500, "C4.1: value preserved");
  assertEq(result.state, "verified", "C4.2: state set");
  assertEq(result.reason, "p8_cite_grade_self_source", "C4.3: reason set");
  assertEq(result.hasExcerpt, true, "C4.4: hasExcerpt true");
  assertEq(result.excerpt, "Deductible: $1,500 individual", "C4.5: excerpt extracted");

  // Null provenance → no excerpt
  const nullProvResult = decorateForDisplay("test", { ...input, provenance: null });
  assertEq(nullProvResult.hasExcerpt, false, "C4.6: null provenance hasExcerpt false");
  assertEq(nullProvResult.excerpt, null, "C4.7: null provenance excerpt null");
}

// ─── C5: decorateRowsWithDisplayState preserves rows + adds annotations ─────
function testC5_DecorateRows() {
  console.log(`${TAG} C5: decorateRowsWithDisplayState() ...`);
  const rows = [
    {
      id: "row1",
      service_slug: "pcp_visit",
      copay: 25,
      confidence: 0.9,
      sourceCount: 1,
      source: "doc_extraction" as const,
      provenance: provVerified(),
    },
    {
      id: "row2",
      service_slug: "specialist_visit",
      copay: 50,
      confidence: 0.5,
      sourceCount: 1,
      source: "canonical_inherited" as const,
      provenance: null,
    },
    {
      id: "row3",
      service_slug: "er_visit",
      copay: 250,
      confidence: 0.9,
      sourceCount: 5,
      source: "canonical_inherited" as const,
      provenance: provVerified(),
    },
  ];
  const decorated = decorateRowsWithDisplayState(rows, 3);

  assertEq(decorated.length, 3, "C5.1: row count preserved");
  assertEq(decorated[0].id, "row1", "C5.2: row1 id preserved");
  assertEq(decorated[0].copay, 25, "C5.3: row1 copay preserved");
  assertEq(decorated[0].displayState, "verified", "C5.4: row1 verified (self-source cite-grade)");
  assertEq(decorated[0].displayReason, "p8_cite_grade_self_source", "C5.5: row1 reason");
  assertEq(decorated[1].displayState, "estimated", "C5.6: row2 estimated (canonical, below threshold)");
  assertEq(decorated[1].displayReason, "cross_user_below_threshold", "C5.7: row2 reason");
  assertEq(decorated[2].displayState, "verified", "C5.8: row3 verified (canonical, above threshold + cite-grade)");
  assertEq(decorated[2].displayReason, "p8_cite_grade_corroborated", "C5.9: row3 reason");
}

// ─── C6: tooltip map covers all reasons ─────────────────────────────────────
function testC6_TooltipMapComplete() {
  console.log(`${TAG} C6: DISPLAY_STATE_TOOLTIP_EN coverage ...`);
  const expectedReasons: DisplayStateReason[] = [
    "p8_cite_grade_corroborated",
    "p8_cite_grade_self_source",
    "corroborated_multi_user",
    "self_source_no_cite",
    "cross_user_below_threshold",
    "canonical_fallback",
    "ocr_unverifiable",
    "low_confidence",
    "haiku_not_found",
    "do_not_extract_section",
  ];
  for (const reason of expectedReasons) {
    const text = DISPLAY_STATE_TOOLTIP_EN[reason];
    assert(text !== undefined && text.length > 0, `C6.${reason}: tooltip text exists`);
  }
}

// ─── C7: extractPatternP8FromEntry + decorateFieldFromEntry (Task 4-B helpers) ──
function testC7_ExtractAndDecorateFromEntry() {
  console.log(`${TAG} C7: extractPatternP8FromEntry + decorateFieldFromEntry ...`);

  // C7.1: null/undefined entry → null
  assertEq(extractPatternP8FromEntry(null), null, "C7.1: null entry → null");
  assertEq(extractPatternP8FromEntry(undefined), null, "C7.2: undefined entry → null");

  // C7.3: entry with all 5 P-8 fields → returns PatternP8Provenance
  const fullEntry: FieldProvenanceEntry = {
    source: "doc_extraction",
    confidence: 0.5,
    last_corroborated_at: "2026-05-02T12:00:00Z",
    source_excerpt: "Deductible: $1,500 individual",
    source_excerpt_verified: "verified",
    source_excerpt_extraction_method: "pdftotext",
    source_section_hint: "important_questions",
    source_section_verified: true,
  };
  const extracted = extractPatternP8FromEntry(fullEntry);
  assert(extracted !== null, "C7.3: full entry → non-null");
  assertEq(extracted?.source_excerpt, "Deductible: $1,500 individual", "C7.4: source_excerpt extracted");
  assertEq(extracted?.source_excerpt_verified, "verified", "C7.5: source_excerpt_verified extracted");
  assertEq(extracted?.source_section_verified, true, "C7.6: source_section_verified extracted");

  // C7.7: entry missing source_excerpt → null (partial P-8 not citation-grade)
  const partialEntry: FieldProvenanceEntry = {
    source: "doc_extraction",
    confidence: 0.5,
    last_corroborated_at: "2026-05-02T12:00:00Z",
    source_excerpt_verified: "verified",
    source_excerpt_extraction_method: "pdftotext",
    source_section_hint: "important_questions",
    source_section_verified: true,
  };
  assertEq(extractPatternP8FromEntry(partialEntry), null, "C7.7: missing source_excerpt → null");

  // C7.8: entry without any P-8 (legacy regex extraction) → null
  const legacyEntry: FieldProvenanceEntry = {
    source: "doc_extraction_eoc",
    confidence: 0.5,
    last_corroborated_at: "2026-05-02T12:00:00Z",
  };
  assertEq(extractPatternP8FromEntry(legacyEntry), null, "C7.8: legacy entry (no P-8) → null");

  // C7.9: decorateFieldFromEntry round-trip with full P-8 entry
  const decorated = decorateFieldFromEntry(1500, fullEntry, {
    sourceCount: 1,
    source: "doc_extraction",
    multiSourceThreshold: 3,
  });
  assertEq(decorated.value, 1500, "C7.9: value preserved");
  assertEq(decorated.state, "verified", "C7.10: state from P-8 cite-grade");
  assertEq(decorated.reason, "p8_cite_grade_self_source", "C7.11: reason from P-8 self-source");
  assertEq(decorated.excerpt, "Deductible: $1,500 individual", "C7.12: excerpt extracted from entry");
  assertEq(decorated.hasExcerpt, true, "C7.13: hasExcerpt true");

  // C7.14: decorateFieldFromEntry with null entry uses fallbackConfidence
  const nullEntryDecorated = decorateFieldFromEntry(450, null, {
    sourceCount: 5,
    source: "canonical_inherited",
    multiSourceThreshold: 3,
    fallbackConfidence: 0.5,
  });
  assertEq(nullEntryDecorated.value, 450, "C7.14: value preserved with null entry");
  assertEq(nullEntryDecorated.state, "verified", "C7.15: state = verified (corroborated cross-user)");
  assertEq(nullEntryDecorated.reason, "corroborated_multi_user", "C7.16: reason = multi-user");

  // C7.17: decorateFieldFromEntry with canonical_inherited below threshold → estimated
  const belowThreshold = decorateFieldFromEntry(450, null, {
    sourceCount: 1,
    source: "canonical_inherited",
    multiSourceThreshold: 3,
  });
  assertEq(belowThreshold.state, "estimated", "C7.17: below threshold → estimated");
  assertEq(belowThreshold.reason, "cross_user_below_threshold", "C7.18: reason = below threshold");

  // C7.19: decorateFieldFromEntry confidence sourced from entry, not fallback
  const customConfidenceEntry: FieldProvenanceEntry = {
    source: "doc_extraction",
    confidence: 0.3, // low confidence
    last_corroborated_at: "2026-05-02T12:00:00Z",
  };
  const lowConfidenceResult = decorateFieldFromEntry(100, customConfidenceEntry, {
    sourceCount: 1,
    source: "doc_extraction",
    multiSourceThreshold: 3,
    fallbackConfidence: 0.9, // ignored in favor of entry's 0.3
  });
  assertEq(lowConfidenceResult.state, "estimated", "C7.19: state = estimated (low confidence)");
  assertEq(lowConfidenceResult.reason, "low_confidence", "C7.20: reason = low_confidence");
}

// ─── Main ────────────────────────────────────────────────────────────────────
function main() {
  console.log(`${TAG} Phase 4 consumer-read filter smoke test starting`);
  testC1_IsCitationGrade();
  testC2_CorroborationThreshold();
  testC3_GetDisplayState();
  testC4_DecorateForDisplay();
  testC5_DecorateRows();
  testC6_TooltipMapComplete();
  testC7_ExtractAndDecorateFromEntry();
  console.log(`${TAG} ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.error(`${TAG} FAILURES — exiting non-zero`);
    process.exit(1);
  }
  console.log(`${TAG} All tests passed.`);
  process.exit(0);
}

main();
