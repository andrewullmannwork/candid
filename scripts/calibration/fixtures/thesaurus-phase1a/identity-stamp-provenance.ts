/**
 * A3 — identity-stamp WRITE-side fixture (no DB, no Haiku).
 *
 *   npx tsx scripts/calibration/fixtures/thesaurus-phase1a/identity-stamp-provenance.ts
 *
 * Closes the one hop the routing fixture (routing.ts) does NOT cover and the in-vivo probe
 * could not (0 cache-wins): that `buildPlanDocServiceProvenance` actually EMITS
 * `resolution_source` into the persisted field_provenance when the coverage-write passes
 * `s.identityResolution?.source`. routing.ts proves the stamp is SET; inspection proves it
 * SURVIVES to `s`; this proves the builder WRITES it (and omits it when absent).
 */
import { buildPlanDocServiceProvenance, buildPlanCoveredServiceProvenance } from "@/lib/parser/provenance-builders";
import type { PlanDocService } from "@/lib/plan_doc/types";
import type { SBCHaikuService } from "@/lib/sbc/types";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean): void {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.error(`  FAIL  ${name}`); }
}

console.log("A3 — identity-stamp provenance write-side fixture\n");

// Minimal service carrying two non-null cost-share fields (each → one provenance entry).
const baseFields = {
  serviceSlug: "lab_outpatient", placeOfService: "any",
  inCopay: 20, inCoinsurance: null, inDeductibleApplies: null, inCopayWaiverCondition: null, inCostDescription: "",
  outCopay: null, outCoinsurance: null, outDeductibleApplies: null, outCostDescription: "",
  oonPaidAtInNetwork: false, annualLimit: null, annualLimitValue: null,
  priorAuthRequired: null, penaltyNoPrecert: null, covered: true, coverageConditions: null,
  supplyLimitDays: null, homeDeliveryCopay: null, stepTherapyRequired: null, notes: null, confidence: 0.9,
};
const planDocService = { ...baseFields } as PlanDocService;
const sbcHaikuService = { ...baseFields } as unknown as SBCHaikuService;

// ── buildPlanDocServiceProvenance (the LIVE plan-doc path builder) ──────────────
const pdWith = buildPlanDocServiceProvenance(planDocService, "doc_extraction", undefined, "signature_cache");
check("plan-doc: in_copay carries resolution_source=signature_cache", pdWith["in_copay"]?.resolution_source === "signature_cache");
check("plan-doc: covered carries resolution_source=signature_cache", pdWith["covered"]?.resolution_source === "signature_cache");
check("plan-doc: source axis still doc_extraction (identity ≠ coverage axis)", pdWith["in_copay"]?.source === "doc_extraction");

const pdWithout = buildPlanDocServiceProvenance(planDocService, "doc_extraction", undefined, undefined);
check("plan-doc: NO resolution_source when arg undefined (in_copay)", pdWithout["in_copay"]?.resolution_source === undefined);
check("plan-doc: NO resolution_source when arg undefined (covered)", pdWithout["covered"]?.resolution_source === undefined);

const pdCode = buildPlanDocServiceProvenance(planDocService, "doc_extraction", undefined, "code_cache");
check("plan-doc: code_cache tier threads through", pdCode["in_copay"]?.resolution_source === "code_cache");

// ── buildPlanCoveredServiceProvenance (symmetric SBC-haiku builder) ─────────────
const pcWith = buildPlanCoveredServiceProvenance(sbcHaikuService, "doc_extraction", undefined, "signature_cache");
check("plan-covered: in_copay carries resolution_source=signature_cache", pcWith["in_copay"]?.resolution_source === "signature_cache");
const pcWithout = buildPlanCoveredServiceProvenance(sbcHaikuService, "doc_extraction", undefined, undefined);
check("plan-covered: NO resolution_source when arg undefined", pcWithout["in_copay"]?.resolution_source === undefined);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
