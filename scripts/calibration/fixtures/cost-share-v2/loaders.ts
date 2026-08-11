/**
 * Cost-Share v2 (S214) — Step 2 loader fixtures (pure resolvers + ACA→engine).
 * Run: npx tsx scripts/calibration/fixtures/cost-share-v2/loaders.ts
 */
import {
  buildServiceCostShare,
  resolveAccumulatorForLine,
  applyPreClaimAdjustment,
  resolveOverridesForBill,
  mapRawAccumulator,
  type RawAccumulator,
} from "../../../../src/lib/claims/cost-share-loader";
import { pickCoverageRow } from "../../../../src/lib/audit/coverage-loader";
import {
  computeCostShareV2,
  type CostShareOverrides,
} from "../../../../src/lib/claims/recovery-math";

let pass = 0;
const fails: string[] = [];
function check(name: string, cond: boolean, got?: unknown, want?: unknown) {
  if (cond) pass++;
  else fails.push(`✗ ${name}  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
}
const near = (a: number, b: number, eps = 0.01) => Math.abs(a - b) <= eps;

// L1 — buildServiceCostShare carries the richer fields (incl. deductibleApplies).
{
  const s = buildServiceCostShare({ covered: true, copay: 25, coinsurance: 0.2, deductibleApplies: true, outCoinsurance: 0.4 }, false);
  check("L1 covered", s?.covered === true, s);
  check("L1 copay 25", s?.copay === 25, s);
  check("L1 deductibleApplies true", s?.deductibleApplies === true, s);
  check("L1 outCoinsurance 0.4", s?.outCoinsurance === 0.4, s);
  check("L1 null coverage → null", buildServiceCostShare(null, false) === null, buildServiceCostShare(null, false));
}

// L2 — ACA coverage (deductibleApplies=false) threads to the engine as copay-exempt,
//      NOT into the deductible phase: a $0 preventive paid $200 OOP → recover $200.
{
  const service = buildServiceCostShare({ covered: true, copay: 0, coinsurance: 0, deductibleApplies: false }, false);
  const r = computeCostShareV2({
    line: { billed: 200, allowed: 200, patientPaid: 200, patientResponsibility: 200 },
    service,
    insurer: { memberAppliedToDeductible: null, memberCoinsurance: null, memberCopay: null, deniedAmount: null, insurancePaid: null },
    plan: { inDeductibleIndividual: 5000, inDeductibleFamily: null, outDeductibleIndividual: null, outDeductibleFamily: null, inOopMaxIndividual: null, inOopMaxFamily: null, outOopMaxIndividual: null, outOopMaxFamily: null, inCoinsuranceDefault: null, outCoinsuranceDefault: null, deductibleCalcMethod: null, combinedMedicalRxOop: null, coverageTier: null },
    accumulator: null,
    overrides: { deductibleMet: null, deductibleMetAsOf: null, oopMet: null, oopMetAsOf: null, userNetworkOverride: null },
    networkLine: "in_network", networkClaim: null,
  });
  check("L2 ACA → copay_exempt (not deductible_unmet)", r.phase === "copay_exempt", r.phase);
  check("L2 shouldOwe 0", near(r.shouldOwe, 0), r.shouldOwe);
  check("L2 recover the $200 OOP on a $0 preventive", near(r.potentialRecovery, 200), r.potentialRecovery);
}

// L3 — resolveAccumulatorForLine: network alignment + type preference + null on miss.
{
  const rows: RawAccumulator[] = [
    { benefitYear: "2025", networkTier: "in_network", accumulatorType: "medical", isIndividual: true, deductibleApplied: 500, deductibleMax: 2000, oopApplied: 500, oopMax: 9000 },
    { benefitYear: "2025", networkTier: "out_of_network", accumulatorType: "medical", isIndividual: true, deductibleApplied: 100, deductibleMax: 4000, oopApplied: 100, oopMax: 14000 },
    { benefitYear: "2024", networkTier: "in_network", accumulatorType: "medical", isIndividual: true, deductibleApplied: 9, deductibleMax: 2000, oopApplied: 9, oopMax: 9000 },
  ];
  const inn = resolveAccumulatorForLine(rows, { benefitYear: "2025", networkTier: "in_network", accumulatorType: "medical", isIndividual: true });
  check("L3 picks in-network 2025 (applied 500)", inn?.deductibleApplied === 500, inn);
  const oon = resolveAccumulatorForLine(rows, { benefitYear: "2025", networkTier: "out_of_network", accumulatorType: "medical", isIndividual: true });
  check("L3 picks out-of-network (applied 100)", oon?.deductibleApplied === 100, oon);
  const miss = resolveAccumulatorForLine(rows, { benefitYear: "2025", networkTier: "tiered", accumulatorType: "medical", isIndividual: true });
  check("L3 no network match → null (conservative)", miss === null, miss);
  check("L3 empty rows → null", resolveAccumulatorForLine([], { benefitYear: "2025", networkTier: "in_network", accumulatorType: "medical", isIndividual: true }) === null, null);
}

// L4 — applyPreClaimAdjustment: subtract this claim's consumption → pre-claim snapshot.
{
  const post = { deductibleApplied: 2000, deductibleMax: 2000, oopApplied: 2000, oopMax: 9000 };
  const pre = applyPreClaimAdjustment(post, { deductible: 300, oop: 300 });
  check("L4 pre-claim deductibleApplied 1700", pre?.deductibleApplied === 1700, pre);
  check("L4 pre-claim oopApplied 1700", pre?.oopApplied === 1700, pre);
  check("L4 max unchanged", pre?.deductibleMax === 2000 && pre?.oopMax === 9000, pre);
  check("L4 clamps at 0", applyPreClaimAdjustment({ deductibleApplied: 100, deductibleMax: 2000, oopApplied: 100, oopMax: 9000 }, { deductible: 500, oop: 500 })?.deductibleApplied === 0, "clamp");
  check("L4 null snapshot → null", applyPreClaimAdjustment(null, { deductible: 1, oop: 1 }) === null, null);
}

// L5 — resolveOverridesForBill: "met as of {date}" only marks met for bills on/after it.
{
  const raw: CostShareOverrides = { deductibleMet: true, deductibleMetAsOf: "2025-03-01", oopMet: null, oopMetAsOf: null, userNetworkOverride: null };
  const after = resolveOverridesForBill(raw, "2025-04-15");
  check("L5 bill after asOf → met true", after.deductibleMet === true, after.deductibleMet);
  const before = resolveOverridesForBill(raw, "2025-02-10");
  check("L5 bill before asOf → known-not-met (false)", before.deductibleMet === false, before.deductibleMet);
  const noDate = resolveOverridesForBill(raw, null);
  check("L5 no bill date → met true (best-effort)", noDate.deductibleMet === true, noDate.deductibleMet);
  const notMet = resolveOverridesForBill({ ...raw, deductibleMet: null }, "2025-02-10");
  check("L5 null override stays null", notMet.deductibleMet === null, notMet.deductibleMet);
}

// L6 — mapRawAccumulator normalizes a DB row (snake_case → camel; NULL-safe).
{
  const m = mapRawAccumulator({ benefit_year: "2025", network_tier: "in_network", accumulator_type: "combined", is_individual: false, deductible_applied: 750, deductible_max: 3000, oop_applied: null, oop_max: null });
  check("L6 benefitYear", m.benefitYear === "2025", m);
  check("L6 isIndividual false", m.isIndividual === false, m);
  check("L6 accumulatorType combined", m.accumulatorType === "combined", m);
  check("L6 null oop preserved", m.oopApplied === null, m);
}

console.log(`\ncost-share-v2 loader fixtures: ${pass} passed, ${fails.length} failed`);
if (fails.length) {
  console.log(fails.join("\n"));
  process.exit(1);
}

// ── L-S308 — pickCoverageRow: the ONE per-slug selection precedence ─────────
// (valued > user-stated > confidence > deterministic id). Query-order
// last-wins let a value-less parsed "covered" mention shadow a user's stated
// rate (the acupuncture E2E defect).
{
  const parsedNoValue = { id: "b", in_copay: null, in_coinsurance: null, confidence: 0.5, source: "sbc_parsed", field_provenance: null };
  const userStated = { id: "c", in_copay: null, in_coinsurance: 0.2, confidence: 0.9, source: "manual", field_provenance: { in_coinsurance: { source: "user_correction" } } };
  const parsedValued = { id: "a", in_copay: 50, in_coinsurance: null, confidence: 0.95, source: "plan_doc_parsed", field_provenance: null };

  check("L-S308 valued beats value-less regardless of order", pickCoverageRow([parsedNoValue, userStated]).id === "c");
  check("L-S308 …and in the other order too", pickCoverageRow([userStated, parsedNoValue]).id === "c");
  check("L-S308 user-stated beats a parsed value", pickCoverageRow([parsedValued, userStated]).id === "c");
  check("L-S308 among parsed valued rows, higher confidence wins", pickCoverageRow([{ ...parsedValued, id: "d", confidence: 0.5 }, parsedValued]).id === "a");
  const tie1 = pickCoverageRow([{ ...parsedValued, id: "z" }, { ...parsedValued, id: "a" }]).id;
  const tie2 = pickCoverageRow([{ ...parsedValued, id: "a" }, { ...parsedValued, id: "z" }]).id;
  check("L-S308 full tie is deterministic (id order), never query order", tie1 === "a" && tie2 === "a");
  check("L-S308 card provenance is not user-stated", pickCoverageRow([{ ...userStated, id: "e", field_provenance: { in_coinsurance: { source: "card_corroboration" } }, confidence: 1 }, userStated]).id === "c");
}

console.log("ALL GREEN ✓");
