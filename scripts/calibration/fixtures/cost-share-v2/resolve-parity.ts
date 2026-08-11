/**
 * §18.9 incr-1 PARITY GATE — resolveCostShareForLine == the inline route assembly.
 *
 * Proves the shared resolution layer (src/lib/claims/resolve-cost-share.ts) produces a
 * byte-identical CostShareV2Result to the inline computeCostShareV2 assembly the card
 * routes run, for the same (line, ctx). MUST be green BEFORE the routes are swapped to
 * call it (claims/route.ts:488 list, claims/[claimId]/route.ts:539 detail).
 *
 * The "inline" side reproduces the route's exact per-line assembly (network coerce +
 * accumulator resolve + service/insurer build + computeCostShareV2); the "shared" side is
 * resolveCostShareForLine. Deep-equal of the full result = parity. The divergent prep
 * (allowed/insuranceAdjusted/patientResponsibility/coverage) is supplied identically to
 * both — the function takes it as input precisely so each route stays byte-identical.
 *
 * Run: npx tsx scripts/calibration/fixtures/cost-share-v2/resolve-parity.ts
 */
import {
  computeCostShareV2,
  isFamilyTier,
  type PlanCostShareParams,
  type PlanCoverageInput,
} from "../../../../src/lib/claims/recovery-math";
import {
  buildLineInsurer,
  buildServiceCostShare,
  coerceNetworkTier,
  resolveAccumulatorForLine,
  applyPreClaimAdjustment,
  EMPTY_PLAN_COST_SHARE_PARAMS,
  type RawAccumulator,
  type CostShareGate,
} from "../../../../src/lib/claims/cost-share-loader";
import {
  resolveCostShareForLine,
  type CostShareClaimCtx,
  type CostShareLineInput,
} from "../../../../src/lib/claims/resolve-cost-share";

let pass = 0;
const fails: string[] = [];
function eq(name: string, shared: unknown, inline: unknown) {
  const A = JSON.stringify(shared);
  const B = JSON.stringify(inline);
  if (A === B) pass++;
  else fails.push(`✗ ${name}\n    shared=${A}\n    inline=${B}`);
}

const NO_OVERRIDES = {
  deductibleMet: null,
  deductibleMetAsOf: null,
  oopMet: null,
  oopMetAsOf: null,
  userNetworkOverride: null,
} as const;
const GATE: CostShareGate = { minRecovery: 1 };

interface Scenario {
  item: Record<string, unknown>;
  plan: PlanCostShareParams;
  coverage: PlanCoverageInput | null;
  /** S308 — fed identically to both sides (inline mirror + lib). */
  exactCoverageMatch: boolean;
  billed: number;
  allowed: number;
  insuranceAdjusted: number;
  patientPaid: number;
  patientResponsibility: number;
  networkStatus: string | null;
  accRows?: RawAccumulator[];
  memberSums?: { deductible: number; oop: number };
  preventive?: boolean;
  acaStatus?: "confirmed" | "unknown" | "non_aca";
  claimInsurerPaidZero?: boolean;
  networkClaim?: ReturnType<typeof coerceNetworkTier>;
  coverageTier?: string | null;
  planYear?: number | null;
}

