/**
 * Service Thesaurus harness — fixture (Ship Gate G4). Verifies score.ts on synthetic
 * GT + snapshots with hand-computed expected values. Zero DB, zero Haiku.
 * Run: npx tsx scripts/calibration/thesaurus/fixture.ts
 */
import { buildScoreCard, validateSnapshot, scoredResolvedFraction } from "./score";
import type { GtService, ForwardMapEntry, StoredCanonical, CohortSnapshot, B5Counts } from "./types";
import { deriveModifiers } from "@/lib/claims/service-resolver";
import { buildTupleScoreCard, type DecodeMap } from "./score-tuple";

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

// ── RUN 4 (S170 hardening B): output-validity gate — the degenerate-run guard that caught the S170
// false-pass (empty ANTHROPIC_API_KEY → all-null forward → fake B2 98.5% on a collapsed denominator).
// validateSnapshot must flag an all-null snapshot INVALID while a healthy one validates. Committed as a
// regression test (a throwaway manual fault-inject would not protect it). ──
const degenerateFwd: ForwardMapEntry[] = baseFwd.map((f) => ({ ...f, resolvedSlug: null, source: "none", confidence: 0, needsReview: true }));
const cDegen = buildScoreCard({ phaseLabel: "fixture-degenerate", gtVersion: "fix-v1", gt, forward: degenerateFwd, stored, cohorts, baselineB5, currentB5: baselineB5 });
console.log("RUN 4 — output-validity gate (S170 hardening B)");
eq("degenerate snapshot → INVALID", validateSnapshot(cDegen, gt).valid ? 1 : 0, 0);
eq("healthy snapshot (c1) → valid", validateSnapshot(c1, gt).valid ? 1 : 0, 1);
eq("degenerate scored-resolved fraction = 0", scoredResolvedFraction(gt, degenerateFwd).fraction, 0);
eq("healthy scored-resolved fraction = 7/8", scoredResolvedFraction(gt, baseFwd).fraction, 7 / 8);

// ── RUN 5 (S209): B1-stored rename-awareness. An OLD-vocab oracle slug whose merged_into_id identity is
// present in stored is a HIT (parity with B1-forward/B2). Raw `.has(correctSlug)` would mark it MISSING
// (the ~15pp understatement the after-372 oracle exposed). Also proves a genuinely-absent slug stays a miss.
const gtRen: GtService[] = [
  { id: "R#1", docId: "R", insurer: "BCBS", docType: "sbc", planYear: 2026, canonicalPlanId: "canR", serviceName: "Inpatient hospital", correctSlug: "inpatient_facility", adjudicationStatus: "andrew" },
  { id: "R#2", docId: "R", insurer: "BCBS", docType: "sbc", planYear: 2026, canonicalPlanId: "canR", serviceName: "Acupuncture", correctSlug: "acupuncture", adjudicationStatus: "andrew" },
];
const fwdRen: ForwardMapEntry[] = [
  { gtId: "R#1", resolvedSlug: "hospital_admission", conceptId: null, confidence: 0.9, source: "haiku", needsReview: false },
  { gtId: "R#2", resolvedSlug: "acupuncture", conceptId: null, confidence: 0.9, source: "haiku", needsReview: false },
];
const storedRen: StoredCanonical[] = [{ canonicalPlanId: "canR", slugs: ["hospital_admission"] }]; // has the renamed identity; lacks acupuncture
const cRen = buildScoreCard({ phaseLabel: "fixture-rename-stored", gtVersion: "fix-v1", gt: gtRen, forward: fwdRen, stored: storedRen, cohorts: [], baselineB5: {}, currentB5: {}, renameMap: { inpatient_facility: "hospital_admission" }, oldSlugs: new Set(["inpatient_facility"]) });
console.log("RUN 5 — B1-stored rename-awareness (S209)");
eq("rename-aware b1Stored = 1/2 (R#1 renamed-hit; R#2 genuinely absent)", cRen.b1Stored.recall, 1 / 2);

