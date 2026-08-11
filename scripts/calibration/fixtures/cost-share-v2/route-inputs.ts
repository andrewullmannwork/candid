/**
 * Cost-Share v2 (S214) — Step 3 route-input assembly fixtures.
 *
 * Locks the route-side input builders (the only pieces the detail + list routes
 * share verbatim) so the two routes can never drift on how a raw
 * claim_line_items row becomes engine inputs:
 *   - buildLineInsurer (member_* → InsurerAdjudication; insurance_paid RAW)
 *   - coerceNetworkTier / coerceNetworkOverride (string → tier, fail-safe null)
 *   - isFamilyTier (accumulator-key isIndividual ↔ engine param pick)
 * Plus two end-to-end assertions feeding a raw-row shape through the assembly
 * into computeCostShareV2 — the two launch oracle bills:
 *   - cf91a49e HDHP pre-deductible → verdict 'correct', recovery $0 (the fix)
 *   - $20-copay overpaid bill        → verdict 'recovery', refund ~$272.41 (no regress)
 *
 * Run: npx tsx scripts/calibration/fixtures/cost-share-v2/route-inputs.ts
 */
import {
  buildLineInsurer,
  coerceNetworkTier,
  coerceNetworkOverride,
  buildServiceCostShare,
  EMPTY_PLAN_COST_SHARE_PARAMS,
} from "../../../../src/lib/claims/cost-share-loader";
import {
  computeCostShareV2,
  isFamilyTier,
  type PlanCostShareParams,
} from "../../../../src/lib/claims/recovery-math";

