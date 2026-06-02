/**
 * Compare v2 (S156) — PR1 regression fixture (manually runnable).
 *
 *   npx tsx scripts/test-compare-cost-model.ts
 *
 * Exercises the pure cost / verdict / yearly / premium helpers against hand-built
 * payload fragments. No DB, no network. Exits non-zero on any failure (CI-wirable
 * per Ship Gate G4). Spec: plans/compare_v2_redesign.md §5.
 */
import type { CompareBenefit, ComparePlanPayload } from "@/lib/plan/compare";
import { payFor, rankBadges, cellState, type CostRule } from "@/components/compare/cost-model";
import {
  estimateYearlyV2, avgCoinsurance, estimateYearlyFromUnits,
  householdPeople, householdCareFactor, defaultUnitCounts, billedFromUnits,
  type BasketItem,
} from "@/components/compare/yearly-model";
import { premiumMonthlyFor, normalizePremiumToMonthly } from "@/components/compare/premium-model";

let pass = 0;
const fails: string[] = [];
function check(name: string, cond: boolean, detail?: string) {
  if (cond) pass += 1;
  else fails.push(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
}
function eq(name: string, got: unknown, want: unknown) {
  check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
}

// ── payload-fragment builders ───────────────────────────────────────
function bnf(
  slug: string,
  o: {
    inCopay?: number | null; inCoins?: number | null; inDed?: boolean;
    outCopay?: number | null; outCoins?: number | null; outDed?: boolean;
    covered?: boolean | null;
  },
): CompareBenefit {
  return {
    serviceSlug: slug, category: "other", title: slug,
    costInNetworkDescription: "", costOutOfNetworkDescription: "",
    costSharing: {
      inNetwork: { copay: o.inCopay ?? null, coinsurance: o.inCoins ?? null, deductibleApplies: o.inDed ?? false },
      outOfNetwork: { copay: o.outCopay ?? null, coinsurance: o.outCoins ?? null, deductibleApplies: o.outDed ?? false },
      annualLimit: null, priorAuthRequired: null,
    },
    covered: o.covered ?? true,
  };
}
function plan(inDeductible: number, inOopMax: number | null, planType: string, benefits: CompareBenefit[]): ComparePlanPayload {
  return {
    ref: { kind: "canonical", id: "x" }, canonicalPlanId: "x", planName: "P", insurerName: "I",
    planSummary: { premiumMonthly: null, inDeductible, outDeductible: null, inOopMax, outOopMax: null, planType, metalLevel: null, state: null, year: null },
    benefits, coveredServiceCount: benefits.length, sourceLabel: "canonical", isOwnedByUser: false, corroborationCount: 0,
  };
}
const R = (o: Partial<CostRule>): CostRule => ({ copay: null, coinsurance: null, deductibleApplies: false, covered: true, ...o });

// ── payFor ──────────────────────────────────────────────────────────
eq("payFor flat copay", payFor(R({ copay: 40 }), { deductible: 5000, oop: 8000 }, 1000, false).pay, 40);
eq("payFor copay>bill", payFor(R({ copay: 40 }), { deductible: 5000, oop: 8000 }, 20, false).pay, 20);
eq("payFor coinsurance", payFor(R({ coinsurance: 0.2 }), { deductible: 5000, oop: 8000 }, 1000, false).pay, 200);
eq("payFor afterDed B<=D", payFor(R({ coinsurance: 0.2, deductibleApplies: true }), { deductible: 5000, oop: 8000 }, 1000, false).pay, 1000);
eq("payFor afterDed B>D", payFor(R({ coinsurance: 0.2, deductibleApplies: true }), { deductible: 500, oop: 8000 }, 1000, false).pay, 600);
eq("payFor dedMet zeroes D", payFor(R({ coinsurance: 0.2, deductibleApplies: true }), { deductible: 500, oop: 8000 }, 1000, true).pay, 200);
eq("payFor OOP cap", payFor(R({ coinsurance: 0.2, deductibleApplies: true }), { deductible: 5000, oop: 8000 }, 100000, false).pay, 8000);
eq("payFor not-covered uncapped", payFor(R({ covered: false }), { deductible: 0, oop: 100 }, 500, false).pay, 500);
eq("payFor unknown→null", payFor(R({}), { deductible: 0, oop: 8000 }, 1000, false).pay, null);

// ── rankBadges ──────────────────────────────────────────────────────
eq("rank 2-plan best only", rankBadges([10, 20]), ["best", null]);
eq("rank 3 distinct", rankBadges([10, 20, 30]), ["best", null, "worst"]);
eq("rank 2 tie best", rankBadges([10, 10, 20]), [null, null, "worst"]);
eq("rank 2 tie worst", rankBadges([10, 20, 20]), ["best", null, null]);
eq("rank all equal", rankBadges([10, 10, 10]), [null, null, null]);
eq("rank excludes non-finite", rankBadges([Infinity, 20, 30]), [null, "best", "worst"]);

// ── cellState (precision rule) ──────────────────────────────────────
eq("cell ok", cellState(bnf("x", { inCopay: 20 }), "inNetwork", "PPO"), "ok");
eq("cell ok zero copay", cellState(bnf("x", { inCopay: 0 }), "inNetwork", "PPO"), "ok");
eq("cell nc", cellState(bnf("x", { covered: false }), "inNetwork", "PPO"), "nc");
eq("cell na HMO-OON", cellState(bnf("x", {}), "outOfNetwork", "HMO"), "na");
eq("cell unk PPO-OON-null", cellState(bnf("x", {}), "outOfNetwork", "PPO"), "unk");
eq("cell unk IN-null", cellState(bnf("x", {}), "inNetwork", "PPO"), "unk");

// ── estimateYearlyV2 ────────────────────────────────────────────────
const refs = { pcp_visit: 150, specialty_rx_tier4: 3000, annual_physical: 250, advanced_imaging: 1200 };
const hmo = plan(0, 7900, "HMO", [bnf("pcp_visit", { inCopay: 20, inDed: false })]);
const ppo = plan(1500, 8000, "PPO", [bnf("pcp_visit", { inCoins: 0.2, inDed: true })]);
const b3pcp: BasketItem[] = [{ slug: "pcp_visit", qty: 3 }];
eq("yearly HMO copay = 60", estimateYearlyV2(hmo, b3pcp, refs, null).care, 60);
eq("yearly PPO deductible = 450", estimateYearlyV2(ppo, b3pcp, refs, null).care, 450);
check("yearly copay < coinsurance (the divergence)", estimateYearlyV2(hmo, b3pcp, refs, null).care < estimateYearlyV2(ppo, b3pcp, refs, null).care);
const rxPlan = plan(0, 2000, "PPO", [bnf("specialty_rx_tier4", { inCoins: 0.3, inDed: false })]);
eq("yearly OOP cap = 2000", estimateYearlyV2(rxPlan, [{ slug: "specialty_rx_tier4", qty: 5 }], refs, null).care, 2000);
eq("yearly preventive $0", estimateYearlyV2(hmo, [{ slug: "annual_physical", qty: 1 }], refs, null).care, 0);
const partial = estimateYearlyV2(hmo, [{ slug: "pcp_visit", qty: 1 }, { slug: "advanced_imaging", qty: 1 }], refs, null);
eq("yearly dataCoverage 0.5", partial.dataCoverage, 0.5);
eq("yearly fallback care = 260", partial.care, 260);
const withPrem = estimateYearlyV2(hmo, b3pcp, refs, 100);
eq("yearly premiumAnnual", withPrem.premiumAnnual, 1200);
eq("yearly total = care + premium", withPrem.total, 1260);
eq("avgCoinsurance fallback 0.2", avgCoinsurance(hmo), 0.2);

// ── premium-model ───────────────────────────────────────────────────
eq("prem userOverride value", premiumMonthlyFor({ userOverride: 500 }).value, 500);
eq("prem userOverride source", premiumMonthlyFor({ userOverride: 500 }).source, "user_input");
eq("prem employee share", premiumMonthlyFor({ ownPlan: { premiumEmployee: 200 } }).value, 200);
eq("prem employee net subsidy", premiumMonthlyFor({ ownPlan: { premiumEmployee: 300, premiumSubsidy: 100 } }).value, 200);
eq("prem total caveat", premiumMonthlyFor({ ownPlan: { premiumTotal: 7200, frequency: "annual" } }).caveat, "incl. employer");
eq("prem total→monthly", premiumMonthlyFor({ ownPlan: { premiumTotal: 7200, frequency: "annual" } }).value, 600);
eq("prem community≥5", premiumMonthlyFor({ community: { avgMonthly: 450, sampleSize: 5 } }).source, "community");
eq("prem community<5 → band", premiumMonthlyFor({ community: { avgMonthly: 450, sampleSize: 4 }, metalLevel: "silver" }).source, "estimate");
eq("prem band silver = 480", premiumMonthlyFor({ metalLevel: "Silver" }).value, 480);
eq("prem band not grounded", premiumMonthlyFor({ metalLevel: "silver" }).grounded, false);
eq("prem none", premiumMonthlyFor({}).source, "none");
eq("normalize annual", normalizePremiumToMonthly(1200, "annual"), 100);
eq("normalize per_paycheck", normalizePremiumToMonthly(200, "per_paycheck"), 200);

// ── estimateYearlyFromUnits + household (design v2 adjusted care inputs) ──
eq("householdPeople just me", householdPeople({ spouse: false, kids: 0 }), 1);
eq("householdPeople spouse+2kids", householdPeople({ spouse: true, kids: 2 }), 4);
check("careFactor spouse+1kid = 2.3", Math.abs(householdCareFactor({ spouse: true, kids: 1 }) - 2.3) < 1e-9);
eq("defaultUnitCounts visits avg", defaultUnitCounts("average", { spouse: false, kids: 0 }).visits, 6);
eq("defaultUnitCounts visits avg +spouse", defaultUnitCounts("average", { spouse: true, kids: 0 }).visits, 11); // round(6×1.8)
eq("billedFromUnits visits+rx", billedFromUnits({ visits: 3, rx: 2 }), 3 * 180 + 2 * 45 * 12);

const onlyVisits = { visits: 3, therapy: 0, rx: 0, imaging: 0, events: 0 };
const hmoU = plan(0, 7900, "HMO", [bnf("pcp_visit", { inCopay: 20, inDed: false })]);
const eU = estimateYearlyFromUnits(hmoU, { usage: "average", household: { spouse: false, kids: 0 }, unitOverrides: onlyVisits });
eq("units HMO visits copay care", eU.care, 60); // 3 × min($20,$180)
eq("units HMO dataCoverage = 1", eU.dataCoverage, 1); // only visits used; pcp_visit has data

const rxP = plan(0, 8000, "HMO", [bnf("generic_rx_tier1", { inCopay: 10, inDed: false })]);
eq("units rx monthly ×12", estimateYearlyFromUnits(rxP, { usage: "healthy", household: { spouse: false, kids: 0 }, unitOverrides: { visits: 0, therapy: 0, rx: 2, imaging: 0, events: 0 } }).care, 240);

const bigPlan = plan(1500, 8000, "PPO", [bnf("inpatient_facility", { inCoins: 0.2, inDed: true })]);
const onlyEvent = { visits: 0, therapy: 0, rx: 0, imaging: 0, events: 1 };
const indEv = estimateYearlyFromUnits(bigPlan, { usage: "healthy", household: { spouse: false, kids: 0 }, unitOverrides: onlyEvent });
eq("units event individual deductible", indEv.care, 3600); // 1500 + (12000−1500)×0.2
const famEv = estimateYearlyFromUnits(bigPlan, { usage: "healthy", household: { spouse: true, kids: 0 }, unitOverrides: onlyEvent });
eq("units event family deductible ×2", famEv.care, 4800); // 3000 + (12000−3000)×0.2
check("family care > individual", famEv.care > indEv.care);
eq("units real family override", estimateYearlyFromUnits(bigPlan, { usage: "healthy", household: { spouse: true, kids: 0 }, unitOverrides: onlyEvent, familyDeductible: 1000, familyOop: 8000 }).care, 3200); // 1000 + (12000−1000)×0.2

// ── report ──────────────────────────────────────────────────────────
console.log(`\nCompare v2 cost-model fixture: ${pass} passed, ${fails.length} failed`);
if (fails.length) {
  console.log(fails.join("\n"));
  process.exit(1);
}
console.log("ALL PASS ✓");
