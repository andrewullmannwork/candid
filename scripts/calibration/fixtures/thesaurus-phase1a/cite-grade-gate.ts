/**
 * A3 — read-layer cite-grade GATE fixture (no DB, no Haiku).
 *
 *   npx tsx scripts/calibration/fixtures/thesaurus-phase1a/cite-grade-gate.ts
 *
 * The deterministic consumer of the Step-2 identity stamp. Proves the §4.1 min():
 *   (1) getDisplayState caps an inferred-identity cell to `estimate` (even over candid_verified),
 *       preserves `hidden`, and is byte-identical when not inferred;
 *   (2) isCitationGrade returns false for an inferred cell WITH a verified excerpt (quote-suppress);
 *   (3) decorateFieldFromEntry derives identityInferred from the entry (resolution_source +
 *       identity_confirmed) gated on identityGateOn — and the CONFIRM-RELEASE invariant: the cap
 *       lifts the instant identity_confirmed === true.
 * routing.ts + identity-stamp-provenance.ts prove the WRITE; this proves the READ.
 */
import { getDisplayState, isCitationGrade, decorateFieldFromEntry } from "@/lib/parser/consumer-read";
import type { PatternP8Provenance } from "@/lib/parser/verify-source-excerpts";
import type { FieldProvenanceEntry } from "@/lib/parser/field-categories";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean): void {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.error(`  FAIL  ${name}`); }
}

console.log("A3 — read-layer cite-grade gate fixture\n");

// A cite-grade (verified verbatim) coverage provenance — would read user_verified + quotable today.
const citeGradeP8: PatternP8Provenance = {
  source_excerpt: "$20 copay for outpatient lab",
  source_excerpt_verified: "verified",
  source_excerpt_extraction_method: "pdftotext",
  source_section_hint: "COVERED_SERVICES",
  source_section_verified: true,
};
const boilerplateP8: PatternP8Provenance = { ...citeGradeP8, source_section_hint: "FOO_DO_NOT_EXTRACT" };

function ds(identityInferred: boolean, p8: PatternP8Provenance = citeGradeP8, over: { sourceCount?: number; source?: string } = {}) {
  return getDisplayState({
    provenance: p8,
    confidence: 0.9,
    sourceCount: over.sourceCount ?? 1,
    source: over.source ?? "doc_extraction",
    multiSourceThreshold: 3,
    identityInferred,
  });
}

// ── (1) getDisplayState min() cap ────────────────────────────────────────────
const direct = ds(false);
check("not-inferred cite-grade → user_verified (byte-identical)", direct.state === "user_verified" && direct.reason === "from_user_document_cite_grade");
const capped = ds(true);
check("inferred → capped to estimate", capped.state === "estimate");
check("inferred → reason inferred_synonym_identity", capped.reason === "inferred_synonym_identity");

// cap trumps cross-user corroboration (identity uncertainty beats coverage strength).
check("corroborated → candid_verified when not inferred", ds(false, citeGradeP8, { sourceCount: 5, source: "canonical_inherited" }).state === "candid_verified");
check("corroborated BUT inferred → still estimate (min)", ds(true, citeGradeP8, { sourceCount: 5, source: "canonical_inherited" }).state === "estimate");

// hidden is preserved — never resurrect boilerplate/parser-failure to estimate.
check("boilerplate stays hidden even when inferred", ds(true, boilerplateP8).state === "hidden");

// ── (2) isCitationGrade quote-suppression ────────────────────────────────────
check("isCitationGrade true for verified excerpt (no opts)", isCitationGrade(citeGradeP8) === true);
check("isCitationGrade true when identityInferred false", isCitationGrade(citeGradeP8, { identityInferred: false }) === true);
check("isCitationGrade FALSE when identityInferred (suppress quote despite verified excerpt)", isCitationGrade(citeGradeP8, { identityInferred: true }) === false);

// ── (3) decorateFieldFromEntry derivation + CONFIRM-RELEASE ──────────────────
const baseEntry: FieldProvenanceEntry = {
  source: "doc_extraction",
  confidence: 0.9,
  last_corroborated_at: "2026-06-26T00:00:00.000Z",
  source_excerpt: "$20 copay for outpatient lab",
  source_excerpt_verified: "verified",
  source_excerpt_extraction_method: "pdftotext",
  source_section_hint: "COVERED_SERVICES",
  source_section_verified: true,
};
const entryInferred: FieldProvenanceEntry = { ...baseEntry, resolution_source: "signature_cache" };
const entryConfirmed: FieldProvenanceEntry = { ...baseEntry, resolution_source: "signature_cache", identity_confirmed: true };
const entryDirect: FieldProvenanceEntry = { ...baseEntry };

function dec(entry: FieldProvenanceEntry, identityGateOn: boolean) {
  return decorateFieldFromEntry(20 as number | null, entry, {
    sourceCount: 1,
    source: "doc_extraction",
    multiSourceThreshold: 3,
    identityGateOn,
  });
}

check("entry: inferred + gate ON → estimate", dec(entryInferred, true).state === "estimate");
check("entry: inferred + gate OFF → user_verified (byte-identical)", dec(entryInferred, false).state === "user_verified");
check("entry: CONFIRM-RELEASE — identity_confirmed lifts the cap → user_verified", dec(entryConfirmed, true).state === "user_verified");
check("entry: no resolution_source + gate ON → user_verified (only synonym cells gated)", dec(entryDirect, true).state === "user_verified");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
