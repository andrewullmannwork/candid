/**
 * Service Thesaurus harness — fixture (Ship Gate G4). Verifies score.ts on synthetic
 * GT + snapshots with hand-computed expected values. Zero DB, zero Haiku.
 * Run: npx tsx scripts/calibration/thesaurus/fixture.ts
 */
import { buildScoreCard } from "./score";
import type { GtService, ForwardMapEntry, StoredCanonical, CohortSnapshot, B5Counts } from "./types";

let pass = 0, fail = 0;
const approx = (a: number, b: number, t = 1e-6) => Math.abs(a - b) <= t;
function eq(label: string, got: unknown, want: unknown) {
  const ok = approx(Number(got), Number(want)) || got === want;
  if (ok) { pass++; } else { fail++; console.log(`  ✗ ${label}: got ${got}, want ${want}`); }
}

// ── synthetic GT: 10 entries, 2 docs, 2 insurers, 2 doc types ──
const gt: GtService[] = [
  { id: "A#1", docId: "A", insurer: "Anthem", docType: "sbc", planYear: 2026, canonicalPlanId: "canA", serviceName: "Primary care visit", correctSlug: "office_visit_primary", adjudicationStatus: "andrew" },
  { id: "A#2", docId: "A", insurer: "Anthem", docType: "sbc", planYear: 2026, canonicalPlanId: "canA", serviceName: "Outpatient lab work", correctSlug: "lab_outpatient", adjudicationStatus: "andrew" },
  { id: "A#3", docId: "A", insurer: "Anthem", docType: "sbc", planYear: 2026, canonicalPlanId: "canA", serviceName: "MRI brain", correctSlug: "advanced_imaging", adjudicationStatus: "auto" },
  { id: "A#4", docId: "A", insurer: "Anthem", docType: "sbc", planYear: 2026, canonicalPlanId: "canA", serviceName: "Hyperbaric oxygen therapy", correctSlug: null, adjudicationStatus: "andrew" },
  { id: "A#5", docId: "A", insurer: "Anthem", docType: "sbc", planYear: 2026, canonicalPlanId: "canA", serviceName: "Pediatric dental", correctSlug: "pediatric_dental", adjudicationStatus: "andrew", isNegativePair: true, negativePartnerIds: ["A#6"] },
  { id: "A#6", docId: "A", insurer: "Anthem", docType: "sbc", planYear: 2026, canonicalPlanId: "canA", serviceName: "Dental", correctSlug: "dental", adjudicationStatus: "andrew", isNegativePair: true, negativePartnerIds: ["A#5"] },
  { id: "B#7", docId: "B", insurer: "Cigna", docType: "eoc", planYear: 2026, canonicalPlanId: "canB", serviceName: "Specialist visit", correctSlug: "specialist_visit", adjudicationStatus: "andrew" },
  { id: "B#8", docId: "B", insurer: "Cigna", docType: "eoc", planYear: 2026, canonicalPlanId: "canB", serviceName: "Garbled OCR xyz", correctSlug: null, adjudicationStatus: "andrew", notFound: true },
  { id: "B#9", docId: "B", insurer: "Cigna", docType: "eoc", planYear: 2026, canonicalPlanId: "canB", serviceName: "Acupuncture", correctSlug: "acupuncture", adjudicationStatus: "auto" },
  { id: "B#10", docId: "B", insurer: "Cigna", docType: "eoc", planYear: 2026, canonicalPlanId: "canB", serviceName: "Annual physical", correctSlug: "preventive_care", adjudicationStatus: "andrew" },
];

