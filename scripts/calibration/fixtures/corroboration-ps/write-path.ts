/**
 * S205 Corroboration-PS gate (b) — write-path fixture (TS, runnable):
 *   npx tsx scripts/calibration/fixtures/corroboration-ps/write-path.ts
 *
 * Proves the S205 value-wiring + the column-name keying that gate (a) consumes:
 *  (1) buildPlanCoveredServiceProvenance keys field_provenance by the plan_covered_services
 *      COLUMN name (in_copay / in_coinsurance / prior_auth_required / covered) — NOT the canonical
 *      aliases (copay / requires_prior_auth / is_covered). This is the key the evaluator reads and
 *      the name expandPerServiceCandidates now emits.
 *  (2) Every entry carries `value` = the stored column value; coinsurance is NORMALIZED to the
 *      decimal the column holds (raw 40 -> 0.4) so cross-user GROUP BY agrees.
 *  (3) buildProvenanceEntry stores false / 0 (valid corroboration values) and skips null / undefined
 *      (mirrors the evaluator's `? 'value'` + jsonb_typeof != 'null' gate; back-compat when not passed).
 */
import { buildPlanCoveredServiceProvenance } from "../../../../src/lib/parser/provenance-builders";
import { buildProvenanceEntry } from "../../../../src/lib/parser/field-categories";
import type { SBCHaikuService } from "../../../../src/lib/sbc/types";

let failures = 0;
function check(name: string, cond: boolean): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { console.error(`  ✗ ${name}`); failures++; }
}

// Minimal service. Raw coinsurance 40 (percent) — the column stores 0.4, so provenance.value must too.
const service = {
  inCopay: 40,
  inCoinsurance: 40, // RAW percent; normalizeCoinsuranceForStorage -> 0.4 (matches the column)
  inDeductibleApplies: true,
  priorAuthRequired: false, // boolean false — must be stored + valued, not dropped
  covered: true,
  patternP8: { source_excerpt: "$40 copay / 40% coinsurance", source_excerpt_verified: "verified" },
  haikuConfidence: 0.9,
} as unknown as SBCHaikuService;

const prov = buildPlanCoveredServiceProvenance(service, "doc_extraction");

console.log("Gate (b) — write-path (buildPlanCoveredServiceProvenance):");
// (1) keyed by COLUMN names, not canonical aliases
check("keyed by column name in_copay (not alias 'copay')", "in_copay" in prov && !("copay" in prov));
check("keyed by column name in_coinsurance (not 'coinsurance')", "in_coinsurance" in prov && !("coinsurance" in prov));
check("keyed by column name prior_auth_required (not 'requires_prior_auth')", "prior_auth_required" in prov && !("requires_prior_auth" in prov));
check("keyed by column name covered (not 'is_covered')", "covered" in prov && !("is_covered" in prov));
// (2) value present + mirrors the column (coinsurance normalized to decimal)
check("in_copay.value === 40", prov.in_copay?.value === 40);
check("in_coinsurance.value === 0.4 (normalized from raw 40)", prov.in_coinsurance?.value === 0.4);
check("prior_auth_required.value === false (boolean stored, not dropped)", prov.prior_auth_required?.value === false);
check("covered.value === true", prov.covered?.value === true);

// (3) buildProvenanceEntry value semantics — false/0 stored, null/undefined skipped
const e0 = buildProvenanceEntry("plan_covered_services", "in_copay", "doc_extraction", undefined, undefined, undefined, 0);
check("buildProvenanceEntry stores value 0 (a $0 copay is a real value)", e0?.value === 0);
const eFalse = buildProvenanceEntry("plan_covered_services", "prior_auth_required", "doc_extraction", undefined, undefined, undefined, false);
check("buildProvenanceEntry stores value false", eFalse?.value === false);
const eNull = buildProvenanceEntry("plan_covered_services", "in_copay", "doc_extraction", undefined, undefined, undefined, null);
check("buildProvenanceEntry skips value null (no 'value' key written)", eNull !== null && !("value" in eNull));
const eUndef = buildProvenanceEntry("plan_covered_services", "in_copay", "doc_extraction");
check("buildProvenanceEntry omits value when not passed (pre-S205 back-compat)", eUndef !== null && !("value" in eUndef));

if (failures > 0) { console.error(`\n✗ ${failures} check(s) FAILED`); process.exit(1); }
console.log("\n>>> CORROBORATION-PS GATE (b) FIXTURE: PASS <<<");
