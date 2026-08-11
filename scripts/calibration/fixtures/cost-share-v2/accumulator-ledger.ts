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
  type InsurerAccumulatorRow,
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

const COVERED_20: ServiceCostShare = { covered: true, copay: null, coinsurance: 0.2, deductibleApplies: true, userStatedRate: false };
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
  opts: {
    network?: string;
    member?: string;
    rx?: boolean;
    provider?: string;
    service?: ServiceCostShare;
    insurer?: InsurerAccumulatorRow[];
  } = {},
): AccumulatorLedgerClaim {
  return {
    claimId: id,
    serviceDate: date,
    claimInsurerPaidZero: false,
    memberKey: opts.member ?? "holder",
    providerKey: opts.provider ?? null,
    insurerAccumulators: opts.insurer,
    lines: [
      {
        serviceDate: date,
        billed: amount,
        allowed: amount,
        insuranceAdjusted: 0,
        patientPaid: 0,
        patientResponsibility: 0,
        networkStatus: opts.network ?? "in_network",
        service: opts.service ?? COVERED_20,
        insurer: NO_INSURER,
        isPreventive: false,
        isRx: opts.rx ?? false,
      },
    ],
  };
}

const insMed = (
  ded: number | null,
  oop: number | null,
  net = "in_network",
  type = "medical",
): InsurerAccumulatorRow => ({
  networkTier: net,
  accumulatorType: type,
  isIndividual: true,
  deductibleApplied: ded,
  oopApplied: oop,
});

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

// ── H. Divergence — Candid's tally vs the insurer's reported accumulator (§9) ──
// threshold on the $2,000 deductible = max($25, 2%·$2,000=$40) = $40.
const dedDiv = (l: ReturnType<typeof computeAccumulatorLedger>) => l.individual!.in.deductible.divergence;

// H1 — insurer BEHIND, current EOB, grounded tally → flagged.
const h1 = computeAccumulatorLedger({
  plan: MAYA_PLAN,
  planYear: 2026,
  hasDependents: false,
  claims: [claim("h1", "2026-01-15", 300, { insurer: [insMed(0, 300)] })],
});
eq("H1 direction insurer_behind", dedDiv(h1)?.direction, "insurer_behind");
eq("H1 gap $300", dedDiv(h1)?.gap, 300);
eq("H1 flagged", dedDiv(h1)?.flagged, true);

// H2 — insurer AHEAD (they processed bills we haven't got) → nudge, flagged, no timing gate.
const h2 = computeAccumulatorLedger({
  plan: MAYA_PLAN,
  planYear: 2026,
  hasDependents: false,
  claims: [claim("h2", "2026-02-01", 300, { insurer: [insMed(1200, 1200)] })],
});
eq("H2 direction insurer_ahead", dedDiv(h2)?.direction, "insurer_ahead");
eq("H2 flagged", dedDiv(h2)?.flagged, true);

// H3 — sub-threshold ($10 < $40) → match, not flagged.
const h3 = computeAccumulatorLedger({
  plan: MAYA_PLAN,
  planYear: 2026,
  hasDependents: false,
  claims: [claim("h3", "2026-01-15", 300, { insurer: [insMed(290, 300)] })],
});
eq("H3 direction match", dedDiv(h3)?.direction, "match");
eq("H3 not flagged", dedDiv(h3)?.flagged, false);

// H4 — insurer reports only a COMBINED block → not like-for-like → suppressed.
const h4 = computeAccumulatorLedger({
  plan: MAYA_PLAN,
  planYear: 2026,
  hasDependents: false,
  claims: [claim("h4", "2026-01-15", 300, { insurer: [insMed(0, 300, "in_network", "combined")] })],
});
eq("H4 combined not flagged", dedDiv(h4)?.flagged, false);
eq("H4 reason type_mismatch", dedDiv(h4)?.suppressedReason, "type_mismatch");

// H5 — insurer behind but only current through an EARLIER bill (no accumulator on the
// newer bill) → expected lag, not an error → suppressed.
const h5 = computeAccumulatorLedger({
  plan: MAYA_PLAN,
  planYear: 2026,
  hasDependents: false,
  claims: [
    claim("h5a", "2026-01-15", 300, { insurer: [insMed(300, 300)] }),
    claim("h5b", "2026-03-10", 300), // newer bill, no insurer accumulator
  ],
});
eq("H5 gap $300 (candid $600 vs insurer $300)", dedDiv(h5)?.gap, 300);
eq("H5 direction insurer_behind", dedDiv(h5)?.direction, "insurer_behind");
eq("H5 suppressed insurer_not_current", dedDiv(h5)?.suppressedReason, "insurer_not_current");
eq("H5 not flagged", dedDiv(h5)?.flagged, false);

// H6 — our OWN tally is an estimate (post-deductible line whose share the plan can't
// pin down: unknown service coinsurance AND no plan coinsurance default) → we can't
// accuse the insurer → suppressed.
const UNKNOWN_SVC: ServiceCostShare = { covered: true, copay: null, coinsurance: null, deductibleApplies: true, userStatedRate: false };
const NO_DEFAULT_PLAN: PlanCostShareParams = { ...MAYA_PLAN, inCoinsuranceDefault: null };
const h6 = computeAccumulatorLedger({
  plan: NO_DEFAULT_PLAN,
  planYear: 2026,
  hasDependents: false,
  claims: [
    claim("h6a", "2026-02-01", 2000), // meets the deductible (grounded)
    claim("h6b", "2026-06-01", 5000, { service: UNKNOWN_SVC, insurer: [insMed(2000, 2000)] }),
  ],
});
eq("H6 oop tally estimated", h6.individual!.in.oop.confidence, "estimated");
eq("H6 oop divergence suppressed estimated_tally", h6.individual!.in.oop.divergence?.suppressedReason, "estimated_tally");
eq("H6 oop not flagged", h6.individual!.in.oop.divergence?.flagged, false);

console.log(`\naccumulator-ledger fixture: ${pass} passed, ${fails.length} failed`);
if (fails.length) {
  console.log(fails.join("\n"));
  process.exit(1);
}
process.exit(0);