let pass = 0;
const fails: string[] = [];
function check(name: string, cond: boolean, got?: unknown, want?: unknown) {
  if (cond) pass++;
  else fails.push(`✗ ${name}  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
}
const near = (a: number, b: number, eps = 0.01) => Math.abs(a - b) <= eps;

const NO_OVERRIDES = {
  deductibleMet: null,
  deductibleMetAsOf: null,
  oopMet: null,
  oopMetAsOf: null,
  userNetworkOverride: null,
} as const;

// ── R1 — buildLineInsurer: numeric coercion + insurance_paid null-preserving ──
{
  const allNull = buildLineInsurer({
    member_applied_to_deductible: null,
    member_coinsurance: null,
    member_copay: null,
    denied_amount: null,
    insurance_paid: null,
  });
  check("R1 all-null insurer", allNull.memberAppliedToDeductible === null && allNull.insurancePaid === null, allNull);

  const populated = buildLineInsurer({
    member_applied_to_deductible: "150",
    member_coinsurance: 40,
    member_copay: 0,
    denied_amount: 12.5,
    insurance_paid: 0,
  });
  check("R1 numeric coercion (string→num)", populated.memberAppliedToDeductible === 150, populated.memberAppliedToDeductible, 150);
  check("R1 member_copay 0 kept (not null)", populated.memberCopay === 0, populated.memberCopay, 0);
  check("R1 denied 12.5", near(populated.deniedAmount ?? -1, 12.5), populated.deniedAmount);
  // Gap G — insurance_paid===0 must stay 0 (NOT coerced to null); null stays null.
  check("R1 insurance_paid 0 preserved", populated.insurancePaid === 0, populated.insurancePaid, 0);
}

// ── R2 — coerceNetworkTier / coerceNetworkOverride (fail-safe) ──
{
  check("R2 tier in_network", coerceNetworkTier("in_network") === "in_network");
  check("R2 tier out_of_network", coerceNetworkTier("out_of_network") === "out_of_network");
  check("R2 tier tiered", coerceNetworkTier("tiered") === "tiered");
  check("R2 tier unknown", coerceNetworkTier("unknown") === "unknown");
  check("R2 tier null→null", coerceNetworkTier(null) === null);
  check("R2 tier junk→null", coerceNetworkTier("ppo") === null);
  // override accepts ONLY in/out (a deliberate user correction).
  check("R2 override in", coerceNetworkOverride("in_network") === "in_network");
  check("R2 override out", coerceNetworkOverride("out_of_network") === "out_of_network");
  check("R2 override tiered→null", coerceNetworkOverride("tiered") === null);
  check("R2 override null→null", coerceNetworkOverride(null) === null);
}

// ── R3 — isFamilyTier (must match the engine's internal param pick) ──
{
  check("R3 family", isFamilyTier("family") === true);
  check("R3 individual→false", isFamilyTier("individual") === false);
  check("R3 self→false", isFamilyTier("self") === false);
  check("R3 null→false", isFamilyTier(null) === false);
  check("R3 employee+spouse→family", isFamilyTier("Employee + Spouse") === true);
}

// ── R4 — END-TO-END: cf91a49e HDHP pre-deductible (the launch-blocker fix) ──
// Raw sparse row (insurer $0, owed $0 — the isMysteryGap shape) but patient paid
// the real allowed $163.27. allowed is the route's header-prorated value.
{
  const item = {
    billed_amount: 221,
    member_applied_to_deductible: null,
    member_coinsurance: null,
    member_copay: null,
    denied_amount: null,
    insurance_paid: 0,
    patient_owes: 0,
    network_status: null,
  };
  const plan: PlanCostShareParams = {
    ...EMPTY_PLAN_COST_SHARE_PARAMS,
    inDeductibleIndividual: 7050,
    inOopMaxIndividual: 7050, // HDHP: deductible == oop-max
    coverageTier: "individual",
  };
  const cs = computeCostShareV2({
    line: { billed: 221, allowed: 163.27, insuranceAdjusted: 57.73, patientPaid: 163.27, patientResponsibility: 0 },
    service: buildServiceCostShare({ covered: true, copay: null, coinsurance: null, deductibleApplies: null }, true),
    insurer: buildLineInsurer(item),
    plan,
    accumulator: null,
    overrides: { ...NO_OVERRIDES },
    networkLine: coerceNetworkTier(item.network_status),
    networkClaim: null,
    minRecovery: 1,
  });
  check("R4 cf91a49e verdict 'correct'", cs.verdict === "correct", cs.verdict, "correct");
  check("R4 cf91a49e recovery $0", near(cs.potentialRecovery, 0), cs.potentialRecovery, 0);
  check("R4 cf91a49e shouldOwe = full allowed $163.27", near(cs.shouldOwe, 163.27), cs.shouldOwe, 163.27);
  check("R4 cf91a49e NOT suppressed-as-recovery", cs.verdict !== "recovery", cs.verdict);
  // assumptions surfaced (network default + deductible-not-met $7,050).
  const dedAssump = cs.assumptions.find((a) => a.field === "deductible_met");
  check("R4 cf91a49e deductible-not-met assumption @ $7,050", !!dedAssump && near(dedAssump.value ?? -1, 7050), dedAssump);
}

// ── R5 — END-TO-END: $20-copay overpaid bill (must STAY a dispute) ──
{
  const item = {
    member_applied_to_deductible: null,
    member_coinsurance: null,
    member_copay: null,
    denied_amount: null,
    insurance_paid: 0,
    patient_owes: 0,
    network_status: null,
  };
  const plan: PlanCostShareParams = {
    ...EMPTY_PLAN_COST_SHARE_PARAMS,
    inDeductibleIndividual: 5000,
    inOopMaxIndividual: 8000,
    coverageTier: "individual",
  };
  const cs = computeCostShareV2({
    line: { billed: 292.41, allowed: 292.41, insuranceAdjusted: 0, patientPaid: 292.41, patientResponsibility: 0 },
    // copay service, deductible-exempt → copay branch (NOT deductible phase).
    service: buildServiceCostShare({ covered: true, copay: 20, coinsurance: null, deductibleApplies: false }, true),
    insurer: buildLineInsurer(item),
    plan,
    accumulator: null,
    overrides: { ...NO_OVERRIDES },
    networkLine: coerceNetworkTier(item.network_status),
    networkClaim: null,
    minRecovery: 1,
  });
  check("R5 copay verdict 'recovery'", cs.verdict === "recovery", cs.verdict, "recovery");
  check("R5 copay refund ~$272.41", near(cs.refundComponent, 272.41), cs.refundComponent, 272.41);
  check("R5 copay shouldOwe $20", near(cs.shouldOwe, 20), cs.shouldOwe, 20);
}

// ── R6 — ZERO-deductible plan: a coinsurance service must apply coinsurance, NOT charge
// the full allowed toward a non-existent deductible (the Cigna-PPO bug — e23817b6 L2).
// deductibleMax=0 → deductible trivially met → post_deductible phase. No accumulator. ──
{
  const item = {
    member_applied_to_deductible: null, member_coinsurance: null, member_copay: null,
    denied_amount: null, insurance_paid: 0, patient_owes: 0, network_status: null,
  };
  const plan: PlanCostShareParams = {
    ...EMPTY_PLAN_COST_SHARE_PARAMS,
    inDeductibleIndividual: 0, // $0 deductible (genuinely zero, not unparsed/null)
    inOopMaxIndividual: 3000,
    coverageTier: "individual",
  };
  const cs = computeCostShareV2({
    line: { billed: 89, allowed: 41.1, insuranceAdjusted: 47.9, patientPaid: 0, patientResponsibility: 0 },
    service: buildServiceCostShare({ covered: true, copay: null, coinsurance: 0.1, deductibleApplies: null }, true),
    insurer: buildLineInsurer(item),
    plan,
    accumulator: null,
    overrides: { ...NO_OVERRIDES },
    networkLine: coerceNetworkTier(item.network_status),
    networkClaim: null,
    minRecovery: 1,
  });
  check("R6 zero-ded coinsurance shouldOwe = 10% allowed $4.11", near(cs.shouldOwe, 4.11), cs.shouldOwe, 4.11);
  check("R6 zero-ded phase post_deductible (NOT deductible_unmet)", cs.phase === "post_deductible", cs.phase, "post_deductible");
  // $0 deductible is KNOWN-met → no deductible_met assumption surfaced.
  check("R6 zero-ded no deductible_met assumption", !cs.assumptions.some((a) => a.field === "deductible_met"), cs.assumptions.map((a) => a.field));
}

if (fails.length) {
  console.error(`\ncost-share-v2 route-input fixtures: ${pass} passed, ${fails.length} failed`);
  for (const f of fails) console.error("  " + f);
  process.exit(1);
}
console.log(`\ncost-share-v2 route-input fixtures: ${pass} passed, 0 failed`);
console.log("ALL GREEN ✓");
