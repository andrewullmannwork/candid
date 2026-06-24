/**
 * Cost-Share v2 (S214) — pure-engine fixtures (the LOCKED 14-scenario contract).
 *
 * Expected values are Andrew-approved (the 14-card contract + Q1–Q4); the engine
 * is implemented to satisfy them. If a case fails, FIX THE ENGINE, not the value.
 *
 * Run: npx tsx scripts/calibration/fixtures/cost-share-v2/engine.ts
 * Exits non-zero on any failure (gate-usable).
 */
import {
  computeCostShareV2,
  computeClaimCostShareV2,
  computeRecoveryV2,
  computeShouldOwe,
  type ComputeCostShareV2Args,
  type ServiceCostShare,
  type PlanCostShareParams,
  type InsurerAdjudication,
  type CostShareOverrides,
  type AccumulatorSnapshot,
  type NetworkTier,
  type CostShareV2Result,
} from "../../../../src/lib/claims/recovery-math";

let pass = 0;
const fails: string[] = [];
function check(name: string, cond: boolean, got?: unknown, want?: unknown) {
  if (cond) pass++;
  else fails.push(`✗ ${name}  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
}
const near = (a: number, b: number, eps = 0.01) => Math.abs(a - b) <= eps;
const assumption = (r: CostShareV2Result, field: string) =>
  r.assumptions.find((a) => a.field === field);

const PLAN0: PlanCostShareParams = {
  inDeductibleIndividual: null, inDeductibleFamily: null,
  outDeductibleIndividual: null, outDeductibleFamily: null,
  inOopMaxIndividual: null, inOopMaxFamily: null,
  outOopMaxIndividual: null, outOopMaxFamily: null,
  inCoinsuranceDefault: null, outCoinsuranceDefault: null,
  deductibleCalcMethod: null, combinedMedicalRxOop: null, coverageTier: null,
};
const INSURER0: InsurerAdjudication = {
  memberAppliedToDeductible: null, memberCoinsurance: null, memberCopay: null,
  deniedAmount: null, insurancePaid: null,
};
const OV0: CostShareOverrides = {
  deductibleMet: null, deductibleMetAsOf: null, oopMet: null, oopMetAsOf: null,
  userNetworkOverride: null,
};

function mk(o: {
  line: { billed: number; allowed?: number | null; insuranceAdjusted?: number; patientPaid?: number; patientResponsibility?: number };
  service?: ServiceCostShare | null;
  insurer?: Partial<InsurerAdjudication>;
  plan?: Partial<PlanCostShareParams>;
  accumulator?: AccumulatorSnapshot | null;
  overrides?: Partial<CostShareOverrides>;
  networkLine?: NetworkTier | null;
  networkClaim?: NetworkTier | null;
}): ComputeCostShareV2Args {
  return {
    line: {
      billed: o.line.billed,
      allowed: o.line.allowed ?? null,
      insuranceAdjusted: o.line.insuranceAdjusted ?? 0,
      patientPaid: o.line.patientPaid ?? 0,
      patientResponsibility: o.line.patientResponsibility ?? 0,
    },
    service: o.service === undefined ? null : o.service,
    insurer: { ...INSURER0, ...(o.insurer ?? {}) },
    plan: { ...PLAN0, ...(o.plan ?? {}) },
    accumulator: o.accumulator ?? null,
    overrides: { ...OV0, ...(o.overrides ?? {}) },
    networkLine: o.networkLine ?? null,
    networkClaim: o.networkClaim ?? null,
  };
}

// 1 — deductible-phase (cf91a49e, real): owe the full allowed pre-deductible → V1, recovery 0.
{
  const r = computeCostShareV2(mk({
    line: { billed: 221, allowed: 163.27, patientPaid: 163.27, patientResponsibility: 163.27 },
    service: { covered: true, copay: null, coinsurance: null, deductibleApplies: true },
    plan: { inDeductibleIndividual: 7050, inOopMaxIndividual: 7050 },
  }));
  check("1 verdict correct", r.verdict === "correct", r.verdict, "correct");
  check("1 shouldOwe 163.27", near(r.shouldOwe, 163.27), r.shouldOwe);
  check("1 recovery 0", near(r.potentialRecovery, 0), r.potentialRecovery);
  check("1 deductible_met assumption $7050", assumption(r, "deductible_met")?.value === 7050, assumption(r, "deductible_met"));
  check("1 networkUsed in_network", r.networkUsed === "in_network", r.networkUsed);
}

// 2 — same bill, deductible MET (corrected) → HDHP pays 100% → recover $163.
{
  const r = computeCostShareV2(mk({
    line: { billed: 221, allowed: 163.27, patientPaid: 163.27, patientResponsibility: 163.27 },
    service: { covered: true, copay: null, coinsurance: null, deductibleApplies: true },
    plan: { inDeductibleIndividual: 7050, inOopMaxIndividual: 7050 },
    overrides: { deductibleMet: true },
  }));
  check("2 verdict recovery", r.verdict === "recovery", r.verdict, "recovery");
  check("2 shouldOwe 0", near(r.shouldOwe, 0), r.shouldOwe);
  check("2 recovery 163.27", near(r.potentialRecovery, 163.27), r.potentialRecovery);
}

// 3 — OOP max met → share $0, paid $400 → recover $400.
{
  const r = computeCostShareV2(mk({
    line: { billed: 500, allowed: 400, patientPaid: 400, patientResponsibility: 400 },
    service: { covered: true, copay: null, coinsurance: 0.2, deductibleApplies: true },
    accumulator: { deductibleApplied: null, deductibleMax: null, oopApplied: 9000, oopMax: 9000 },
  }));
  check("3 verdict recovery", r.verdict === "recovery", r.verdict, "recovery");
  check("3 phase oop_met", r.phase === "oop_met", r.phase);
  check("3 shouldOwe 0", near(r.shouldOwe, 0), r.shouldOwe);
  check("3 recovery 400", near(r.potentialRecovery, 400), r.potentialRecovery);
}

// 4 — straddle (no cap): $200 deductible + 20% of the rest = $360 → recover $640.
{
  const r = computeCostShareV2(mk({
    line: { billed: 1000, allowed: 1000, patientPaid: 0, patientResponsibility: 1000 },
    service: { covered: true, copay: null, coinsurance: 0.2, deductibleApplies: true },
    accumulator: { deductibleApplied: 1800, deductibleMax: 2000, oopApplied: 1800, oopMax: 9000 },
  }));
  check("4 phase straddle", r.phase === "straddle", r.phase);
  check("4 shouldOwe 360", near(r.shouldOwe, 360), r.shouldOwe);
  check("4 recovery 640", near(r.potentialRecovery, 640), r.potentialRecovery);
}

// 5 — straddle, OOP cap binds: raw $1160 capped at remaining OOP $300 → recover $4700.
{
  const r = computeCostShareV2(mk({
    line: { billed: 5000, allowed: 5000, patientPaid: 0, patientResponsibility: 5000 },
    service: { covered: true, copay: null, coinsurance: 0.2, deductibleApplies: true },
    accumulator: { deductibleApplied: 1800, deductibleMax: 2000, oopApplied: 8700, oopMax: 9000 },
  }));
  check("5 phase straddle", r.phase === "straddle", r.phase);
  check("5 shouldOwe 300 (capped)", near(r.shouldOwe, 300), r.shouldOwe);
  check("5 recovery 4700", near(r.potentialRecovery, 4700), r.potentialRecovery);
}

// 6 — out-of-network: uses out-params (40%) → share $120 → recover $180.
{
  const r = computeCostShareV2(mk({
    line: { billed: 300, allowed: 300, patientPaid: 0, patientResponsibility: 300 },
    service: { covered: true, copay: null, coinsurance: 0.2, outCoinsurance: 0.4, deductibleApplies: true, outDeductibleApplies: true },
    networkLine: "out_of_network",
    accumulator: { deductibleApplied: 4000, deductibleMax: 4000, oopApplied: 4000, oopMax: 14000 },
  }));
  check("6 networkUsed out_of_network", r.networkUsed === "out_of_network", r.networkUsed);
  check("6 shouldOwe 120 (40%)", near(r.shouldOwe, 120), r.shouldOwe);
  check("6 recovery 180", near(r.potentialRecovery, 180), r.potentialRecovery);
}

// 7 — user network override wins over the parsed in-network value.
{
  const r = computeCostShareV2(mk({
    line: { billed: 300, allowed: 300, patientPaid: 0, patientResponsibility: 300 },
    service: { covered: true, copay: null, coinsurance: 0.2, outCoinsurance: 0.4, deductibleApplies: true, outDeductibleApplies: true },
    networkLine: "in_network",
    overrides: { userNetworkOverride: "out_of_network" },
    accumulator: { deductibleApplied: 4000, deductibleMax: 4000, oopApplied: 4000, oopMax: 14000 },
  }));
  check("7 override wins → OON", r.networkUsed === "out_of_network", r.networkUsed, "out_of_network");
  check("7 shouldOwe 120 (used OON 40%)", near(r.shouldOwe, 120), r.shouldOwe);
}

// 8 — insurer error: maxed out (share $0) but insurer assigned $80 → flag discrepancy, recover $80.
{
  const r = computeCostShareV2(mk({
    line: { billed: 500, allowed: 400, patientPaid: 0, patientResponsibility: 80 },
    service: { covered: true, copay: null, coinsurance: 0.2, deductibleApplies: true },
    insurer: { memberCoinsurance: 80 },
    accumulator: { deductibleApplied: null, deductibleMax: null, oopApplied: 9000, oopMax: 9000 },
  }));
  check("8 verdict recovery", r.verdict === "recovery", r.verdict, "recovery");
  check("8 shouldOwe 0", near(r.shouldOwe, 0), r.shouldOwe);
  check("8 recovery 80", near(r.potentialRecovery, 80), r.potentialRecovery);
  check("8 insurerDiscrepancy delta 80", r.insurerDiscrepancy != null && near(r.insurerDiscrepancy.delta, 80), r.insurerDiscrepancy);
  check("8 tier1_reconcile", r.tier === "tier1_reconcile", r.tier);
}

// 9 — not covered, paid exactly the charge → V3, no dispute.
{
  const r = computeCostShareV2(mk({
    line: { billed: 150, allowed: 150, patientPaid: 150, patientResponsibility: 150 },
    service: { covered: false, copay: null, coinsurance: null, deductibleApplies: null },
  }));
  check("9 verdict not_covered", r.verdict === "not_covered", r.verdict, "not_covered");
  check("9 shouldOwe 150 (full allowed)", near(r.shouldOwe, 150), r.shouldOwe);
  check("9 recovery 0", near(r.potentialRecovery, 0), r.potentialRecovery);
}

// 10 — not covered BUT paid MORE than the full charge (Q2) → still flag the overpayment.
{
  const r = computeCostShareV2(mk({
    line: { billed: 150, allowed: 150, patientPaid: 300, patientResponsibility: 150 },
    service: { covered: false, copay: null, coinsurance: null, deductibleApplies: null },
  }));
  check("10 verdict recovery (Q2: overpaid even not-covered)", r.verdict === "recovery", r.verdict, "recovery");
  check("10 recovery 150", near(r.potentialRecovery, 150), r.potentialRecovery);
}

// 11 — insufficient: no plan terms, no accumulator, no insurer breakdown → V4, never asserts a dispute.
{
  const r = computeCostShareV2(mk({
    line: { billed: 400, allowed: 400, patientPaid: 400, patientResponsibility: 400 },
    service: null,
  }));
  check("11 verdict insufficient", r.verdict === "insufficient", r.verdict, "insufficient");
  check("11 shouldOwe 400 (conservative=allowed)", near(r.shouldOwe, 400), r.shouldOwe);
  check("11 recovery 0", near(r.potentialRecovery, 0), r.potentialRecovery);
  check("11 service_cost assumption", !!assumption(r, "service_cost"), r.assumptions);
}

// 12 — insurer correct (guard): insurer matches plan → NO false insurer flag.
{
  const r = computeCostShareV2(mk({
    line: { billed: 120, allowed: 120, patientPaid: 20, patientResponsibility: 20 },
    service: { covered: true, copay: 20, coinsurance: null, deductibleApplies: false },
    insurer: { memberCopay: 20 },
    networkLine: "in_network",
    accumulator: { deductibleApplied: 2000, deductibleMax: 2000, oopApplied: 2000, oopMax: 9000 },
  }));
  check("12 no insurer discrepancy", r.insurerDiscrepancy === null, r.insurerDiscrepancy, null);
  check("12 shouldOwe 20", near(r.shouldOwe, 20), r.shouldOwe);
  check("12 recovery 0", near(r.potentialRecovery, 0), r.potentialRecovery);
  check("12 checks out", r.verdict === "confident" || r.verdict === "correct", r.verdict);
}

// 13 — denied charge (Q4): never rubber-stamped as owed → appealable, not "correct".
{
  const r = computeCostShareV2(mk({
    line: { billed: 150, allowed: 150, patientPaid: 0, patientResponsibility: 150 },
    service: { covered: true, copay: null, coinsurance: null, deductibleApplies: true },
    insurer: { deniedAmount: 150 },
    plan: { inDeductibleIndividual: 5000 },
  }));
  check("13 verdict insufficient (appealable)", r.verdict === "insufficient", r.verdict, "insufficient");
  check("13 denial assumption $150", assumption(r, "denial")?.value === 150, assumption(r, "denial"));
  check("13 not marked correct/confident", r.verdict !== "correct" && r.verdict !== "confident", r.verdict);
}

// 14 — confident: full data, paid exactly the copay, no assumptions → V0 quiet.
{
  const r = computeCostShareV2(mk({
    line: { billed: 120, allowed: 120, patientPaid: 20, patientResponsibility: 20 },
    service: { covered: true, copay: 20, coinsurance: null, deductibleApplies: false },
    networkLine: "in_network",
    accumulator: { deductibleApplied: 2000, deductibleMax: 2000, oopApplied: 2000, oopMax: 9000 },
  }));
  check("14 verdict confident", r.verdict === "confident", r.verdict, "confident");
  check("14 no assumptions", r.assumptions.length === 0, r.assumptions);
  check("14 recovery 0", near(r.potentialRecovery, 0), r.potentialRecovery);
}

// 15 — CLAIM WRAPPER: per-line verdicts roll up to a bill-level verdict + totals.
//      (v1 = conservative independent per-line; cross-line threading deferred.)
{
  const res = computeClaimCostShareV2({
    lines: [
      // line A — $20 copay service, paid $100 → recover $80 (V2)
      { billed: 100, allowed: 100, patientPaid: 100, patientResponsibility: 100, service: { covered: true, copay: 20, coinsurance: null, deductibleApplies: false }, insurer: INSURER0, networkLine: "in_network" },
      // line B — deductible-phase, paid the allowed → checks out (V1)
      { billed: 150, allowed: 150, patientPaid: 150, patientResponsibility: 150, service: { covered: true, copay: null, coinsurance: null, deductibleApplies: true }, insurer: INSURER0, networkLine: "in_network" },
    ],
    plan: { ...PLAN0, inDeductibleIndividual: 5000, inOopMaxIndividual: 9000 },
    accumulator: null,
    overrides: OV0,
    networkClaim: null,
  });
  check("15 line A recover $80", near(res.lines[0].potentialRecovery, 80), res.lines[0].potentialRecovery);
  check("15 line B checks out", res.lines[1].verdict === "correct" || res.lines[1].verdict === "confident", res.lines[1].verdict);
  check("15 bill verdict = recovery (rollup)", res.verdict === "recovery", res.verdict, "recovery");
  check("15 total recovery $80", near(res.totalPotentialRecovery, 80), res.totalPotentialRecovery);
}

// 16 — Q1 guard: insurer assigned more than plan-derived, but NO hard met-status data
//      → we do NOT accuse the insurer (conservative assumption instead).
{
  const r = computeCostShareV2(mk({
    line: { billed: 200, allowed: 200, patientPaid: 0, patientResponsibility: 50 },
    service: { covered: true, copay: null, coinsurance: 0.2, deductibleApplies: true },
    insurer: { memberCoinsurance: 50 },
    plan: { inDeductibleIndividual: 3000 },
  }));
  check("16 no accusation without hard data (Q1)", r.insurerDiscrepancy === null, r.insurerDiscrepancy, null);
  check("16 conservative shouldOwe = allowed 200", near(r.shouldOwe, 200), r.shouldOwe);
}

// 17 — OFF parity: computeRecoveryV2 without shouldOweOverride is byte-identical to today
//      (computeShouldOwe path); with the override it uses the engine value.
{
  const off = computeRecoveryV2({ billed: 100, patientResponsibility: 100, patientPaid: 0, planCoverage: { covered: true, copay: 20, coinsurance: null } });
  check("17 OFF shouldOwe = computeShouldOwe (min(20,100))", near(off.shouldOwe, 20), off.shouldOwe);
  check("17 OFF shouldOwe = computeShouldOwe direct", near(off.shouldOwe, computeShouldOwe({ billed: 100, planCoverage: { covered: true, copay: 20, coinsurance: null } })), off.shouldOwe);
  const on = computeRecoveryV2({ billed: 100, patientResponsibility: 100, patientPaid: 0, planCoverage: null, shouldOweOverride: 50 });
  check("17 override applied (shouldOwe 50)", near(on.shouldOwe, 50), on.shouldOwe);
}

// 18 — data-reality guard: covered service, deductible MET, cost-share rate UNKNOWN
//      on a NON-HDHP plan (deductible != oop_max) → conservative full allowed, NOT a
//      fabricated $0 (which would be a false recovery). + service_cost assumption.
{
  const r = computeCostShareV2(mk({
    line: { billed: 200, allowed: 200, patientPaid: 200, patientResponsibility: 200 },
    service: { covered: true, copay: null, coinsurance: null, deductibleApplies: true },
    plan: { inDeductibleIndividual: 1000, inOopMaxIndividual: 5000 },
    overrides: { deductibleMet: true },
    networkLine: "in_network",
  }));
  check("18 conservative shouldOwe 200 (not fabricated $0)", near(r.shouldOwe, 200), r.shouldOwe);
  check("18 recovery 0 (no false recovery)", near(r.potentialRecovery, 0), r.potentialRecovery);
  check("18 service_cost assumption", !!assumption(r, "service_cost"), r.assumptions);
  check("18 not a recovery verdict", r.verdict !== "recovery", r.verdict);
}

console.log(`\ncost-share-v2 engine fixtures: ${pass} passed, ${fails.length} failed`);
if (fails.length) {
  console.log(fails.join("\n"));
  process.exit(1);
}
console.log("ALL GREEN ✓");