const baseFwd: ForwardMapEntry[] = [
  { gtId: "A#1", resolvedSlug: "office_visit_primary", conceptId: null, confidence: 0.95, source: "trigram_exact", needsReview: false },
  { gtId: "A#2", resolvedSlug: "lab_outpatient", conceptId: null, confidence: 0.9, source: "haiku", needsReview: false },
  { gtId: "A#3", resolvedSlug: "advanced_imaging", conceptId: null, confidence: 0.88, source: "haiku", needsReview: false },
  { gtId: "A#4", resolvedSlug: null, conceptId: null, confidence: 0, source: "none", needsReview: true },
  { gtId: "A#5", resolvedSlug: "pediatric_dental", conceptId: null, confidence: 0.9, source: "haiku", needsReview: false },
  { gtId: "A#6", resolvedSlug: "dental", conceptId: null, confidence: 0.9, source: "haiku", needsReview: false },
  { gtId: "B#7", resolvedSlug: "specialist_visit", conceptId: null, confidence: 0.92, source: "trigram_exact", needsReview: false },
  { gtId: "B#9", resolvedSlug: "acupuncture", conceptId: null, confidence: 0.85, source: "haiku", needsReview: false },
  { gtId: "B#10", resolvedSlug: null, conceptId: null, confidence: 0, source: "none", needsReview: true }, // the annual-physical gap
];

const stored: StoredCanonical[] = [
  { canonicalPlanId: "canA", slugs: ["office_visit_primary", "lab_outpatient", "advanced_imaging", "pediatric_dental", "dental"] },
  { canonicalPlanId: "canB", slugs: ["specialist_visit", "acupuncture"] }, // missing preventive_care
];

const cohorts: CohortSnapshot[] = [
  { cohortId: "c1", plans: [
    { canonicalPlanId: "P1", planName: "P1", insurer: "Anthem", coveredSlugs: ["office_visit_primary", "lab_outpatient", "advanced_imaging"], inferredSlugs: [] },
    { canonicalPlanId: "P2", planName: "P2", insurer: "Cigna", coveredSlugs: ["office_visit_primary", "specialist_visit"], inferredSlugs: ["preventive_care"] },
    { canonicalPlanId: "P3", planName: "P3", insurer: "Oscar", coveredSlugs: ["office_visit_primary", "lab_outpatient"], inferredSlugs: [] },
  ] },
];

const baselineB5: B5Counts = { office_visit_primary: 100, lab_outpatient: 100, advanced_imaging: 100 };
const currentB5: B5Counts = { office_visit_primary: 100, lab_outpatient: 300, advanced_imaging: 105, new_slug: 40 };

// ── RUN 1: baseline (no ledger) ──
const c1 = buildScoreCard({ phaseLabel: "fixture-baseline", gtVersion: "fix-v1", gt, forward: baseFwd, stored, cohorts, baselineB5, currentB5: baselineB5 });
console.log("RUN 1 — baseline metrics");
eq("corpus.totalGt", c1.corpus.totalGt, 10);
eq("corpus.scored", c1.corpus.scored, 8);
eq("corpus.noConcept", c1.corpus.noConcept, 1);
eq("corpus.negativePairs", c1.corpus.negativePairs, 2);
eq("corpus.notFound", c1.corpus.notFound, 1);
eq("corpus.andrewAdjudicated", c1.corpus.andrewAdjudicated, 8);
eq("b1Forward.recall", c1.b1Forward.recall, 7 / 8);
eq("b1Forward.byDocType.sbc.recall", c1.b1Forward.byDocType.sbc.recall, 1.0);
eq("b1Forward.byDocType.eoc.recall", c1.b1Forward.byDocType.eoc.recall, 2 / 3);
eq("b1Stored.recall", c1.b1Stored.recall, 7 / 8);
eq("b2.precision", c1.b2Precision.precision, 1.0);
eq("b2.mappedAndrew", c1.b2Precision.mappedAndrew, 5);
eq("b2.falsePositiveRate", c1.b2Precision.falsePositiveRate, 0);
eq("b2.noConceptAndrew", c1.b2Precision.noConceptAndrew, 1);
eq("b2.negativePairViolations", c1.b2Precision.negativePairViolations, 0);
eq("b3.totalCells", c1.b3.totalCells, 15);
eq("b3.unkWithout", c1.b3.unkWithout, 8);
eq("b3.unkWith", c1.b3.unkWith, 7);
eq("b3.gapRateWithoutBackstop", c1.b3.gapRateWithoutBackstop, 8 / 15);
eq("b3.gapRateWithBackstop", c1.b3.gapRateWithBackstop, 7 / 15);
eq("ledger empty (no baseline)", c1.ledger.counts.regressions, 0);

