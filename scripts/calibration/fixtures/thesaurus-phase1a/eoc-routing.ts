/**
 * Thesaurus Phase 1a — P2 T2 routing logic fixture (no DB, no Haiku).
 *
 *   npx tsx scripts/calibration/fixtures/thesaurus-phase1a/eoc-routing.ts
 *
 * Proves the pure `routeCriterion` decision (the store every criterion routes to):
 *   1. Flag OFF → byte-identical post-D1 (type IGNORED: valid→coverage_rules, unknown→enqueue, none→drop).
 *   2. Flag ON → route by type (admin→metadata, clinical→coverage_rules, PA→column/facts).
 *   3. The user-visible `pa_column` is reached ONLY by prior_auth · requires · service-specific · slug
 *      resolved · confidence ≥ floor. Waived / uncertain / axis / no-slug / low-conf → `pa_facts`.
 *   4. Two correct-by-construction invariants: a waived/uncertain PA can NEVER reach `pa_column`; an
 *      admin_provision can NEVER reach `coverage_rules` when ON.
 *   5. dead→live slug rename is honored before the validity check.
 */
import { routeCriterion, type RouteContext, type RoutableCriterion } from "@/lib/eoc/route-criterion";

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

console.log("P2 T2 — EOC content-type routing logic fixture\n");

const validSlugs = new Set(["bariatric_surgery", "dme", "maternity_care", "live5"]);
const renameMap = new Map([["dead5", "live5"]]);
const ON: RouteContext = { flagOn: true, confidenceFloor: 0.7, validSlugs, renameMap };
const OFF: RouteContext = { flagOn: false, confidenceFloor: 0.7, validSlugs, renameMap };

function c(partial: Partial<RoutableCriterion>): RoutableCriterion {
  return {
    type: "clinical_criterion",
    pa_polarity: null,
    place_of_service: null,
    service_slug_hint: null,
    type_confidence: 0.9,
    ...partial,
  };
}
const store = (crit: RoutableCriterion, ctx: RouteContext) => routeCriterion(crit, ctx).store;

// ── Flag OFF → byte-identical post-D1 (type ignored) ─────────────────────────
check("OFF: PA+valid slug -> coverage_rules (type ignored)", store(c({ type: "prior_auth", pa_polarity: "requires", service_slug_hint: "dme" }), OFF) === "coverage_rules");
check("OFF: admin+valid slug -> coverage_rules", store(c({ type: "admin_provision", service_slug_hint: "dme" }), OFF) === "coverage_rules");
check("OFF: unknown slug -> enqueue", store(c({ service_slug_hint: "unknownxyz" }), OFF) === "enqueue_unknown_slug");
check("OFF: no slug -> drop", store(c({ service_slug_hint: null }), OFF) === "drop");
check("OFF: dead->live slug -> coverage_rules", store(c({ service_slug_hint: "dead5" }), OFF) === "coverage_rules");

// ── Flag ON: admin ───────────────────────────────────────────────────────────
check("ON: admin (no slug) -> admin_metadata", store(c({ type: "admin_provision", service_slug_hint: null }), ON) === "admin_metadata");
check("ON: admin (valid slug) -> admin_metadata", store(c({ type: "admin_provision", service_slug_hint: "dme" }), ON) === "admin_metadata");

// ── Flag ON: clinical ────────────────────────────────────────────────────────
check("ON: clinical+valid -> coverage_rules", store(c({ type: "clinical_criterion", service_slug_hint: "bariatric_surgery" }), ON) === "coverage_rules");
check("ON: clinical+unknown -> enqueue", store(c({ type: "clinical_criterion", service_slug_hint: "unknownxyz" }), ON) === "enqueue_unknown_slug");
check("ON: clinical+no slug -> drop", store(c({ type: "clinical_criterion", service_slug_hint: null }), ON) === "drop");

// ── Flag ON: prior_auth ──────────────────────────────────────────────────────
check("ON: PA requires service-specific high-conf -> pa_column", store(c({ type: "prior_auth", pa_polarity: "requires", service_slug_hint: "dme", type_confidence: 0.9 }), ON) === "pa_column");
check("ON: PA requires conf == floor -> pa_column (>=)", store(c({ type: "prior_auth", pa_polarity: "requires", service_slug_hint: "dme", type_confidence: 0.7 }), ON) === "pa_column");
check("ON: PA requires low-conf -> pa_facts", store(c({ type: "prior_auth", pa_polarity: "requires", service_slug_hint: "dme", type_confidence: 0.6 }), ON) === "pa_facts");
check("ON: PA requires axis (no slug) -> pa_facts", store(c({ type: "prior_auth", pa_polarity: "requires", place_of_service: "inpatient", service_slug_hint: null }), ON) === "pa_facts");
check("ON: PA requires axis WINS even with valid slug -> pa_facts", store(c({ type: "prior_auth", pa_polarity: "requires", place_of_service: "inpatient", service_slug_hint: "dme" }), ON) === "pa_facts");
check("ON: PA requires unknown slug -> pa_facts", store(c({ type: "prior_auth", pa_polarity: "requires", service_slug_hint: "unknownxyz" }), ON) === "pa_facts");
check("ON: PA requires no slug -> pa_facts", store(c({ type: "prior_auth", pa_polarity: "requires", service_slug_hint: null }), ON) === "pa_facts");
check("ON: PA waived (valid slug, high conf) -> pa_facts", store(c({ type: "prior_auth", pa_polarity: "waived", service_slug_hint: "dme", type_confidence: 0.95 }), ON) === "pa_facts");
check("ON: PA uncertain polarity -> pa_facts (fail-safe)", store(c({ type: "prior_auth", pa_polarity: null, service_slug_hint: "dme", type_confidence: 0.95 }), ON) === "pa_facts");
check("ON: PA requires dead->live slug -> pa_column", store(c({ type: "prior_auth", pa_polarity: "requires", service_slug_hint: "dead5", type_confidence: 0.9 }), ON) === "pa_column");

// ── Correct-by-construction invariants (exhaustive sweeps) ───────────────────
let paColumnLeak = 0;
for (const pol of [null, "waived"] as const) {
  for (const slug of [null, "dme", "unknownxyz", "dead5"]) {
    for (const conf of [0, 0.5, 0.7, 1]) {
      for (const pos of [null, "inpatient"]) {
        if (store(c({ type: "prior_auth", pa_polarity: pol, service_slug_hint: slug, type_confidence: conf, place_of_service: pos }), ON) === "pa_column") paColumnLeak++;
      }
    }
  }
}
check("INVARIANT: waived/uncertain PA NEVER reaches pa_column", paColumnLeak === 0);

let adminLeak = 0;
for (const slug of [null, "dme", "unknownxyz"]) {
  if (store(c({ type: "admin_provision", service_slug_hint: slug }), ON) === "coverage_rules") adminLeak++;
}
check("INVARIANT: admin_provision NEVER reaches coverage_rules (ON)", adminLeak === 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
