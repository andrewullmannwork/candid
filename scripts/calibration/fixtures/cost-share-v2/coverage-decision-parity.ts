/**
 * R2 (S242) coverage-decision PARITY GATE — `resolveCoverageForLine` and the legacy
 * projections that consume it are BYTE-IDENTICAL to the prior inline derivations.
 *
 * The card (recovery-math `computeCostShareV2`) and the letter (evidence-resolver
 * `buildPlanBenefitFromRow` / `buildSecondaryPlanBenefit`) used to each derive coverage
 * inline; both now read one shared `CoverageDecision`. This fixture proves the swap
 * changed nothing:
 *   PART A — the decision's shape over the full input matrix (planStance ×
 *            insurerAdjudication × conditions × provenance; isInsurerDenied).
 *   PART B — CARD projections == the prior inline expressions over the FULL input
 *            domain: `planStance === "not_covered"` ⟺ `service?.covered === false`
 *            (covers lines 623/736/811); `isInsurerDenied` ⟺ `(num(deniedAmount) ?? 0) > 0`
 *            (line 742, incl. the NaN coercion).
 *   PART C — LETTER projection == the prior inline: `planStance !== "not_covered"`
 *            ⟺ `row.covered !== false` (line 1334).
 *   PART D — INTEGRATED computeCostShareV2 anchors, incl. the explicit `{covered:null}`
 *            and `deniedAmount>0` branches the pre-R2 fixtures never exercised on a
 *            non-null service (red-team gap, S242).
 *
 * Equivalence over the full domain (B+C) is the byte-identity proof: the only code
 * changes are these expression swaps, so identical inputs → identical outputs.
 *
 * Run: npx tsx scripts/calibration/fixtures/cost-share-v2/coverage-decision-parity.ts
 * Exits non-zero on any failure (gate-usable).
 */
import {
  resolveCoverageForLine,
  isInsurerDenied,
  detectCoverageContradiction,
  type CoverageStanceInput,
  type InsurerAdjudicationInput,
} from "../../../../src/lib/claims/coverage-decision";
import {
  computeCostShareV2,
  type ComputeCostShareV2Args,
  type ServiceCostShare,
  type InsurerAdjudication,
  type PlanCostShareParams,
  type CostShareOverrides,
} from "../../../../src/lib/claims/recovery-math";

let pass = 0;
const fails: string[] = [];
function eq(name: string, got: unknown, want: unknown) {
  const A = JSON.stringify(got);
  const B = JSON.stringify(want);
  if (A === B) pass++;
  else fails.push(`✗ ${name}\n    got =${A}\n    want=${B}`);
}
function ok(name: string, cond: boolean, got?: unknown) {
  if (cond) pass++;
  else fails.push(`✗ ${name}  got=${JSON.stringify(got)}`);
}

// Input domains.
const COVERED_VALUES: Array<boolean | null | undefined> = [true, false, null, undefined];
const INSURERS: Array<InsurerAdjudicationInput | null> = [
  null,
  { deniedAmount: null, insurancePaid: null },
  { deniedAmount: 0, insurancePaid: 0 },
  { deniedAmount: 150, insurancePaid: 0 },
  { deniedAmount: 150, insurancePaid: 50 },
  { deniedAmount: 0, insurancePaid: 100 },
  { deniedAmount: NaN, insurancePaid: NaN }, // pathological — must coerce like num()
];

// ── PART A — the decision shape ──────────────────────────────────────────────
eq(
  "A1 covered=true,insurer=null",
  resolveCoverageForLine({ covered: true }, null),
  {
    planStance: "covered",
    insurerAdjudication: null,
    derivedStatus: "unevaluated",
    conditions: { priorAuthRequired: null, referralRequired: null, visitLimit: null, annualLimit: null },
    provenance: { planStance: { covered: true }, insurerAdjudication: null },
  },
);
eq(
  "A2 covered=false,denied",
  resolveCoverageForLine({ covered: false }, { deniedAmount: 150, insurancePaid: 0 }),
  {
    planStance: "not_covered",
    insurerAdjudication: "denied",
    derivedStatus: "consistent_denial",
    conditions: { priorAuthRequired: null, referralRequired: null, visitLimit: null, annualLimit: null },
    provenance: { planStance: { covered: false }, insurerAdjudication: { deniedAmount: 150, insurancePaid: 0 } },
  },
);
eq(
  "A3 covered=null,partial",
  resolveCoverageForLine({ covered: null }, { deniedAmount: 150, insurancePaid: 50 }),
  {
    planStance: "unknown",
    insurerAdjudication: "partial",
    derivedStatus: "indeterminate",
    conditions: { priorAuthRequired: null, referralRequired: null, visitLimit: null, annualLimit: null },
    provenance: { planStance: { covered: null }, insurerAdjudication: { deniedAmount: 150, insurancePaid: 50 } },
  },
);
ok("A4 paid", resolveCoverageForLine({ covered: true }, { deniedAmount: 0, insurancePaid: 100 }).insurerAdjudication === "paid");
ok("A5 none (evaluated, $0/$0)", resolveCoverageForLine({ covered: true }, { deniedAmount: 0, insurancePaid: 0 }).insurerAdjudication === "none");
ok("A6 null coverage -> unknown", resolveCoverageForLine(null, null).planStance === "unknown");
ok("A6b null insurer -> null axis (not 'none')", resolveCoverageForLine({ covered: true }, null).insurerAdjudication === null);
// conditions passthrough (forward-looking; null today because the read doesn't fetch them).
eq(
  "A7 conditions passthrough",
  resolveCoverageForLine(
    { covered: true, priorAuthRequired: true, referralRequired: false, visitLimit: 10, annualLimit: 5 } as CoverageStanceInput,
    null,
  ).conditions,
  { priorAuthRequired: true, referralRequired: false, visitLimit: 10, annualLimit: 5 },
);