function parity(name: string, s: Scenario) {
  const accRows = s.accRows ?? [];
  const memberSums = s.memberSums ?? { deductible: 0, oop: 0 };
  const acaStatus = s.acaStatus ?? "unknown";
  const claimInsurerPaidZero = s.claimInsurerPaidZero ?? false;
  const networkClaim = s.networkClaim ?? null;
  const coverageTier = s.coverageTier ?? null;
  const planYear = s.planYear ?? null;
  const preventive = s.preventive ?? false;

  // (a) INLINE — exactly the route's per-line assembly at the call site.
  const lineNetwork = coerceNetworkTier(s.networkStatus);
  const accumulator = applyPreClaimAdjustment(
    resolveAccumulatorForLine(accRows, {
      benefitYear: planYear != null ? String(planYear) : null,
      networkTier: lineNetwork ?? "in_network",
      accumulatorType: "medical",
      isIndividual: !isFamilyTier(coverageTier),
    }),
    memberSums,
  );
  const inline = computeCostShareV2({
    line: {
      billed: s.billed,
      allowed: s.allowed,
      insuranceAdjusted: s.insuranceAdjusted,
      patientPaid: s.patientPaid,
      patientResponsibility: s.patientResponsibility,
    },
    service: buildServiceCostShare(s.coverage, s.exactCoverageMatch),
    insurer: buildLineInsurer(s.item),
    plan: s.plan,
    accumulator,
    overrides: { ...NO_OVERRIDES },
    networkLine: lineNetwork,
    networkClaim,
    minRecovery: GATE.minRecovery,
    preventive: { isPreventive: preventive, acaStatus },
    claimInsurerPaidZero,
  });

  // (b) SHARED — resolveCostShareForLine with the equivalent (line, ctx).
  const ctx: CostShareClaimCtx = {
    planParams: s.plan,
    overrides: { ...NO_OVERRIDES },
    accRows,
    memberSums,
    preventiveLines: preventive ? new Set([1]) : new Set<number>(),
    acaStatus,
    claimInsurerPaidZero,
    gate: GATE,
    networkClaim,
    coverageTier,
    planYear,
  };
  const line: CostShareLineInput = {
    exactCoverageMatch: s.exactCoverageMatch,
    lineNumber: 1,
    billed: s.billed,
    allowed: s.allowed,
    insuranceAdjusted: s.insuranceAdjusted,
    patientPaid: s.patientPaid,
    patientResponsibility: s.patientResponsibility,
    coverage: s.coverage,
    networkStatus: s.networkStatus,
    raw: s.item,
  };
  const shared = resolveCostShareForLine(line, ctx);

  eq(name, shared, inline);
}

// P1 — cf91a49e HDHP pre-deductible (the launch-blocker fix; route-inputs R4).
parity("P1 cf91a49e HDHP pre-deductible", {
  item: { billed_amount: 221, member_applied_to_deductible: null, member_coinsurance: null, member_copay: null, denied_amount: null, insurance_paid: 0, patient_owes: 0, network_status: null },
  plan: { ...EMPTY_PLAN_COST_SHARE_PARAMS, inDeductibleIndividual: 7050, inOopMaxIndividual: 7050, coverageTier: "individual" },
  coverage: { covered: true, copay: null, coinsurance: null, deductibleApplies: null },
  exactCoverageMatch: true,
  billed: 221, allowed: 163.27, insuranceAdjusted: 57.73, patientPaid: 163.27, patientResponsibility: 0,
  networkStatus: null, coverageTier: "individual",
});

// P2 — $20-copay overpaid bill (must stay a dispute; route-inputs R5).
parity("P2 $20 copay overpaid", {
  item: { member_applied_to_deductible: null, member_coinsurance: null, member_copay: null, denied_amount: null, insurance_paid: 0, patient_owes: 0, network_status: null },
  plan: { ...EMPTY_PLAN_COST_SHARE_PARAMS, inDeductibleIndividual: 5000, inOopMaxIndividual: 8000, coverageTier: "individual" },
  coverage: { covered: true, copay: 20, coinsurance: null, deductibleApplies: false },
  exactCoverageMatch: true,
  billed: 292.41, allowed: 292.41, insuranceAdjusted: 0, patientPaid: 292.41, patientResponsibility: 0,
  networkStatus: null, coverageTier: "individual",
});

// P3 — coinsurance + OON + non-zero patientResponsibility (the divergent prep is passed in,
// so the shared fn must honor it verbatim — proves the boundary).
parity("P3 coinsurance OON, patientResp passed-in", {
  item: { member_applied_to_deductible: 200, member_coinsurance: 80, member_copay: 0, denied_amount: null, insurance_paid: 500, patient_owes: 180, network_status: "out_of_network" },
  plan: { ...EMPTY_PLAN_COST_SHARE_PARAMS, inDeductibleIndividual: 2000, outDeductibleIndividual: 4000, inOopMaxIndividual: 6000, outOopMaxIndividual: 12000, inCoinsuranceDefault: 0.2, outCoinsuranceDefault: 0.4, coverageTier: "individual" },
  coverage: { covered: true, copay: null, coinsurance: 0.4, deductibleApplies: true },
  exactCoverageMatch: true,
  billed: 1000, allowed: 700, insuranceAdjusted: 300, patientPaid: 0, patientResponsibility: 180,
  networkStatus: "out_of_network", networkClaim: "out_of_network", coverageTier: "individual",
});

if (fails.length) {
  console.error(`\ncost-share-v2 resolve-parity: ${pass} passed, ${fails.length} failed`);
  for (const f of fails) console.error("  " + f);
  process.exit(1);
}
console.log(`\ncost-share-v2 resolve-parity: ${pass} passed, 0 failed`);
console.log("ALL GREEN ✓");
