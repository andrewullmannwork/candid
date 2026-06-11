/**
 * Thesaurus Phase 1a — P2 T1 type-emission logic fixture (no DB, no Haiku).
 *
 *   npx tsx scripts/calibration/fixtures/thesaurus-phase1a/type-emission.ts
 *
 * Proves the pure parse core (`parseMedicalNecessityCriteria` + the content-type coercion):
 *   1. Each valid type (clinical_criterion / prior_auth / admin_provision) threads through.
 *   2. type_confidence threads when a valid number in [0,1]; null otherwise (with a valid type).
 *   3. FAIL-TOWARD-TODAY: a missing OR invalid type → clinical_criterion @ type_confidence 0 (so the
 *      router's confidence-gate catches it; zero regression vs post-D1).
 *   4. The both-facts SPLIT (C1/C2): two raw entries from one passage → two typed criteria with the
 *      SAME slug and DISTINCT fact-scoped excerpts.
 *   5. Existing invariants preserved: no criteria_text → dropped; excerpt sliced to 200; static
 *      provenance fields unchanged; undefined input → [].
 */
import { parseMedicalNecessityCriteria } from "@/lib/eoc/haiku-prompts/medical-necessity";
import type { ExtractionMethod } from "@/lib/parser/types";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean): void {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.error(`  FAIL  ${name}`);
  }
}

console.log("P2 T1 — medical_necessity type-emission logic fixture\n");

const EM: ExtractionMethod = "pdftotext";

// ── each valid type threads through ──────────────────────────────────────────
const valid = parseMedicalNecessityCriteria(
  [
    { type: "clinical_criterion", type_confidence: 0.95, service_slug_hint: "bariatric_surgery", criteria_text: "medically necessary when BMI >= 40", source_excerpt: "medically necessary when BMI >= 40", diagnosis_qualifiers: ["E66.01"] },
    { type: "prior_auth", type_confidence: 0.9, service_slug_hint: "durable_medical_equipment", criteria_text: "DME requires prior authorization", source_excerpt: "requires prior authorization" },
    { type: "admin_provision", type_confidence: 0.7, service_slug_hint: null, criteria_text: "services outside the service area are not covered except emergencies", source_excerpt: "outside the service area" },
  ],
  EM,
);
check("3 valid entries parsed", valid.length === 3);
check("clinical_criterion threads (type + conf)", valid[0].type === "clinical_criterion" && valid[0].type_confidence === 0.95);
check("prior_auth threads", valid[1].type === "prior_auth" && valid[1].type_confidence === 0.9);
check("admin_provision threads (null slug ok)", valid[2].type === "admin_provision" && valid[2].service_slug_hint === null);
check("diagnosis_qualifiers thread", valid[0].diagnosis_qualifiers.length === 1 && valid[0].diagnosis_qualifiers[0] === "E66.01");

// ── fail-toward-today default (missing / invalid type) ───────────────────────
const degraded = parseMedicalNecessityCriteria(
  [
    { type_confidence: 0.95, criteria_text: "covered when X", source_excerpt: "covered when X" }, // no type
    { type: "not_a_type", type_confidence: 0.95, criteria_text: "covered when Y", source_excerpt: "covered when Y" }, // invalid string
    { type: 123, type_confidence: 0.95, criteria_text: "covered when Z", source_excerpt: "covered when Z" }, // non-string
  ],
  EM,
);
check("missing type -> clinical_criterion @ conf 0", degraded[0].type === "clinical_criterion" && degraded[0].type_confidence === 0);
check("invalid string type -> clinical_criterion @ conf 0", degraded[1].type === "clinical_criterion" && degraded[1].type_confidence === 0);
check("non-string type -> clinical_criterion @ conf 0", degraded[2].type === "clinical_criterion" && degraded[2].type_confidence === 0);

// ── type_confidence validation (with a VALID type) ───────────────────────────
const conf = parseMedicalNecessityCriteria(
  [
    { type: "prior_auth", type_confidence: 1.5, criteria_text: "a", source_excerpt: "a" }, // > 1
    { type: "prior_auth", type_confidence: -0.1, criteria_text: "b", source_excerpt: "b" }, // < 0
    { type: "prior_auth", type_confidence: "high", criteria_text: "c", source_excerpt: "c" }, // non-number
    { type: "prior_auth", criteria_text: "d", source_excerpt: "d" }, // missing
    { type: "prior_auth", type_confidence: 0, criteria_text: "e", source_excerpt: "e" }, // 0 is valid
  ],
  EM,
);
check("type_confidence > 1 -> null (type kept)", conf[0].type === "prior_auth" && conf[0].type_confidence === null);
check("type_confidence < 0 -> null", conf[1].type_confidence === null);
check("type_confidence non-number -> null", conf[2].type_confidence === null);
check("type_confidence missing -> null", conf[3].type_confidence === null);
check("type_confidence 0 with valid type -> 0, NOT defaulted away", conf[4].type_confidence === 0 && conf[4].type === "prior_auth");

