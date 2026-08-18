/**
 * S318 — BORROW-GATE FIXTURE (pure, offline, CI-wired).
 *
 * Locks the resolveLinePrep three-state borrow gate: the user's per-line
 * verification marks (claim_line_items.metadata.coverage_user_confirmed /
 * coverage_user_rejected) govern whether a secondary-coverage borrow's MONEY
 * reaches the engine — the letter's shouldOwe/cap reads this same derivation,
 * and a letter's cap is the one surface the user cannot see (S318 launch gate).
 *
 *   undecided estimate  -> covered + identity survive, money nulled (in + OON),
 *                          service_cost assumption pending, shouldOwe UNGROUNDED,
 *                          precise dollar NOT assertable
 *   user-confirmed      -> the borrowed rate flows (the attestation IS the answer)
 *   user-rejected       -> the borrow drops entirely (even a `confident` one)
 *   ACA fallback present-> the mandate outranks an unconfirmed borrow: State 3,
 *                          NO manufactured acaOverride from borrowed terms
 *   confident borrow    -> unchanged by the gate (no marks needed)
 *   exact plan row      -> never consults the marks
 *   malformed metadata  -> reads as undecided (fail-closed toward not asserting)
 *
 * Offline: constructs prep/ctx in memory; imports are pure functions. No DB,
 * no network, no env.
 */
import {
  resolveLineCostShare,
  type ClaimCostSharePrep,
  type CostShareClaimCtx,
} from "@/lib/claims/resolve-cost-share";
import { DEFAULT_SECONDARY_GATE, type CoveredSlugMeta } from "@/lib/audit/coverage-loader";
import { DEFAULT_COST_SHARE_GATE } from "@/lib/claims/cost-share-loader";
import { isPreciseDollarAssertable } from "@/lib/disputes/dispute-grounds";
import type { EffectiveClaimTotals } from "@/lib/claims/effective-totals";
import type { PlanCoverageInput } from "@/lib/claims/recovery-math";

let pass = 0;
const fails: string[] = [];
function check(name: string, cond: boolean) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fails.push(name);
    console.log(`  ✗ ${name}`);
  }
}

// ── the S317 real shape: a basic-imaging line, a plan holding two divergent
//    imaging siblings ($400 advanced / $50 diagnostic) → an `estimate` borrow ──
const advancedImaging: PlanCoverageInput = {
  covered: true,
  copay: 400,
  coinsurance: null,
  deductibleApplies: true,
  outCopay: null,
  outCoinsurance: 0.3,
  outDeductibleApplies: true,
};
const diagnosticTest: PlanCoverageInput = {
  covered: true,
  copay: 50,
  coinsurance: null,
  deductibleApplies: false,
};
const estimatePool: CoveredSlugMeta[] = [
  { slug: "advanced_imaging", category: "imaging", coverage: advancedImaging },
  { slug: "diagnostic_test", category: "imaging", coverage: diagnosticTest },
];
// single-candidate pool → homogeneous → `confident`
const confidentPool: CoveredSlugMeta[] = [
  { slug: "specialist_visit", category: "office_visit", coverage: { covered: true, copay: 60, coinsurance: null, deductibleApplies: false } },
];

const effectiveTotals = {
  patientPaid: 500,
  insurancePaid: 0,
  insuranceAdjusted: 0,
  patientResponsibility: 500,
  provenance: {
    patientPaidSource: "header",
    insurancePaidSource: "header",
    insuranceAdjustedSource: "header",
    patientResponsibilitySource: "header",
  },
} as unknown as EffectiveClaimTotals;

function makePrep(overrides: Partial<ClaimCostSharePrep> = {}): ClaimCostSharePrep {
  return {
    coverageMap: new Map(),
    coveredMeta: estimatePool,
    billSlugMeta: new Map([
      ["imaging_basic", { category: "imaging", isPreventiveEligible: false }],
      ["pcp_visit", { category: "office_visit", isPreventiveEligible: false }],
    ]),
    planAcaCompliant: null,
    secondaryGate: DEFAULT_SECONDARY_GATE,
    secondaryEnabled: true,
    acaFallback: { bySlug: new Map(), byLineNumber: new Map(), planMeta: null },
    claimTotalBilled: 500,
    claimStillOutstanding: null,
    effectiveTotals,
    ...overrides,
  };
}

