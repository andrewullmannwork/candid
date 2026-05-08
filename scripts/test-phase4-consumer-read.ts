/**
 * Phase 4 Task 4-H + Phase 4.0.5 Task 4.0.5-G smoke test — consumer-read filter
 * library (Task 4-A output) + targeted re-parse + verbatim_absent derivation +
 * 2-button affordance routing (Phase 4.0.5).
 *
 * Pure-function tests; no DB access required. Verifies:
 *   C1: isCitationGrade() per Pattern P-8 hard rule
 *   C2: corroborationThreshold() per-source thresholds
 *   C3: getDisplayState() for the 4 states + 10 reasons (verbatim_absent_searched_all NEW)
 *   C4: decorateForDisplay() round-trips with excerpt extraction
 *   C5: decorateRowsWithDisplayState() preserves rows + adds annotations
 *   C6: DISPLAY_STATE_TOOLTIP_EN map covers all reasons
 *   C7: extractPatternP8FromEntry / decorateFieldFromEntry (Task 4-B)
 *   C8: isDecoratedValue type guard (Task 4-D — UI consumer-side branching)
 *   C9: aggregateRowState worst-signal aggregation (Task 4-D — row-level state)
 *   C10: deriveVerbatimAbsentFromCoverage() boundary cases (Phase 4.0.5)
 *   C11: targeted re-parse contract — searchedSectionsCount roundtrip (Phase 4.0.5)
 *   C12: affordanceShapeFor() routing per DR §4 state matrix (Phase 4.0.5)
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
  isDecoratedValue,
  aggregateRowState,
  DISPLAY_STATE_TOOLTIP_EN,
  type DisplayStateInput,
  type DisplayStateReason,
  type DisplayState,
} from "@/lib/parser/consumer-read";
import type { PatternP8Provenance } from "@/lib/parser/verify-source-excerpts";
import type { FieldProvenanceEntry, SourceProvenance } from "@/lib/parser/field-categories";
// Phase 4.0.5 Task 4.0.5-G: extended smoke test groups C10 + C11 + C12.
import {
  deriveVerbatimAbsentFromCoverage,
  NON_DO_NOT_EXTRACT_SBC_SECTIONS,
} from "@/lib/plan/reparse-field";
import { affordanceShapeFor } from "@/components/verify-affordance";

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
  assertEq(hidden.reason, "boilerplate", "C3.1.reason");

  // CF-19 v2 4-state: Tier 1 (candid_verified) — Pattern 1 #3 corroboration met
  const r1 = getDisplayState({
    provenance: provVerified(),
    confidence: 0.9,
    sourceCount: 5,
    source: "canonical_inherited",
    multiSourceThreshold: 3,
  });
  assertEq(r1.state, "candid_verified", "C3.2.state");
  assertEq(r1.reason, "community_corroborated", "C3.2.reason");

  // Tier 2 (verified) — cite-grade self-source (single user, no corroboration needed)
  const r2 = getDisplayState({
    provenance: provVerified(),
    confidence: 0.5,
    sourceCount: 1,
    source: "doc_extraction",
    multiSourceThreshold: 3,
  });
  assertEq(r2.state, "user_verified", "C3.3.state");
  assertEq(r2.reason, "from_user_document_cite_grade", "C3.3.reason");

  // Tier 1 (candid_verified) — corroborated multi-user (canonical with verification_count >= threshold)
  const r3 = getDisplayState({
    provenance: null,
    confidence: 0.9,
    sourceCount: 5,
    source: "canonical_inherited",
    multiSourceThreshold: 3,
  });
  assertEq(r3.state, "candid_verified", "C3.4.state");
  assertEq(r3.reason, "community_corroborated", "C3.4.reason");

  // Tier 4 (hidden) — Haiku not_found → parser_failure
  // CF-19 v2: not_found maps to parser_failure (page-level banner aggregates).
  const r4 = getDisplayState({
    provenance: provNotFound(),
    confidence: 0.5,
    sourceCount: 1,
    source: "doc_extraction",
    multiSourceThreshold: 3,
  });
  assertEq(r4.state, "hidden", "C3.5.state");
  assertEq(r4.reason, "parser_failure", "C3.5.reason");

  // Session 72 v3: canonical_inherited (sub-3) → "community" state (was "verified" in v1).
  const r5 = getDisplayState({
    provenance: null,
    confidence: 0.7,
    sourceCount: 1,
    source: "canonical_inherited",
    multiSourceThreshold: 3,
  });
  assertEq(r5.state, "community", "C3.6.state");
  assertEq(r5.reason, "canonical_below_threshold", "C3.6.reason");

  // Tier 3 (estimated) — canonical_fallback below threshold (CMS marketplace)
  const r6 = getDisplayState({
    provenance: null,
    confidence: 0.5,
    sourceCount: 0,
    source: "canonical_fallback",
    multiSourceThreshold: 3,
  });
  assertEq(r6.state, "public_data", "C3.7.state");
  assertEq(r6.reason, "cms_marketplace", "C3.7.reason");

  // Session 72 v3: provider_submitted below threshold → "community" state.
  const r7 = getDisplayState({
    provenance: null,
    confidence: 0.5,
    sourceCount: 1,
    source: "provider_submitted",
    multiSourceThreshold: 3, // ignored; provider has hardcoded 2
  });
  assertEq(r7.state, "community", "C3.8.state");
  assertEq(r7.reason, "provider_attestation_below_threshold", "C3.8.reason");

  // Tier 1 (candid_verified) — provider_submitted ABOVE threshold (sourceCount=2)
  const r8 = getDisplayState({
    provenance: null,
    confidence: 0.7,
    sourceCount: 2,
    source: "provider_submitted",
    multiSourceThreshold: 3,
  });
  assertEq(r8.state, "candid_verified", "C3.9.state");
  assertEq(r8.reason, "community_corroborated", "C3.9.reason");

  // Tier 4 (hidden) — ocr_unverifiable → parser_failure
  const r9 = getDisplayState({
    provenance: provOcrUnverifiable(),
    confidence: 0.6,
    sourceCount: 1,
    source: "doc_extraction",
    multiSourceThreshold: 3,
  });
  assertEq(r9.state, "hidden", "C3.10.state");
  assertEq(r9.reason, "parser_failure", "C3.10.reason");

  // Tier 4 (hidden) — low_confidence → parser_failure
  const r10 = getDisplayState({
    provenance: null,
    confidence: 0.3,
    sourceCount: 1,
    source: "doc_extraction",
    multiSourceThreshold: 3,
  });
  assertEq(r10.state, "hidden", "C3.11.state");
  assertEq(r10.reason, "parser_failure", "C3.11.reason");

  // Tier 4 (hidden) — null provenance + self/trusted source → parser_failure
  // CF-19 v2: pre-mig-063 legacy rows + smart-skip pre-fix all land here.
  const r11 = getDisplayState({
    provenance: null,
    confidence: 0.7,
    sourceCount: 1,
    source: "doc_extraction",
    multiSourceThreshold: 3,
  });
  assertEq(r11.state, "hidden", "C3.12.state");
  assertEq(r11.reason, "parser_failure", "C3.12.reason");
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
  assertEq(result.state, "user_verified", "C4.2: state (Session 72 v3: cite-grade self-source → upload)");
  assertEq(result.reason, "from_user_document_cite_grade", "C4.3: reason");
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
  assertEq(decorated[0].displayState, "user_verified", "C5.4: row1 upload (self-source cite-grade)");
  assertEq(decorated[0].displayReason, "from_user_document_cite_grade", "C5.5: row1 reason");
  // Session 72 v3: canonical_below_threshold → "community" badge.
  assertEq(decorated[1].displayState, "community", "C5.6: row2 community (canonical below threshold)");
  assertEq(decorated[1].displayReason, "canonical_below_threshold", "C5.7: row2 reason");
  assertEq(decorated[2].displayState, "candid_verified", "C5.8: row3 candid_verified (canonical above threshold)");
  assertEq(decorated[2].displayReason, "community_corroborated", "C5.9: row3 reason");
}

// ─── C6: tooltip map covers all reasons ─────────────────────────────────────
function testC6_TooltipMapComplete() {
  console.log(`${TAG} C6: DISPLAY_STATE_TOOLTIP_EN coverage ...`);
  // CF-19 v2 (Session 64): collapsed 14 reasons → 8.
  const expectedReasons: DisplayStateReason[] = [
    // candid_verified family
    "community_corroborated",
    // verified family
    "from_user_document_cite_grade",
    "from_user_document_no_cite",
    // estimated family
    "canonical_below_threshold",
    "cms_marketplace",
    "provider_attestation_below_threshold",
    // hidden family
    "parser_failure",
    "boilerplate",
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
  assertEq(decorated.state, "user_verified", "C7.10: state from P-8 cite-grade (Session 72 v3 → upload)");
  assertEq(decorated.reason, "from_user_document_cite_grade", "C7.11: reason from cite-grade self-source");
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
  assertEq(nullEntryDecorated.state, "candid_verified", "C7.15: state = candid_verified (corroborated cross-user)");
  assertEq(nullEntryDecorated.reason, "community_corroborated", "C7.16: CF-19 v2: canonical_inherited above threshold → community_corroborated");

  // C7.17: Session 72 v3 — canonical_inherited below threshold → "community" state.
  const belowThreshold = decorateFieldFromEntry(450, null, {
    sourceCount: 1,
    source: "canonical_inherited",
    multiSourceThreshold: 3,
  });
  assertEq(belowThreshold.state, "community", "C7.17: below threshold → community");
  assertEq(belowThreshold.reason, "canonical_below_threshold", "C7.18: reason = canonical_below_threshold");

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
  // CF-19 v2: low_confidence collapses into parser_failure → hidden state
  assertEq(lowConfidenceResult.state, "hidden", "C7.19: state = hidden (low confidence → parser_failure)");
  assertEq(lowConfidenceResult.reason, "parser_failure", "C7.20: reason = parser_failure (collapsed)");
}

// ─── C8: isDecoratedValue type guard (Session 57 Task 4-D) ─────────────────
function testC8_IsDecoratedValue(): void {
  // Raw primitives → false
  assertEq(isDecoratedValue(null), false, "C8.1: null → false");
  assertEq(isDecoratedValue(undefined), false, "C8.2: undefined → false");
  assertEq(isDecoratedValue(42), false, "C8.3: number → false");
  assertEq(isDecoratedValue("foo"), false, "C8.4: string → false");
  assertEq(isDecoratedValue(true), false, "C8.5: boolean → false");
  assertEq(isDecoratedValue([]), false, "C8.6: array → false");

  // Objects missing required keys → false (avoid bare-object false-positive)
  assertEq(isDecoratedValue({}), false, "C8.7: empty object → false");
  assertEq(isDecoratedValue({ value: 30 }), false, "C8.8: only value → false");
  assertEq(isDecoratedValue({ value: 30, state: "verified" }), false, "C8.9: missing reason → false");

  // Real DecoratedValue → true
  const decorated = decorateForDisplay(30, {
    provenance: provVerified(),
    confidence: 0.9,
    sourceCount: 1,
    source: "doc_extraction",
    multiSourceThreshold: 3,
  });
  assertEq(isDecoratedValue(decorated), true, "C8.10: real DecoratedValue → true");
  assertEq(decorated.value, 30, "C8.11: decorated.value preserved");

  // DecoratedValue<null> still passes (value can be null)
  const decoratedNull = decorateForDisplay<number | null>(null, {
    provenance: null,
    confidence: 0.5,
    sourceCount: 1,
    source: "doc_extraction",
    multiSourceThreshold: 3,
  });
  assertEq(isDecoratedValue(decoratedNull), true, "C8.12: DecoratedValue<null> → true");
}

// ─── C9: aggregateRowState — CF-19 (Session 64) 6-state vocabulary ─────────
function testC9_AggregateRowState(): void {
  // Empty array → null (no decoration available; flag OFF case)
  assertEq(aggregateRowState([]), null, "C9.1: empty → null");

  // All-null array → null (no decorated fields on this row)
  assertEq(aggregateRowState([null, null, null]), null, "C9.2: all null → null");

  // Single field, single state — Session 72 v3 5-state vocabulary
  assertEq(aggregateRowState(["candid_verified"]), "candid_verified", "C9.3a: single candid_verified");
  assertEq(aggregateRowState(["user_verified"]), "user_verified", "C9.3b: single user_verified");
  assertEq(aggregateRowState(["community"]), "community", "C9.3c: single community");
  assertEq(aggregateRowState(["public_data"]), "public_data", "C9.3d: single public_data");
  assertEq(aggregateRowState(["user_verified"]), "user_verified", "C9.3e: single user_verified");

  // hidden filtered out (boilerplate / parser_failure; not contributing to row signal)
  assertEq(aggregateRowState(["hidden", "candid_verified"]), "candid_verified", "C9.6: hidden filtered");
  assertEq(aggregateRowState(["hidden"]), null, "C9.7: only hidden → null");

  // Worst-state wins (priority: public_data < community < user_verified < user_verified < candid_verified)
  assertEq(aggregateRowState(["candid_verified", "candid_verified"]), "candid_verified", "C9.8: all candid_verified");
  assertEq(aggregateRowState(["candid_verified", "public_data"]), "public_data", "C9.9: any public_data drags down");
  assertEq(aggregateRowState(["user_verified", "community"]), "community", "C9.10: community < user_verified");
  assertEq(aggregateRowState(["candid_verified", "user_verified"]), "user_verified", "C9.12a: user_verified < candid_verified");
  assertEq(aggregateRowState(["user_verified", "community"]), "community", "C9.12b: community < user_verified");

  // Real-world row: mostly candid_verified, one public_data drags down
  const realisticRow: Array<DisplayState | null> = [
    "candid_verified",
    "candid_verified",
    null,
    null,
    "candid_verified",
    "public_data",
  ];
  assertEq(aggregateRowState(realisticRow), "public_data", "C9.13: realistic row → worst signal");
}

// ─── C10: verbatim_absent enum derivation (Phase 4.0.5) ────────────────────
function testC10_VerbatimAbsentDerivation(): void {
  console.log(`${TAG} C10: deriveVerbatimAbsentFromCoverage() ...`);
  const ALL = NON_DO_NOT_EXTRACT_SBC_SECTIONS;
  // C10.1: empty searched + not_found → stays not_found
  assertEq(deriveVerbatimAbsentFromCoverage("not_found", []), "not_found", "C10.1: empty → not_found");
  // C10.2: single section searched + not_found → stays not_found
  assertEq(
    deriveVerbatimAbsentFromCoverage("not_found", ["important_questions"]),
    "not_found",
    "C10.2: 1 of 5 → not_found",
  );
  // C10.3: 4 of 5 sections searched + not_found → stays not_found (incomplete)
  assertEq(
    deriveVerbatimAbsentFromCoverage("not_found", ALL.slice(0, 4)),
    "not_found",
    "C10.3: 4 of 5 → not_found (incomplete coverage)",
  );
  // C10.4: ALL non-DO_NOT_EXTRACT searched + not_found → flips to verbatim_absent
  assertEq(
    deriveVerbatimAbsentFromCoverage("not_found", [...ALL]),
    "verbatim_absent",
    "C10.4: 5 of 5 → verbatim_absent",
  );
  // C10.5: ALL searched + verified → stays verified (no flip when already verified)
  assertEq(
    deriveVerbatimAbsentFromCoverage("verified", [...ALL]),
    "verified",
    "C10.5: verified + complete → verified (no flip)",
  );
  // C10.6: ALL searched + ocr_unverifiable → stays ocr_unverifiable (different state)
  assertEq(
    deriveVerbatimAbsentFromCoverage("ocr_unverifiable", [...ALL]),
    "ocr_unverifiable",
    "C10.6: ocr_unverifiable + complete → no flip (different state)",
  );
  // C10.7: ALL + extra DO_NOT_EXTRACT mixed in → still verbatim_absent (extras ignored)
  assertEq(
    deriveVerbatimAbsentFromCoverage("not_found", [...ALL, "header_DO_NOT_EXTRACT"]),
    "verbatim_absent",
    "C10.7: ALL + DO_NOT_EXTRACT extras → verbatim_absent",
  );
  // C10.8: ALL minus 1 + 1 DO_NOT_EXTRACT → stays not_found (DO_NOT_EXTRACT doesn't fill the gap)
  assertEq(
    deriveVerbatimAbsentFromCoverage("not_found", [
      ...ALL.slice(0, 4),
      "footer_legalese_DO_NOT_EXTRACT",
    ]),
    "not_found",
    "C10.8: 4 of 5 + DO_NOT_EXTRACT → not_found (no substitution)",
  );
  // C10.9: enum guarantees all 5 SBC sections exactly
  assertEq(NON_DO_NOT_EXTRACT_SBC_SECTIONS.length, 5, "C10.9: SBC enum has 5 non-DO_NOT_EXTRACT sections");
  // C10.10: enum order independence — shuffled inputs produce same result
  assertEq(
    deriveVerbatimAbsentFromCoverage("not_found", [...ALL].reverse()),
    "verbatim_absent",
    "C10.10: order-independence — reversed input → verbatim_absent",
  );
}

// ─── C11: targeted re-parse contract (FieldProvenanceEntry merge) ──────────
function testC11_ReparseContract(): void {
  console.log(`${TAG} C11: targeted re-parse contract ...`);
  // C11.1: provenance entry with searched_sections survives roundtrip via decorateFieldFromEntry
  const entry: FieldProvenanceEntry = {
    source: "doc_extraction",
    confidence: 0.5,
    last_corroborated_at: new Date().toISOString(),
    source_excerpt: "$2,500 deductible per individual",
    source_excerpt_verified: "verified",
    source_excerpt_extraction_method: "pdftotext",
    source_section_hint: "important_questions",
    source_section_verified: true,
    searched_sections: ["important_questions", "common_medical_events"],
  };
  const decorated = decorateFieldFromEntry(2500, entry, {
    sourceCount: 1,
    source: "doc_extraction",
    multiSourceThreshold: 3,
  });
  assertEq(decorated.searchedSectionsCount, 2, "C11.1: searchedSectionsCount populated from entry");
  // C11.2: undefined searched_sections (pre-Phase-4.0.5 row) → undefined count
  const legacyEntry: FieldProvenanceEntry = {
    source: "doc_extraction",
    confidence: 0.5,
    last_corroborated_at: new Date().toISOString(),
    source_excerpt: "Some quote",
    source_excerpt_verified: "not_found",
    source_excerpt_extraction_method: "pdftotext",
    source_section_hint: "important_questions",
    source_section_verified: false,
    // searched_sections intentionally omitted — pre-Phase-4.0.5 row
  };
  const decoratedLegacy = decorateFieldFromEntry(0, legacyEntry, {
    sourceCount: 1,
    source: "doc_extraction",
    multiSourceThreshold: 3,
  });
  assertEq(
    decoratedLegacy.searchedSectionsCount,
    undefined,
    "C11.2: legacy row → undefined searchedSectionsCount (forward-only fallback)",
  );
  // C11.3: empty searched_sections array → 0 (distinguishable from undefined for affordance shape)
  const emptyEntry: FieldProvenanceEntry = {
    ...legacyEntry,
    searched_sections: [],
  };
  const decoratedEmpty = decorateFieldFromEntry(0, emptyEntry, {
    sourceCount: 1,
    source: "doc_extraction",
    multiSourceThreshold: 3,
  });
  assertEq(decoratedEmpty.searchedSectionsCount, 0, "C11.3: empty array → 0 count");
  // C11.4: getDisplayState routing — verbatim_absent enum → unverified + verbatim_absent_searched_all
  const verbatimAbsentP8: PatternP8Provenance = {
    source_excerpt: "",
    source_excerpt_verified: "verbatim_absent",
    source_excerpt_extraction_method: "pdftotext",
    source_section_hint: "important_questions",
    source_section_verified: false,
  };
  const verbatimAbsentInput: DisplayStateInput = {
    provenance: verbatimAbsentP8,
    confidence: 0.5,
    sourceCount: 1,
    source: "doc_extraction",
    multiSourceThreshold: 3,
  };
  const verbatimAbsentResult = getDisplayState(verbatimAbsentInput);
  // CF-19 v2 (Session 64): verbatim_absent now lands in `verified` state with
  // `from_user_document_no_cite` reason (collapsed from found_in_document tier).
  // Backend reason still discriminates for dispute-letter cite-grade gating.
  assertEq(verbatimAbsentResult.state, "user_verified", "C11.4a: verbatim_absent → upload state (Session 72 v3)");
  assertEq(
    verbatimAbsentResult.reason,
    "from_user_document_no_cite",
    "C11.4b: verbatim_absent → from_user_document_no_cite reason (backend discriminator)",
  );
  // C11.5: section enum exhaustive — all 5 SBC sections enumerated in NON_DO_NOT_EXTRACT
  const expectedSet = new Set([
    "important_questions",
    "common_medical_events",
    "other_covered_services",
    "excluded_services",
    "appeals_grievances",
  ]);
  assert(
    NON_DO_NOT_EXTRACT_SBC_SECTIONS.every((s) => expectedSet.has(s)),
    "C11.5: all SBC enum entries are non-DO_NOT_EXTRACT",
  );
  assertEq(NON_DO_NOT_EXTRACT_SBC_SECTIONS.length, 5, "C11.5b: SBC enum length = 5");
  // C11.6: tooltip key exists for from_user_document_no_cite (CF-19 v2: subsumes
  // verbatim_absent_searched_all + found_in_doc_no_cite; both render as Verified
  // visibly, with backend reason distinguishing for dispute-letter logic).
  const tooltip = DISPLAY_STATE_TOOLTIP_EN["from_user_document_no_cite"];
  assert(typeof tooltip === "string" && tooltip.length > 0, "C11.6: from_user_document_no_cite tooltip exists");
}

// ─── C12: affordance routing — CF-19 v2 simplified (1-button-upload only) ──
function testC12_AffordanceRouting(): void {
  console.log(`${TAG} C12: affordanceShapeFor() routing ...`);
  // CF-19 v2: only Estimated state shows the inline upload affordance. All other
  // states (candid_verified / verified / hidden) → null. Reason is informational
  // for tooltip but doesn't change the shape.
  assertEq(
    affordanceShapeFor({ state: "candid_verified", reason: "community_corroborated", searchedSectionsCount: 5 }),
    null,
    "C12.1: candid_verified → null",
  );
  assertEq(
    affordanceShapeFor({ state: "user_verified", reason: "from_user_document_cite_grade", searchedSectionsCount: 5 }),
    null,
    "C12.2: user_verified (cite-grade) → null",
  );
  assertEq(
    affordanceShapeFor({ state: "user_verified", reason: "from_user_document_no_cite", searchedSectionsCount: 5 }),
    null,
    "C12.3: user_verified (no-cite) → null",
  );
  assertEq(
    affordanceShapeFor({ state: "hidden", reason: "boilerplate", searchedSectionsCount: undefined }),
    null,
    "C12.4: hidden (boilerplate) → null",
  );
  assertEq(
    affordanceShapeFor({ state: "hidden", reason: "parser_failure", searchedSectionsCount: undefined }),
    null,
    "C12.5: hidden (parser_failure) → null (handled by page-level banner)",
  );
  // Session 72 v3: needsUploadCTA() returns true for community + public_data only.
  assertEq(
    affordanceShapeFor({ state: "community", reason: "canonical_below_threshold", searchedSectionsCount: undefined }),
    "one_button_upload",
    "C12.6: community (canonical_below_threshold) → one_button_upload",
  );
  assertEq(
    affordanceShapeFor({ state: "public_data", reason: "cms_marketplace", searchedSectionsCount: undefined }),
    "one_button_upload",
    "C12.7: public_data (cms_marketplace) → one_button_upload",
  );
  assertEq(
    affordanceShapeFor({ state: "community", reason: "provider_attestation_below_threshold", searchedSectionsCount: undefined }),
    "one_button_upload",
    "C12.8: community (provider_attestation_below_threshold) → one_button_upload",
  );
  assertEq(
    affordanceShapeFor({ state: "user_verified", reason: "user_correction", searchedSectionsCount: undefined }),
    null,
    "C12.9: user_verified → null (no upload CTA needed; user typed it)",
  );
}

// ─── C13: CF-19 v2 source-threading + 4-state coverage ─────────────────────
function testC13_SourceThreadingAndNewStates(): void {
  console.log(`${TAG} C13: CF-19 v2 source-threading + 4-state coverage ...`);

  // C13.1: per-field entry.source overrides context.source (CRITICAL CF-19a fix)
  const canonicalInheritedEntry: FieldProvenanceEntry = {
    source: "canonical_inherited",
    confidence: 0.5,
    last_corroborated_at: "2026-05-04T12:00:00Z",
  };
  const result13_1 = decorateFieldFromEntry(2000, canonicalInheritedEntry, {
    sourceCount: 5, // canonical's verification_count >= 3
    source: "sbc_upload", // row-level source — should be IGNORED in favor of entry.source
    multiSourceThreshold: 3,
  });
  assertEq(
    result13_1.state,
    "candid_verified",
    "C13.1a: entry.source=canonical_inherited overrides context.source=sbc_upload → candid_verified",
  );
  assertEq(result13_1.reason, "community_corroborated", "C13.1b: reason matches corroborated path");

  // C13.2: when entry source is self/trusted but no provenance P-8, lands in hidden (parser_failure)
  // CF-19 v2: null provenance + self-source → hidden (page banner handles).
  const noSourceEntry: FieldProvenanceEntry = {
    source: "doc_extraction",
    confidence: 0.5,
    last_corroborated_at: "2026-05-04T12:00:00Z",
  };
  const result13_2 = decorateFieldFromEntry(2000, noSourceEntry, {
    sourceCount: 1,
    source: "sbc_upload",
    multiSourceThreshold: 3,
  });
  assertEq(result13_2.state, "hidden", "C13.2a: doc_extraction with null provenance → hidden");
  assertEq(result13_2.reason, "parser_failure", "C13.2b: reason = parser_failure");

  // C13.3: smart-skip pre-corroboration (canonical_inherited below threshold)
  // Session 72 v3: routes to "community" state.
  const result13_3 = decorateFieldFromEntry(2000, canonicalInheritedEntry, {
    sourceCount: 1,
    source: "sbc_upload",
    multiSourceThreshold: 3,
  });
  assertEq(result13_3.state, "community", "C13.3a: pre-corroboration → community");
  assertEq(result13_3.reason, "canonical_below_threshold", "C13.3b: reason = canonical_below_threshold");

  // C13.4: verbatim_absent → verified state with from_user_document_no_cite reason
  // CF-19 v2: collapsed found_in_document into verified. Backend reason preserves
  // cite-grade vs no-cite distinction for dispute-letter logic.
  const verbatimAbsentP8: PatternP8Provenance = {
    source_excerpt: "",
    source_excerpt_verified: "verbatim_absent",
    source_excerpt_extraction_method: "pdftotext",
    source_section_hint: "important_questions",
    source_section_verified: false,
  };
  const result13_4 = getDisplayState({
    provenance: verbatimAbsentP8,
    confidence: 0.5,
    sourceCount: 1,
    source: "doc_extraction",
    multiSourceThreshold: 3,
  });
  assertEq(result13_4.state, "user_verified", "C13.4a: verbatim_absent → upload (Session 72 v3)");
  assertEq(result13_4.reason, "from_user_document_no_cite", "C13.4b: reason discriminates for dispute-letter");

  // C13.5: cite-grade self-source → verified + cite-grade reason
  const citeGradeP8: PatternP8Provenance = {
    source_excerpt: "Out-of-pocket maximum: $3,000 individual",
    source_excerpt_verified: "verified",
    source_excerpt_extraction_method: "pdftotext",
    source_section_hint: "important_questions",
    source_section_verified: true,
  };
  const result13_5 = getDisplayState({
    provenance: citeGradeP8,
    confidence: 0.9,
    sourceCount: 1,
    source: "doc_extraction",
    multiSourceThreshold: 3,
  });
  assertEq(result13_5.state, "user_verified", "C13.5a: cite-grade self-source → upload (Session 72 v3)");
  assertEq(result13_5.reason, "from_user_document_cite_grade", "C13.5b: cite-grade reason preserved");

  // C13.6: candid_verified — corroboration met (with or without cite-grade)
  const result13_6 = getDisplayState({
    provenance: citeGradeP8,
    confidence: 0.9,
    sourceCount: 5,
    source: "canonical_inherited",
    multiSourceThreshold: 3,
  });
  assertEq(result13_6.state, "candid_verified", "C13.6a: corroborated → candid_verified");
  assertEq(result13_6.reason, "community_corroborated", "C13.6b: collapsed reason");

  // C13.7: SourceProvenance includes 'canonical_inherited' (added Session 64)
  const _sourceCheck: SourceProvenance = "canonical_inherited";
  void _sourceCheck;
  assert(true, "C13.7: SourceProvenance includes 'canonical_inherited'");
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
  testC8_IsDecoratedValue();
  testC9_AggregateRowState();
  testC10_VerbatimAbsentDerivation();
  testC11_ReparseContract();
  testC12_AffordanceRouting();
  testC13_SourceThreadingAndNewStates();
  console.log(`${TAG} ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.error(`${TAG} FAILURES — exiting non-zero`);
    process.exit(1);
  }
  console.log(`${TAG} All tests passed.`);
  process.exit(0);
}

main();