// ── PART B — CARD projections ⟺ prior inline, over the FULL domain ────────────
// The exact pre-R2 coercion at recovery-math.ts:742.
const num = (n: number | null | undefined): number | null => (n == null || Number.isNaN(n) ? null : n);
for (const cov of COVERED_VALUES) {
  const service = cov === undefined ? ({ copay: null, coinsurance: null } as unknown as ServiceCostShare) : ({ covered: cov } as ServiceCostShare);
  for (const insurer of INSURERS) {
    const d = resolveCoverageForLine(service, insurer);
    // planStance projection (phase line 623, verdict line 811, serviceCostUnknown line 736)
    const oldNotCovered = (service as { covered?: boolean | null })?.covered === false;
    ok(`B planStance==not_covered ⟺ covered===false [cov=${String(cov)}]`, (d.planStance === "not_covered") === oldNotCovered, d.planStance);
    ok(`B planStance!==not_covered ⟺ covered!==false [cov=${String(cov)}]`, (d.planStance !== "not_covered") === ((service as { covered?: boolean | null })?.covered !== false), d.planStance);
    // denied projection (line 742)
    const oldDenied = insurer == null ? false : (num(insurer.deniedAmount) ?? 0) > 0;
    ok(`B isInsurerDenied ⟺ (num(deniedAmount)??0)>0 [cov=${String(cov)} ins=${JSON.stringify(insurer)}]`, isInsurerDenied(d) === oldDenied, { got: isInsurerDenied(d), oldDenied });
  }
}

// ── PART C — LETTER projection ⟺ prior inline `row.covered !== false` ─────────
for (const cov of COVERED_VALUES) {
  const d = resolveCoverageForLine({ covered: cov as boolean | null }, null);
  ok(`C letter covered ⟺ row.covered!==false [cov=${String(cov)}]`, (d.planStance !== "not_covered") === (cov !== false), d.planStance);
}

// ── PART D — INTEGRATED computeCostShareV2 anchors ───────────────────────────
const PLAN0: PlanCostShareParams = {
  inDeductibleIndividual: null, inDeductibleFamily: null, outDeductibleIndividual: null, outDeductibleFamily: null,
  inOopMaxIndividual: null, inOopMaxFamily: null, outOopMaxIndividual: null, outOopMaxFamily: null,
  inCoinsuranceDefault: null, outCoinsuranceDefault: null, deductibleCalcMethod: null, combinedMedicalRxOop: null, coverageTier: null,
};
const INSURER0: InsurerAdjudication = { memberAppliedToDeductible: null, memberCoinsurance: null, memberCopay: null, deniedAmount: null, insurancePaid: null };
const OV0: CostShareOverrides = { deductibleMet: null, deductibleMetAsOf: null, oopMet: null, oopMetAsOf: null, userNetworkOverride: null };
function mk(service: ServiceCostShare | null, insurer?: Partial<InsurerAdjudication>): ComputeCostShareV2Args {
  return {
    line: { billed: 200, allowed: 200, insuranceAdjusted: 0, patientPaid: 200, patientResponsibility: 200 },
    service,
    insurer: { ...INSURER0, ...(insurer ?? {}) },
    plan: PLAN0,
    accumulator: null,
    overrides: OV0,
    networkLine: null,
    networkClaim: null,
    preventive: null,
  };
}
// D1 — explicit {covered:null} on a NON-null service (untested pre-R2): must NOT be not_covered.
{
  const r = computeCostShareV2(mk({ covered: null, copay: null, coinsurance: null, deductibleApplies: null, userStatedRate: false }));
  ok("D1 {covered:null} phase != not_covered", r.phase !== "not_covered", r.phase);
  ok("D1 {covered:null} verdict != not_covered", r.verdict !== "not_covered", r.verdict);
}
// D2 — {covered:false}: not_covered phase + verdict (the §18 contract; engine.ts 9/10).
{
  const r = computeCostShareV2(mk({ covered: false, copay: null, coinsurance: null, deductibleApplies: null, userStatedRate: false }));
  ok("D2 {covered:false} phase not_covered", r.phase === "not_covered", r.phase);
  ok("D2 {covered:false} verdict not_covered", r.verdict === "not_covered", r.verdict);
}
// D3 — denied>0 routes through `isInsurerDenied` (line 742) → the `denied` flag → a
// "denial" assumption. Anchored on the assumption (the exact path swapped), not the
// final verdict (which `recovery` precedence can outrank — engine.ts 13 owns that).
{
  const denied = computeCostShareV2(mk({ covered: true, copay: 20, coinsurance: null, deductibleApplies: null, userStatedRate: false }, { deniedAmount: 150 }));
  ok("D3 denied>0 pushes denial assumption", denied.assumptions.some((a) => a.field === "denial"), denied.assumptions);
  const notDenied = computeCostShareV2(mk({ covered: true, copay: 20, coinsurance: null, deductibleApplies: null, userStatedRate: false }, { deniedAmount: null }));
  ok("D3 denied=null pushes NO denial assumption", !notDenied.assumptions.some((a) => a.field === "denial"), notDenied.assumptions);
}