// ── RUN 6 (S226 / A2b Phase 2): deriveModifiers — Pattern-S place/component + the inpatient
// physician/surgeon multi-label umbrella. Tested on CANONICAL federal-SBC strings (independent of the GT
// rows → circularity firewall) + negatives: office visits → global; MH/transplant → no umbrella. ──
console.log("RUN 6 — deriveModifiers (A2b Phase 2 modifier emission)");
const dm = (s: string) => deriveModifiers(s);
const hasUmbrella = (s: string) => (dm(s).multiLabel ? 1 : 0);
// clean single-tuple cases (federal template strings)
eq("inpatient facility/room → place", dm("Facility fee (e.g., hospital room)").placeOfService, "inpatient_facility");
eq("inpatient facility/room → component", dm("Facility fee (e.g., hospital room)").component, "facility");
eq("ASC facility → place", dm("Facility fee (e.g., ambulatory surgery center)").placeOfService, "independent_facility");
eq("ASC facility → component", dm("Facility fee (e.g., ambulatory surgery center)").component, "facility");
eq("outpatient surgeon → place", dm("Physician/surgeon fees (outpatient)").placeOfService, "outpatient_facility");
eq("outpatient surgeon → component", dm("Physician/surgeon fees (outpatient)").component, "professional");
eq("outpatient surgeon → NOT umbrella", hasUmbrella("Physician/surgeon fees (outpatient)"), 0);
eq("inpatient surgeon fee → component", dm("Hospital stay: Surgeon fee").component, "professional");
eq("inpatient surgeon fee → place", dm("Hospital stay: Surgeon fee").placeOfService, "inpatient_facility");
eq("inpatient surgeon fee → NOT umbrella (no physician)", hasUmbrella("Hospital stay: Surgeon fee"), 0);
eq("inpatient physician visits → component", dm("Hospital stay: Physician Visits").component, "professional");
eq("inpatient physician visits → NOT umbrella (no surgeon)", hasUmbrella("Hospital stay: Physician Visits"), 0);
// the MIXED umbrella → multi-label SET {surgery·prof·inpt, hospital_admission·prof·inpt}
const mix = dm("Physician/surgeon fees (inpatient)");
eq("umbrella → multiLabel size 2", mix.multiLabel?.length ?? 0, 2);
eq("umbrella → surgery member", mix.multiLabel?.some((m) => m.slug === "surgery" && m.component === "professional" && m.placeOfService === "inpatient_facility") ? 1 : 0, 1);
eq("umbrella → hospital_admission member", mix.multiLabel?.some((m) => m.slug === "hospital_admission" && m.component === "professional" && m.placeOfService === "inpatient_facility") ? 1 : 0, 1);
eq("umbrella alt phrasing (physician or surgeon services inpatient)", dm("Physician or surgeon services in an inpatient facility").multiLabel?.length ?? 0, 2);
// negatives — generic office visits stay (any, global): no over-fire
eq("primary care visit → global", dm("Primary care visit to treat an injury or illness").component, "global");
eq("primary care visit → any", dm("Primary care visit to treat an injury or illness").placeOfService, "any");
eq("specialist visit → global", dm("Specialist visit").component, "global");
// negatives — MH + transplant must NOT become the surgery/hospital_admission umbrella (the Step-1 guards)
eq("autism inpatient doctor/surgeon → NOT umbrella (MH guard)", hasUmbrella("Autism Spectrum Disorder Services — Inpatient Doctor/Surgeon Fee"), 0);
eq("transplant phys/surgeon inpatient → NOT umbrella (transplant guard)", hasUmbrella("Transplant — Physician/surgeon inpatient services"), 0);
// ── RUN 6b (A2b Phase 2 S228 / Andrew D1): facility component = the WORD "facility" as a billing label,
// NOT a place-type name. ASC is a LOCATION (place), never a component cue. ──
// Type-A POSITIVES — carrier text labels the facility component → read it (Option-1):
eq("transplant facility → component (text-labeled)", dm("Transplant services — Special transplant facility inpatient services").component, "facility");
eq("transplant facility → place inpatient", dm("Transplant services — Special transplant facility inpatient services").placeOfService, "inpatient_facility");
eq("transplant facility → NOT umbrella (transplant guard)", hasUmbrella("Transplant services — Special transplant facility inpatient services"), 0);
eq("delivery facility services → component", dm("Childbirth/delivery facility services").component, "facility");
eq("ER (facility) tag → component", dm("Emergency room services (facility)").component, "facility");
// D3 — hospital OPD is a DISTINCT place from a freestanding ASC (both real, different cost-share):
eq("OPD facility fee → place outpatient (not independent)", dm("Facility fee — Outpatient Department of a Hospital: surgery").placeOfService, "outpatient_facility");
eq("OPD facility fee → component facility", dm("Facility fee — Outpatient Department of a Hospital: surgery").component, "facility");
// D1 KEY NEGATIVES — a place-name is NOT a component; facility-by-structure defers to Option-3:
eq("bare ASC name → place independent", dm("Hospital Services — Ambulatory Surgical Center").placeOfService, "independent_facility");
eq("bare ASC name → component GLOBAL (not facility — structural)", dm("Hospital Services — Ambulatory Surgical Center").component, "global");
eq("'at a Plan Facility' place-word → component global", dm("Hemodialysis and peritoneal dialysis treatment at a Plan Facility").component, "global");
eq("physician services IN a facility → professional (guard)", dm("Physician services in an inpatient facility").component, "professional");
eq("sterilization (ASC place annotation) → component global", dm("Sterilization procedures (outpatient/ambulatory surgical center)").component, "global");