const ctx: CostShareClaimCtx = {
  planParams: null,
  overrides: null,
  accRows: [],
  memberSums: { deductible: 0, oop: 0 },
  preventiveLines: new Set<number>(),
  acaStatus: "unknown",
  claimInsurerPaidZero: false,
  gate: DEFAULT_COST_SHARE_GATE,
  networkClaim: null,
  coverageTier: null,
  planYear: null,
};

function makeRaw(metadata: unknown, slug = "imaging_basic"): Record<string, unknown> {
  return {
    id: "line-1",
    line_number: 1,
    service_slug: slug,
    billed_amount: 500,
    insurance_adjusted_amount: null,
    insurance_paid: null,
    patient_paid_amount: 500,
    patient_owes: null,
    amount_still_outstanding: null,
    member_applied_to_deductible: null,
    member_coinsurance: null,
    member_copay: null,
    denied_amount: null,
    network_status: null,
    metadata,
  };
}

const moneyFields = [
  "copay",
  "coinsurance",
  "deductibleApplies",
  "outCopay",
  "outCoinsurance",
  "outDeductibleApplies",
  "oonPaidAtInNetwork",
] as const;
function moneyAllNull(cov: PlanCoverageInput | null): boolean {
  if (!cov) return false;
  return moneyFields.every((f) => (cov as unknown as Record<string, unknown>)[f] == null);
}
function pendingServiceCost(result: { assumptions: Array<{ field: string; reason: string }> }): boolean {
  // reasons in ANSWERED_REASONS render as facts; anything else is pending
  return result.assumptions.some((a) => a.field === "service_cost" && a.reason === "no_plan_value");
}

console.log("\n── case 1: undecided estimate borrow → identity yes, money no ──");
{
  const r = resolveLineCostShare(makeRaw({}), makePrep(), ctx, "detail");
  check("coverage present (covered survives)", r.coverage?.covered === true);
  check("all money fields null (in + OON)", moneyAllNull(r.coverage));
  check("matched sibling identity survives", r.secondaryMatchedSlug === "advanced_imaging");
  check("confidence carried as estimate", r.secondaryConfidence === "estimate");
  check("coverageSource stays secondary_match", r.coverageSource === "secondary_match");
  check("service_cost assumption pending", pendingServiceCost(r.result));
  check("shouldOwe NOT grounded", r.result.shouldOweGrounded === false);
  check("engine exports rateUnknown=true (S318 display signal)", r.result.rateUnknown === true);
  check("precise dollar NOT assertable", !isPreciseDollarAssertable(r.result));
  check(
    "verdict never affirmative off a guess",
    r.result.verdict !== "correct" && r.result.verdict !== "confident" && r.result.verdict !== "recovery",
  );
}

console.log("\n── case 2: user-CONFIRMED estimate borrow → the borrowed rate flows ──");
{
  const r = resolveLineCostShare(makeRaw({ coverage_user_confirmed: true }), makePrep(), ctx, "detail");
  check("borrowed copay intact ($400)", r.coverage?.copay === 400);
  check("borrowed OON coinsurance intact (0.3)", r.coverage?.outCoinsurance === 0.3);
  check("borrowed deductibleApplies intact", r.coverage?.deductibleApplies === true);
  check("identity intact", r.secondaryMatchedSlug === "advanced_imaging");
  check("no pending service_cost assumption", !pendingServiceCost(r.result));
  check("engine exports rateUnknown=false (confirmed rate is usable)", r.result.rateUnknown === false);
}

console.log("\n── case 3: user-REJECTED borrow → dropped entirely, even a confident one ──");
{
  const est = resolveLineCostShare(makeRaw({ coverage_user_rejected: true }), makePrep(), ctx, "detail");
  check("estimate borrow: coverage null", est.coverage === null);
  check("estimate borrow: no matched slug", est.secondaryMatchedSlug === null);
  check("estimate borrow: no confidence", est.secondaryConfidence === null);
  check("estimate borrow: service_cost pending (ask returns)", pendingServiceCost(est.result));
  check("estimate borrow: rateUnknown exported true", est.result.rateUnknown === true);
  check("estimate borrow: not assertable", !isPreciseDollarAssertable(est.result));
  const conf = resolveLineCostShare(
    makeRaw({ coverage_user_rejected: true }, "pcp_visit"),
    makePrep({ coveredMeta: confidentPool }),
    ctx,
    "detail",
  );
  check("CONFIDENT borrow also drops on reject", conf.coverage === null && conf.secondaryMatchedSlug === null);
}