// ── PART E — R3 step 4: derivedStatus + detectCoverageContradiction + the surface ────────────
// Truth table (the combined headline). Authored from the design; the "none" guard = covered_owed.
const ds = (covered: boolean | null, insurer: InsurerAdjudicationInput | null) =>
  resolveCoverageForLine({ covered }, insurer).derivedStatus;
ok("E covered+denied → contradiction", ds(true, { deniedAmount: 150, insurancePaid: 0 }) === "contradiction", ds(true, { deniedAmount: 150, insurancePaid: 0 }));
ok("E covered+partial → contradiction", ds(true, { deniedAmount: 150, insurancePaid: 50 }) === "contradiction", ds(true, { deniedAmount: 150, insurancePaid: 50 }));
ok("E covered+paid → covered_paid", ds(true, { deniedAmount: 0, insurancePaid: 100 }) === "covered_paid", ds(true, { deniedAmount: 0, insurancePaid: 100 }));
ok("E covered+none → covered_owed (GUARD: NOT contradiction)", ds(true, { deniedAmount: 0, insurancePaid: 0 }) === "covered_owed", ds(true, { deniedAmount: 0, insurancePaid: 0 }));
ok("E not_covered+denied → consistent_denial", ds(false, { deniedAmount: 150, insurancePaid: 0 }) === "consistent_denial", ds(false, { deniedAmount: 150, insurancePaid: 0 }));
ok("E not_covered+none → consistent_denial", ds(false, { deniedAmount: 0, insurancePaid: 0 }) === "consistent_denial", ds(false, { deniedAmount: 0, insurancePaid: 0 }));
ok("E not_covered+paid → anomalous_payment", ds(false, { deniedAmount: 0, insurancePaid: 100 }) === "anomalous_payment", ds(false, { deniedAmount: 0, insurancePaid: 100 }));
ok("E covered+null insurer → unevaluated", ds(true, null) === "unevaluated", ds(true, null));
ok("E unknown plan+denied → indeterminate", ds(null, { deniedAmount: 150, insurancePaid: 0 }) === "indeterminate", ds(null, { deniedAmount: 150, insurancePaid: 0 }));

// detectCoverageContradiction — true ONLY for covered + denied/partial; the guard excludes "none".
const dc = (covered: boolean | null, insurer: InsurerAdjudicationInput | null) =>
  detectCoverageContradiction(resolveCoverageForLine({ covered }, insurer));
ok("E detect covered+denied → true", dc(true, { deniedAmount: 150, insurancePaid: 0 }) === true);
ok("E detect covered+none → false (deductible GUARD)", dc(true, { deniedAmount: 0, insurancePaid: 0 }) === false);
ok("E detect covered+paid → false", dc(true, { deniedAmount: 0, insurancePaid: 100 }) === false);
ok("E detect not_covered+denied → false (consistent denial, not a contradiction)", dc(false, { deniedAmount: 150, insurancePaid: 0 }) === false);
ok("E detect covered+null insurer → false (unevaluated)", dc(true, null) === false);

// SURFACE — computeCostShareV2 exposes the engine's OWN coverageDecision (the recovery-math:514
// value), not a re-derivation: it deep-equals resolveCoverageForLine(service, insurer) on the same inputs.
{
  const args = mk({ covered: true, copay: 20, coinsurance: null, deductibleApplies: null, userStatedRate: false }, { deniedAmount: 150 });
  const r = computeCostShareV2(args);
  eq("E surface == resolveCoverageForLine(service, insurer)", r.coverageDecision, resolveCoverageForLine(args.service, args.insurer));
  ok("E surface derivedStatus == contradiction (covered+denied)", r.coverageDecision.derivedStatus === "contradiction", r.coverageDecision.derivedStatus);
}

// ── Report ───────────────────────────────────────────────────────────────────
if (fails.length === 0) {
  console.log(`coverage-decision-parity: ALL GREEN ✓ (${pass} checks)`);
  process.exit(0);
} else {
  console.error(`coverage-decision-parity: ${fails.length} FAILED (${pass} passed)\n${fails.join("\n")}`);
  process.exit(1);
}
