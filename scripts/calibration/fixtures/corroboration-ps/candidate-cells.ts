/**
 * S205 Corroboration-PS gate (d) — per-cell candidate emission fixture (TS, runnable):
 *   npx tsx scripts/calibration/fixtures/corroboration-ps/candidate-cells.ts
 *
 * Proves the step-(3) pos/component fold at the candidate layer:
 *  (1) expandPerServiceCandidates emits ONE candidate per (service × column × CELL) — a multi-cell
 *      service (facility + office) yields a candidate for EACH cell, not one collapsed across cells.
 *  (2) Each per-service candidate carries its placeOfService + component (so the evaluator + promotion
 *      target that cell).
 *  (3) Candidates use the COLUMN name (in_copay, …), consistent with gate (a)/(b).
 * Mock supabase routes by table; no DB.
 */
import { expandPerServiceCandidates, type FieldEvaluationCandidate } from "../../../../src/lib/parser/commit-and-evaluate";

let failures = 0;
function check(name: string, cond: boolean): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { console.error(`  ✗ ${name}`); failures++; }
}

// Two cells of the SAME service 'surgery': facility (copay 50) + office (copay 20).
const pcsRows = [
  { service_id: "s1", place_of_service: "facility", component: "global", in_copay: 50, in_coinsurance: null, in_deductible_applies: null, covered: true, prior_auth_required: null, out_copay: null, out_coinsurance: null, out_deductible_applies: null },
  { service_id: "s1", place_of_service: "office", component: "global", in_copay: 20, in_coinsurance: null, in_deductible_applies: null, covered: true, prior_auth_required: null, out_copay: null, out_coinsurance: null, out_deductible_applies: null },
];
const services = [{ id: "s1", slug: "surgery" }];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fake: any = {
  from(table: string) {
    if (table === "insurance_plans") {
      return { select: () => ({ eq: () => ({ eq: () => ({ order: () => ({ limit: () => ({ maybeSingle: () => Promise.resolve({ data: { id: "ip1" } }) }) }) }) }) }) };
    }
    if (table === "plan_covered_services") {
      return { select: () => ({ eq: () => Promise.resolve({ data: pcsRows }) }) };
    }
    if (table === "service_catalog") {
      return { select: () => ({ in: () => Promise.resolve({ data: services }) }) };
    }
    throw new Error(`unexpected table ${table}`);
  },
};

async function main() {
  const candidates: FieldEvaluationCandidate[] = await expandPerServiceCandidates(fake, "user1", "cp1", []);
  const surgeryCopay = candidates.filter((c) => c.serviceSlug === "surgery" && c.fieldName === "in_copay");

  console.log("Gate (d) — per-cell candidate emission (expandPerServiceCandidates):");
  // (1) multi-cell service -> one in_copay candidate PER cell (not collapsed)
  check("surgery×in_copay emits 2 candidates (one per cell), not 1", surgeryCopay.length === 2);
  const facility = surgeryCopay.find((c) => c.placeOfService === "facility");
  const office = surgeryCopay.find((c) => c.placeOfService === "office");
  // (2) each carries its own cell coords
  check("facility cell candidate present (placeOfService=facility, component=global)", !!facility && facility.component === "global");
  check("office cell candidate present (placeOfService=office, component=global)", !!office && office.component === "global");
  // (3) column-name fieldName (consistent with gate a/b)
  check("fieldName is the column name 'in_copay' (not alias 'copay')", surgeryCopay.every((c) => c.fieldName === "in_copay") && !candidates.some((c) => c.fieldName === "copay"));
  // covered emitted per cell too (sanity: every column with a value emits per cell)
  check("surgery×covered emits 2 candidates (one per cell)", candidates.filter((c) => c.serviceSlug === "surgery" && c.fieldName === "covered").length === 2);

  if (failures > 0) { console.error(`\n✗ ${failures} check(s) FAILED`); process.exit(1); }
  console.log("\n>>> CORROBORATION-PS GATE (d) CANDIDATE FIXTURE: PASS <<<");
}
main();