// ── the both-facts split (C1/C2) ─────────────────────────────────────────────
const split = parseMedicalNecessityCriteria(
  [
    { type: "clinical_criterion", type_confidence: 0.96, service_slug_hint: "bariatric_surgery", criteria_text: "medically necessary when BMI >= 40", source_excerpt: "medically necessary when BMI >= 40" },
    { type: "prior_auth", type_confidence: 0.98, service_slug_hint: "bariatric_surgery", criteria_text: "Coverage requires prior authorization.", source_excerpt: "Coverage requires prior authorization" },
  ],
  EM,
);
check("split: two entries", split.length === 2);
check("split: same slug on both", split[0].service_slug_hint === "bariatric_surgery" && split[1].service_slug_hint === "bariatric_surgery");
check("split: distinct types", split[0].type === "clinical_criterion" && split[1].type === "prior_auth");
check("split: fact-scoped excerpts differ", split[0].source_excerpt !== split[1].source_excerpt);

// ── pa_polarity (C5) + place_of_service axis (C6) ────────────────────────────
const polarity = parseMedicalNecessityCriteria(
  [
    { type: "prior_auth", type_confidence: 0.95, pa_polarity: "requires", service_slug_hint: "dme", criteria_text: "DME requires prior authorization", source_excerpt: "requires prior authorization" },
    { type: "prior_auth", type_confidence: 0.9, pa_polarity: "waived", service_slug_hint: "obgyn", criteria_text: "You do not need prior authorization for OB/GYN", source_excerpt: "do not need prior authorization" },
    { type: "prior_auth", type_confidence: 0.8, service_slug_hint: "x", criteria_text: "requires precertification", source_excerpt: "requires precertification" }, // missing polarity
    { type: "prior_auth", type_confidence: 0.8, pa_polarity: "bogus", service_slug_hint: "y", criteria_text: "z", source_excerpt: "z" }, // invalid polarity
    { type: "clinical_criterion", type_confidence: 0.9, pa_polarity: "requires", criteria_text: "covered when X", source_excerpt: "covered when X" }, // polarity ignored for non-PA
  ],
  EM,
);
check("pa_polarity requires threads", polarity[0].pa_polarity === "requires");
check("pa_polarity waived threads (negation STAYS prior_auth)", polarity[1].type === "prior_auth" && polarity[1].pa_polarity === "waived");
check("prior_auth missing polarity -> null (fail-toward-safe)", polarity[2].pa_polarity === null);
check("prior_auth invalid polarity -> null", polarity[3].pa_polarity === null);
check("non-PA ignores pa_polarity -> null", polarity[4].type === "clinical_criterion" && polarity[4].pa_polarity === null);
check("non-axis fact -> place_of_service null", polarity[0].place_of_service === null);

// ── axis carve-out (C6): broad axis fact + per-service exception ──────────────
const carveout = parseMedicalNecessityCriteria(
  [
    { type: "prior_auth", type_confidence: 0.95, pa_polarity: "requires", place_of_service: "Inpatient", service_slug_hint: null, criteria_text: "All inpatient admissions require precertification", source_excerpt: "All inpatient admissions require precertification" },
    { type: "prior_auth", type_confidence: 0.92, pa_polarity: "waived", place_of_service: "inpatient", service_slug_hint: "maternity_care", criteria_text: "except inpatient maternity stays", source_excerpt: "except inpatient maternity stays" },
  ],
  EM,
);
check("axis fact: POS normalized lowercase, null slug, requires", carveout[0].place_of_service === "inpatient" && carveout[0].service_slug_hint === null && carveout[0].pa_polarity === "requires");
check("carve-out exception: service + axis + waived", carveout[1].service_slug_hint === "maternity_care" && carveout[1].place_of_service === "inpatient" && carveout[1].pa_polarity === "waived");

// ── existing invariants preserved ────────────────────────────────────────────
const noText = parseMedicalNecessityCriteria([{ type: "prior_auth", source_excerpt: "x" }], EM);
check("no criteria_text -> dropped", noText.length === 0);

const sliced = parseMedicalNecessityCriteria([{ type: "clinical_criterion", criteria_text: "x", source_excerpt: "z".repeat(500) }], EM);
check("source_excerpt sliced to 200", sliced[0].source_excerpt.length === 200);
check(
  "static provenance fields preserved",
  sliced[0].source_section_hint === "medical_necessity" &&
    sliced[0].source_excerpt_verified === "not_found" &&
    sliced[0].source_excerpt_extraction_method === EM,
);

check("undefined input -> []", parseMedicalNecessityCriteria(undefined, EM).length === 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