// ── RUN 2: a phase run — g3 regresses (advanced_imaging→null), g10 improves (null→preventive_care) ──
const curFwd: ForwardMapEntry[] = baseFwd.map((f) => ({ ...f }));
// S169: regress an ANDREW entry — the ledger is andrew-only since S168, so an `auto` entry's
// regression is correctly NOT counted. The old pick (A#3, auto) left this fixture red on main.
curFwd.find((f) => f.gtId === "A#2")!.resolvedSlug = null; // regression (andrew: lab_outpatient → null)
curFwd.find((f) => f.gtId === "B#10")!.resolvedSlug = "preventive_care"; // improvement (andrew)
const c2 = buildScoreCard({ phaseLabel: "fixture-phase", gtVersion: "fix-v1", gt, forward: curFwd, baselineForward: baseFwd, stored, cohorts, baselineB5, currentB5 });
console.log("RUN 2 — ledger + over-collapse");
eq("ledger.regressions", c2.ledger.counts.regressions, 1);
eq("ledger.regression is A#2", c2.ledger.regressions[0]?.gtId, "A#2");
eq("ledger.improvements", c2.ledger.counts.improvements, 1);
eq("ledger.improvement is B#10", c2.ledger.improvements[0]?.gtId, "B#10");
eq("ledger.newlyMapped", c2.ledger.counts.newlyMapped, 0);
eq("ledger.lost", c2.ledger.counts.lost, 0);
eq("overCollapse count", c2.overCollapse.length, 2);
eq("overCollapse[0] slug (highest current)", c2.overCollapse[0]?.slug, "lab_outpatient");
eq("overCollapse includes new_slug", c2.overCollapse.some((o) => o.slug === "new_slug") ? 1 : 0, 1);

// ── RUN 3 (S169): acceptable-alternatives — resolver lands on an acceptable alt, NOT the primary slug ──
// E#1 is genuinely ambiguous (eye-specialist visit: specialist_visit OR medical_eye_care) → resolver's
// medical_eye_care must score CORRECT. E#2 is a plain specialist visit (NO acceptable alt) → the same
// medical_eye_care must score WRONG (the acceptable set must not leak across entries).
const gtAlt: GtService[] = [
  { id: "E#1", docId: "E", insurer: "Kaiser", docType: "eoc", planYear: 2026, canonicalPlanId: "canE", serviceName: "Eye specialist visit", correctSlug: "specialist_visit", acceptableSlugs: ["medical_eye_care"], adjudicationStatus: "andrew" },
  { id: "E#2", docId: "E", insurer: "Kaiser", docType: "eoc", planYear: 2026, canonicalPlanId: "canE", serviceName: "Cardiology specialist visit", correctSlug: "specialist_visit", adjudicationStatus: "andrew" },
];
const fwdAlt: ForwardMapEntry[] = [
  { gtId: "E#1", resolvedSlug: "medical_eye_care", conceptId: null, confidence: 0.9, source: "haiku", needsReview: false }, // acceptable alt → CORRECT
  { gtId: "E#2", resolvedSlug: "medical_eye_care", conceptId: null, confidence: 0.9, source: "haiku", needsReview: false }, // not acceptable for E#2 → WRONG
];
const c3 = buildScoreCard({ phaseLabel: "fixture-altslug", gtVersion: "fix-v1", gt: gtAlt, forward: fwdAlt, stored: [], cohorts: [], baselineB5: {}, currentB5: {} });
console.log("RUN 3 — acceptable-alternatives (S169)");
eq("alt: mappedAndrew", c3.b2Precision.mappedAndrew, 2);
eq("alt: correct (E#1 via acceptable; E#2 wrong)", c3.b2Precision.correct, 1);
eq("alt: precision 1/2", c3.b2Precision.precision, 0.5);
eq("alt: stillWrong count", c3.threeWay.stillWrong.count, 1);
eq("alt: stillWrong is E#2", c3.threeWay.stillWrong.sample[0]?.gtId, "E#2");

console.log(`\n${fail === 0 ? "✓ ALL PASS" : "✗ FAILURES"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