console.log("\n── case 4: confident borrow, no marks → unchanged by the gate ──");
{
  const r = resolveLineCostShare(makeRaw({}, "pcp_visit"), makePrep({ coveredMeta: confidentPool }), ctx, "detail");
  check("confidence is confident (single homogeneous candidate)", r.secondaryConfidence === "confident");
  check("borrowed copay flows ($60)", r.coverage?.copay === 60);
  check("no pending service_cost assumption", !pendingServiceCost(r.result));
}

console.log("\n── case 5: undecided estimate + ACA fallback → mandate outranks the guess ──");
{
  const aca: PlanCoverageInput = { covered: true, copay: 0, coinsurance: 0, deductibleApplies: false };
  const prep = makePrep({ acaFallback: { bySlug: new Map(), byLineNumber: new Map([[1, aca]]), planMeta: null } });
  const r = resolveLineCostShare(makeRaw({}), prep, ctx, "detail");
  check("ACA coverage wins ($0 copay)", r.coverage?.copay === 0 && r.coverage?.covered === true);
  check("NO manufactured acaOverride from borrowed terms", r.acaOverride === null);
  check("no secondary identity on the ACA path", r.secondaryMatchedSlug === null && r.secondaryConfidence === null);
  check("coverageSource attributes ACA", r.coverageSource === "aca_zero_cost_share");
}

console.log("\n── case 6: exact plan row → marks never consulted ──");
{
  const exact: PlanCoverageInput = { covered: true, copay: 25, coinsurance: null, deductibleApplies: false };
  const prep = makePrep({ coverageMap: new Map([["imaging_basic", exact]]) });
  const plain = resolveLineCostShare(makeRaw({}), prep, ctx, "detail");
  const rejected = resolveLineCostShare(makeRaw({ coverage_user_rejected: true }), prep, ctx, "detail");
  check("exact copay flows ($25)", plain.coverage?.copay === 25);
  check("exact row identical under a rejected mark", JSON.stringify(plain.coverage) === JSON.stringify(rejected.coverage));
  check("exact match flagged exact", plain.exactCoverageMatch === true);
}

console.log("\n── case 8: user-CHOSEN sibling (match+rate editor) → their pick prices the line ──");
{
  const r = resolveLineCostShare(
    makeRaw({ coverage_user_confirmed: true, coverage_user_matched_slug: "diagnostic_test" }),
    makePrep(),
    ctx,
    "detail",
  );
  check("chosen sibling's rate flows ($50, not the resolver's $400 pick)", r.coverage?.copay === 50);
  check("matched slug is the USER's choice", r.secondaryMatchedSlug === "diagnostic_test");
  check("source stays secondary_match", r.coverageSource === "secondary_match");
  const unknown = resolveLineCostShare(
    makeRaw({ coverage_user_confirmed: true, coverage_user_matched_slug: "not_a_real_slug" }),
    makePrep(),
    ctx,
    "detail",
  );
  check("unknown stored slug falls back to the resolver pick", unknown.coverage?.copay === 400 && unknown.secondaryMatchedSlug === "advanced_imaging");
  const rej = resolveLineCostShare(
    makeRaw({ coverage_user_rejected: true, coverage_user_matched_slug: "diagnostic_test" }),
    makePrep(),
    ctx,
    "detail",
  );
  check("reject outranks a stale stored pick", rej.coverage === null && rej.secondaryMatchedSlug === null);
}

console.log("\n── case 7: malformed metadata → undecided (fail-closed) ──");
{
  const garbage = resolveLineCostShare(makeRaw("not-an-object"), makePrep(), ctx, "detail");
  const nullMeta = resolveLineCostShare(makeRaw(null), makePrep(), ctx, "detail");
  check("string metadata: money nulled", moneyAllNull(garbage.coverage));
  check("null metadata: money nulled", moneyAllNull(nullMeta.coverage));
  check("null metadata: not assertable", !isPreciseDollarAssertable(nullMeta.result));
}

console.log(`\n${pass}/${pass + fails.length} passed`);
if (fails.length > 0) {
  console.error(`FAILED: ${fails.join(" | ")}`);
  process.exit(1);
}