// ── RUN 7 (S226 / A2b Phase 2): score-tuple.ts — full-tuple match, the modifiers|slug conditional,
// the umbrella exact-set-match (mixed detection), under-detection, and canon-awareness. ──
const mk = (id: string, correctSlug: string | null, extra: Partial<GtService> = {}): GtService =>
  ({ id, docId: "T", insurer: "X", docType: "sbc", planYear: 2026, canonicalPlanId: null, serviceName: id, correctSlug, adjudicationStatus: "andrew", ...extra });
const umbrella = [
  { slug: "surgery", placeOfService: "inpatient_facility", component: "professional" as const },
  { slug: "hospital_admission", placeOfService: "inpatient_facility", component: "professional" as const },
];
const gtTup: GtService[] = [
  mk("T#1", "inpatient_facility"),                          // single → decode hospital_admission·facility·inpatient
  mk("T#2", "outpatient_surgery_physician"),               // single → decode surgery·professional·outpatient
  mk("T#3", "inpatient_physician", { multiLabel: umbrella }), // umbrella (set match)
  mk("T#4", "inpatient_physician", { multiLabel: umbrella }), // umbrella (resolver under-detects)
];
const fwdTup: ForwardMapEntry[] = [
  { gtId: "T#1", resolvedSlug: "hospital_admission", conceptId: null, confidence: 0.95, source: "signature_cache", needsReview: false, placeOfService: "inpatient_facility", component: "facility" },
  { gtId: "T#2", resolvedSlug: "surgery", conceptId: null, confidence: 0.95, source: "signature_cache", needsReview: false, placeOfService: "outpatient_facility", component: "global" }, // wrong component
  { gtId: "T#3", resolvedSlug: "hospital_admission", conceptId: null, confidence: 0.9, source: "signature_cache", needsReview: false, placeOfService: "inpatient_facility", component: "professional", multiLabel: umbrella },
  { gtId: "T#4", resolvedSlug: "hospital_admission", conceptId: null, confidence: 0.9, source: "signature_cache", needsReview: false, placeOfService: "inpatient_facility", component: "professional" }, // no multiLabel → under-detect
];
const decodeTup: DecodeMap = {
  inpatient_facility: { slug: "hospital_admission", placeOfService: "inpatient_facility", component: "facility" },
  outpatient_surgery_physician: { slug: "surgery", placeOfService: "outpatient_facility", component: "professional" },
};
const ct = buildTupleScoreCard({ gt: gtTup, forward: fwdTup, decodeMap: decodeTup });
console.log("RUN 7 — score-tuple.ts (A2b Phase 2 tuple scoring)");
eq("tuple: singleTotal", ct.all.singleTotal, 2);
eq("tuple: fullMatch (T#1 only; T#2 wrong component)", ct.all.fullMatch, 1);
eq("tuple: componentMatch", ct.all.componentMatch, 1);
eq("tuple: placeMatch (both)", ct.all.placeMatch, 2);
eq("tuple: slugCorrect (both)", ct.all.slugCorrect, 2);
eq("tuple: modifierCorrectGivenSlug (T#1)", ct.all.modifierCorrectGivenSlug, 1);
eq("tuple: multiTotal", ct.all.multiTotal, 2);
eq("tuple: setMatch (T#3; T#4 under-detect)", ct.all.setMatch, 1);
eq("tuple: cluster == all (all 4 cluster slugs)", ct.cluster.singleTotal + ct.cluster.multiTotal, 4);
eq("tuple: misses (T#2 component + T#4 under-detect)", ct.misses.length, 2);
// canon-awareness: an un-canon'd resolver slug (inpatient_facility) must full-match via rename-map.
const ctRen = buildTupleScoreCard({
  gt: [mk("R#1", "inpatient_facility")],
  forward: [{ gtId: "R#1", resolvedSlug: "inpatient_facility", conceptId: null, confidence: 0.9, source: "signature_cache", needsReview: false, placeOfService: "inpatient_facility", component: "facility" }],
  decodeMap: decodeTup, renameMap: { inpatient_facility: "hospital_admission" },
});
eq("tuple canon: un-canon'd resolver slug full-matches", ctRen.all.fullMatch, 1);

console.log(`\n${fail === 0 ? "✓ ALL PASS" : "✗ FAILURES"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
