/**
 * Accumulator ledger — Phase 1 fixture (cross-bill deductible/OOP threading + family).
 *
 * Oracles are HAND-COMPUTED (independent of the engine):
 *   A. "Maya" from the approved explainer — solo, $2,000 ded / 20% coins / $6,000 OOP,
 *      asserted at every phase transition by running growing subsets of her year.
 *   B. Network routing — an out-of-network line lands in the `out` bucket.
 *   C. Family AGGREGATE — all members pool into one D_fam / OOP_fam accumulator.
 *   D. Family EMBEDDED — per-member D_ind/OOP_ind + a D_fam/OOP_fam cap; a member starts
 *      sharing once EITHER their own deductible OR the family cap is met.
 *
 * Run: npx tsx scripts/calibration/fixtures/cost-share-v2/accumulator-ledger.ts
 * Exits non-zero on any failure (gate-usable).
 */
import {
  computeAccumulatorLedger,
  UNASSIGNED_MEMBER,
  type AccumulatorLedgerClaim,
  type LedgerMember,
} from "../../../../src/lib/claims/accumulator-ledger";
import type {
  PlanCostShareParams,
  ServiceCostShare,
  InsurerAdjudication,
} from "../../../../src/lib/claims/recovery-math";

let pass = 0;
const fails: string[] = [];
function eq(name: string, got: unknown, want: unknown) {
  if (got === want) pass++;
  else fails.push(`  ✗ ${name}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
}

const COVERED_20: ServiceCostShare = { covered: true, copay: null, coinsurance: 0.2, deductibleApplies: true };
const NO_INSURER: InsurerAdjudication = {
  memberAppliedToDeductible: null,
  memberCoinsurance: null,
  memberCopay: null,
  deniedAmount: null,
  insurancePaid: null,
};

function claim(
  id: string,
  date: string,
  amount: number,
  opts: { network?: string; member?: string; rx?: boolean; provider?: string } = {},
): AccumulatorLedgerClaim {
  return {
    claimId: id,
    serviceDate: date,
    claimInsurerPaidZero: false,
    memberKey: opts.member ?? "holder",
    providerKey: opts.provider ?? null,
    lines: [
      {
        serviceDate: date,
        billed: amount,
        allowed: amount,
        insuranceAdjusted: 0,
        patientPaid: 0,
        patientResponsibility: 0,
        networkStatus: opts.network ?? "in_network",
        service: COVERED_20,
        insurer: NO_INSURER,
        isPreventive: false,
        isRx: opts.rx ?? false,
      },
    ],
  };
}

// ── A. Maya (solo / individual) ──────────────────────────────────────────────
const MAYA_PLAN: PlanCostShareParams = {
  inDeductibleIndividual: 2000,
  inDeductibleFamily: null,
  outDeductibleIndividual: 6000,
  outDeductibleFamily: null,
  inOopMaxIndividual: 6000,
  inOopMaxFamily: null,
  outOopMaxIndividual: 12000,
  outOopMaxFamily: null,
  inCoinsuranceDefault: 0.2,
  outCoinsuranceDefault: 0.4,
  deductibleCalcMethod: null,
  combinedMedicalRxOop: null,
  coverageTier: "individual",
};
const JAN = claim("c1-jan", "2026-01-15", 300);
const MAR = claim("c2-mar", "2026-03-10", 1700);
const JUN = claim("c3-jun", "2026-06-05", 10000);
const SEP = claim("c4-sep", "2026-09-20", 15000);
const NOV = claim("c5-nov", "2026-11-02", 2500);
const mayaIn = (claims: AccumulatorLedgerClaim[]) =>
  computeAccumulatorLedger({ plan: MAYA_PLAN, planYear: 2026, claims, hasDependents: false }).individual!.in;

const STEPS = [
  { label: "Jan (pre-deductible)", claims: [JAN], ded: 300, oop: 300 },
  { label: "Mar (deductible met)", claims: [JAN, MAR], ded: 2000, oop: 2000 },
  { label: "Jun (coinsurance)", claims: [JAN, MAR, JUN], ded: 2000, oop: 4000 },
  { label: "Sep (OOP-max cap)", claims: [JAN, MAR, JUN, SEP], ded: 2000, oop: 6000 },
  { label: "Nov (post-OOP $0)", claims: [JAN, MAR, JUN, SEP, NOV], ded: 2000, oop: 6000 },
];
for (const s of STEPS) {
  const inn = mayaIn(s.claims);
  eq(`${s.label} — deductible`, inn.deductible.candidApplied, s.ded);
  eq(`${s.label} — oop`, inn.oop.candidApplied, s.oop);
}
const mFinal = mayaIn([JAN, MAR, JUN, SEP, NOV]);
eq("Maya final — deductible met", mFinal.deductible.met, true);
eq("Maya final — oop met", mFinal.oop.met, true);
eq("Maya final — deductible remaining", mFinal.deductible.remaining, 0);
eq("Maya final — deductible max", mFinal.deductible.max, 2000);
eq("Maya final — oop max", mFinal.oop.max, 6000);
eq("Maya scope", computeAccumulatorLedger({ plan: MAYA_PLAN, planYear: 2026, claims: [JAN], hasDependents: false }).scope, "individual");

// ── B. Network routing ───────────────────────────────────────────────────────
const oon = computeAccumulatorLedger({
  plan: MAYA_PLAN,
  planYear: 2026,
  claims: [claim("oon-1", "2026-02-01", 500, { network: "out_of_network" })],
  hasDependents: false,
}).individual!;
eq("OON → out bucket", oon.out.deductible.candidApplied, 500);
eq("OON → in untouched", oon.in.deductible.candidApplied, 0);
eq("OON → out denominator", oon.out.deductible.max, 6000);

// ── C. Family AGGREGATE (all members pool) ───────────────────────────────────
const FAMILY_PLAN = (method: "embedded" | "aggregate"): PlanCostShareParams => ({
  inDeductibleIndividual: 2000,
  inDeductibleFamily: 4000,
  outDeductibleIndividual: 6000,
  outDeductibleFamily: 12000,
  inOopMaxIndividual: 6000,
  inOopMaxFamily: 12000,
  outOopMaxIndividual: 12000,
  outOopMaxFamily: 24000,
  inCoinsuranceDefault: 0.2,
  outCoinsuranceDefault: 0.4,
  deductibleCalcMethod: method,
  combinedMedicalRxOop: null,
  coverageTier: "family",
});
const agg = computeAccumulatorLedger({
  plan: FAMILY_PLAN("aggregate"),
  planYear: 2026,
  claims: [
    claim("a1", "2026-01-10", 1500, { member: "holder" }),
    claim("a2", "2026-02-10", 1500, { member: "spouse" }),
    claim("a3", "2026-03-10", 2000, { member: "holder" }), // $1000 finishes ded, $1000 → 20% = $200
  ],
  hasDependents: true,
});
eq("aggregate scope", agg.scope, "family_aggregate");
eq("aggregate — family deductible met", agg.familyAggregate!.in.deductible.candidApplied, 4000);
eq("aggregate — family deductible is met", agg.familyAggregate!.in.deductible.met, true);
eq("aggregate — family oop", agg.familyAggregate!.in.oop.candidApplied, 4200);

// ── D. Family EMBEDDED (per-member + cap; member shares early once cap met) ───
const emb = computeAccumulatorLedger({
  plan: FAMILY_PLAN("embedded"),
  planYear: 2026,
  claims: [
    claim("e1", "2026-01-10", 2000, { member: "holder" }), // holder ind met (2000); cap 2000
    claim("e2", "2026-02-10", 1500, { member: "spouse" }), // spouse ded 1500; cap 3500
    claim("e3", "2026-03-10", 1000, { member: "child" }), // cap has $500 left → $500 ded + $500@20%=$100; cap met
  ],
  hasDependents: true,
});
eq("embedded scope", emb.scope, "family_embedded");
const byKey = (k: string): LedgerMember | undefined => emb.familyEmbedded!.members.find((m) => m.memberKey === k);
eq("embedded — holder ded met", byKey("holder")!.buckets.in.deductible.candidApplied, 2000);
eq("embedded — holder ded is met", byKey("holder")!.buckets.in.deductible.met, true);
eq("embedded — spouse ded (partial)", byKey("spouse")!.buckets.in.deductible.candidApplied, 1500);
eq("embedded — spouse ded not met", byKey("spouse")!.buckets.in.deductible.met, false);
eq("embedded — child ded (cap-capped $500)", byKey("child")!.buckets.in.deductible.candidApplied, 500);
eq("embedded — child oop ($500 ded + $100 coins)", byKey("child")!.buckets.in.oop.candidApplied, 600);
eq("embedded — family cap deductible met", emb.familyEmbedded!.cap.in.deductible.candidApplied, 4000);
eq("embedded — family cap is met", emb.familyEmbedded!.cap.in.deductible.met, true);
eq("embedded — family cap oop", emb.familyEmbedded!.cap.in.oop.candidApplied, 4100);
eq("embedded — member denominator = individual", byKey("holder")!.buckets.in.deductible.max, 2000);
eq("embedded — cap denominator = family", emb.familyEmbedded!.cap.in.deductible.max, 4000);

// ── E. Unassigned bills count toward the family cap only ──────────────────────
const unassigned = computeAccumulatorLedger({
  plan: FAMILY_PLAN("embedded"),
  planYear: 2026,
  claims: [claim("u1", "2026-01-05", 800, { member: UNASSIGNED_MEMBER })],
  hasDependents: true,
});
eq("unassigned → cap deductible", unassigned.familyEmbedded!.cap.in.deductible.candidApplied, 800);
eq("unassigned → no member rows", unassigned.familyEmbedded!.members.length, 0);

// ── F. Rx bucket — separate Rx deductible; Rx OOP folds into the shared OOP ────
const RX_PLAN: PlanCostShareParams = {
  inDeductibleIndividual: 1000,
  inDeductibleFamily: null,
  outDeductibleIndividual: null,
  outDeductibleFamily: null,
  inOopMaxIndividual: 5000,
  inOopMaxFamily: null,
  outOopMaxIndividual: null,
  outOopMaxFamily: null,
  inCoinsuranceDefault: 0.2,
  outCoinsuranceDefault: null,
  deductibleCalcMethod: null,
  combinedMedicalRxOop: true,
  coverageTier: "individual",
};
const rxLedger = computeAccumulatorLedger({
  plan: RX_PLAN,
  planYear: 2026,
  hasDependents: false,
  rxDeductibleIndividual: 200,
  claims: [
    claim("r1", "2026-01-10", 600), // medical: $600 → med ded 600; oop 600
    claim("r2", "2026-02-10", 150, { rx: true }), // rx: $150 → rx ded 150; oop 750
    claim("r3", "2026-03-10", 100, { rx: true }), // rx: $50 ded (met 200) + $50@20%=$10; oop 810
    claim("r4", "2026-04-10", 500), // medical: $400 ded (met 1000) + $100@20%=$20; oop 1230
  ],
});
eq("rx — medical deductible met", rxLedger.individual!.in.deductible.candidApplied, 1000);
eq("rx — medical deductible is met", rxLedger.individual!.in.deductible.met, true);
eq("rx — Rx deductible met", rxLedger.rxDeductible!.candidApplied, 200);
eq("rx — Rx deductible is met", rxLedger.rxDeductible!.met, true);
eq("rx — Rx denominator", rxLedger.rxDeductible!.max, 200);
eq("rx — shared OOP (medical + Rx)", rxLedger.individual!.in.oop.candidApplied, 1230);
const noRx = computeAccumulatorLedger({ plan: MAYA_PLAN, planYear: 2026, claims: [JAN], hasDependents: false });
eq("no-rx → rxDeductible omitted", noRx.rxDeductible, undefined);

// ── G. Dedup — exact-duplicate claims collapse; different provider kept ────────
const dedupLedger = computeAccumulatorLedger({
  plan: MAYA_PLAN,
  planYear: 2026,
  hasDependents: false,
  claims: [
    claim("dup-a", "2026-05-01", 400),
    claim("dup-b", "2026-05-01", 400), // exact dup of dup-a → dropped
    claim("dup-c", "2026-05-01", 400, { provider: "other" }), // different provider → kept
  ],
});
eq("dedup — droppedDuplicates", dedupLedger.droppedDuplicates, 1);
eq("dedup — billsCounted after collapse", dedupLedger.billsCounted, 2);
eq("dedup — deductible counts 2×$400 not 3×", dedupLedger.individual!.in.deductible.candidApplied, 800);

console.log(`\naccumulator-ledger fixture: ${pass} passed, ${fails.length} failed`);
if (fails.length) {
  console.log(fails.join("\n"));
  process.exit(1);
}
process.exit(0);
