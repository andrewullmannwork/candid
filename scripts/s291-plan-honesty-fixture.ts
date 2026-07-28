/* S291 fixture — plan-provenance honesty (Andrew E2E findings #1 + #3).
 * Runnable: npx tsx scripts/s291-plan-honesty-fixture.ts
 *
 * Proves:
 *   (L2) computeCostShareV2 never returns `correct`/`confident` for a bill
 *        audited against an UNVERIFIED (insurance-card / manual) plan when
 *        `unverified_plan_honesty_gate_v1` is ON — it degrades to
 *        `insufficient` ("we can't fully check this"). Flag OFF and
 *        document-verified plans are byte-identical to prior behaviour.
 *   (L2) The gate NEVER suppresses or fabricates a finding: `recovery`,
 *        `not_covered` and insurer-denial verdicts pass through untouched.
 *   (#1) The /claim next-step buckets are disjoint — a bill with a drafted
 *        letter counts ONLY toward `drafted`, never toward `needsDraft`.
 *
 * The real-world case this locks: a card scan wrote `in_copay: 0,
 * confidence: 1` rows for PCP/specialist/ER, which grounded a confident "no
 * issues" on a $428 primary-care visit the user had paid $292.41 for. The
 * fabricated $0 is now dropped at the card boundary (see
 * /api/profile/scan-card zero-copay suppression); this fixture locks the
 * second line of defence — provenance itself blocks the all-clear.
 *
 * CI-wiring is a follow-up obligation (Ship Gate G4); manually runnable today.
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "../.env.local"), override: false });
import {
  computeCostShareV2,
  type ComputeCostShareV2Args,
  type PlanCostShareParams,
} from "@/lib/claims/recovery-math";
import { pendingAssumptionFields } from "@/components/claims/CostShareBanner";
import { buildDirectEntryProvenance } from "@/lib/parser/provenance-builders";
import { SOURCE_DEFAULT_CONFIDENCE } from "@/lib/parser/field-categories";

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

// ── Plan fixtures — identical TERMS, different PROVENANCE ──────────────────
const BASE_PLAN: PlanCostShareParams = {
  inDeductibleIndividual: 3000,
  inDeductibleFamily: 6000,
  outDeductibleIndividual: null,
  outDeductibleFamily: null,
  inOopMaxIndividual: 7900,
  inOopMaxFamily: 15800,
  outOopMaxIndividual: null,
  outOopMaxFamily: null,
  inCoinsuranceDefault: null,
  outCoinsuranceDefault: null,
  deductibleCalcMethod: "embedded",
  combinedMedicalRxOop: null,
  coverageTier: "individual",
};
const CARD_PLAN: PlanCostShareParams = { ...BASE_PLAN, provenanceUnverified: true };
const DOC_PLAN: PlanCostShareParams = { ...BASE_PLAN, provenanceUnverified: false };

/** A $20-copay PCP visit the user was charged exactly $20 for → normally `correct`/`confident`. */
function cleanBill(plan: PlanCostShareParams, gateOn: boolean): ComputeCostShareV2Args {
  return {
    line: {
      billed: 20,
      allowed: 20,
      insuranceAdjusted: 0,
      providerAdjusted: 0,
      patientPaid: 20,
      patientResponsibility: 20,
    },
    service: {
      copay: 20,
      coinsurance: null,
      deductibleApplies: false,
      covered: true,
    } as unknown as ComputeCostShareV2Args["service"],
    insurer: {
      memberAppliedToDeductible: null,
      memberCoinsurance: null,
      memberCopay: 20,
      deniedAmount: null,
      insurancePaid: 0,
    } as ComputeCostShareV2Args["insurer"],
    plan,
    accumulator: { deductibleApplied: 0, deductibleMax: 3000, oopApplied: 0, oopMax: 7900 },
    overrides: {} as ComputeCostShareV2Args["overrides"],
    networkLine: "in_network",
    networkClaim: "in_network",
    minRecovery: 1,
    preventive: null,
    claimInsurerPaidZero: true,
    unverifiedPlanHonestyGate: gateOn,
  };
}

/** Same $20-copay service, but the user was charged $200 → a REAL recovery. */
function overchargedBill(plan: PlanCostShareParams, gateOn: boolean): ComputeCostShareV2Args {
  const a = cleanBill(plan, gateOn);
  return {
    ...a,
    line: { ...a.line, billed: 200, allowed: 200, patientPaid: 200, patientResponsibility: 200 },
    insurer: { ...a.insurer, memberCopay: 200 },
  };
}

// ── L2: the gate blocks an unearned all-clear ─────────────────────────────
const cardGated = computeCostShareV2(cleanBill(CARD_PLAN, true));
check(
  "card plan + gate ON → `insufficient` (never correct/confident)",
  cardGated.verdict === "insufficient",
  `got ${cardGated.verdict}`,
);
check(
  "card plan + gate ON → records the plan_provenance assumption",
  cardGated.assumptions.some((a) => a.field === "plan_provenance"),
  JSON.stringify(cardGated.assumptions.map((a) => a.field)),
);

// ── L2: OFF is byte-identical to prior behaviour (the rollback path) ───────
const cardUngated = computeCostShareV2(cleanBill(CARD_PLAN, false));
check(
  "card plan + gate OFF → clean verdict preserved (flag is a true rollback)",
  cardUngated.verdict === "correct" || cardUngated.verdict === "confident",
  `got ${cardUngated.verdict}`,
);
check(
  "card plan + gate OFF → no plan_provenance assumption leaks in",
  !cardUngated.assumptions.some((a) => a.field === "plan_provenance"),
);

// ── L2: a document-verified plan is unaffected even with the gate ON ───────
const docGated = computeCostShareV2(cleanBill(DOC_PLAN, true));
check(
  "document-verified plan + gate ON → clean verdict (gate targets provenance, not everyone)",
  docGated.verdict === "correct" || docGated.verdict === "confident",
  `got ${docGated.verdict}`,
);

// ── L2: absent provenance fails OPEN (older rows / callers that don't set it) ──
const legacyGated = computeCostShareV2(cleanBill(BASE_PLAN, true));
check(
  "provenance undefined + gate ON → clean verdict (fails open, no silent mass-downgrade)",
  legacyGated.verdict === "correct" || legacyGated.verdict === "confident",
  `got ${legacyGated.verdict}`,
);

// ── L2: the gate can never suppress a real finding ────────────────────────
const cardRecovery = computeCostShareV2(overchargedBill(CARD_PLAN, true));
check(
  "card plan + gate ON + real overcharge → still `recovery` (finding NOT suppressed)",
  cardRecovery.verdict === "recovery",
  `got ${cardRecovery.verdict}`,
);
check(
  "card plan + gate ON + real overcharge → recovery dollars unchanged by the gate",
  cardRecovery.potentialRecovery ===
    computeCostShareV2(overchargedBill(CARD_PLAN, false)).potentialRecovery,
  `${cardRecovery.potentialRecovery} vs ungated`,
);

// ── #1: next-step buckets are disjoint ────────────────────────────────────
// Mirrors use-claim-pipeline's counting loop exactly.
type BillState = "overcharge_no_draft" | "overcharge_drafted" | "needs_review" | "clean";
function countBuckets(states: BillState[]) {
  const c = { flagged: 0, needsDraft: 0, drafted: 0, review: 0 };
  for (const s of states) {
    if (s === "overcharge_no_draft" || s === "overcharge_drafted") c.flagged += 1;
    if (s === "overcharge_no_draft") c.needsDraft += 1;
    if (s === "overcharge_drafted") c.drafted += 1;
    if (s === "needs_review") c.review += 1;
  }
  return c;
}
const oneDrafted = countBuckets(["overcharge_drafted"]);
check(
  "a drafted bill counts ONCE — letters tile only (Andrew's 1-flagged + 1-ready screenshot)",
  oneDrafted.needsDraft === 0 && oneDrafted.drafted === 1,
  JSON.stringify(oneDrafted),
);
check(
  "a drafted bill still counts as an overcharge FOUND (dashboard DashDuo unaffected)",
  oneDrafted.flagged === 1,
  JSON.stringify(oneDrafted),
);
const mixed = countBuckets([
  "overcharge_drafted",
  "overcharge_no_draft",
  "needs_review",
  "clean",
]);
check(
  "mixed set: needsDraft + drafted never double-count the same bill",
  mixed.needsDraft === 1 && mixed.drafted === 1 && mixed.flagged === 2 && mixed.review === 1,
  JSON.stringify(mixed),
);

// ── Pending-assumption set (Andrew: Done must not turn the step green while a
// real input is still missing) ─────────────────────────────────────────────
type BA = Parameters<typeof pendingAssumptionFields>[0][number];
const asum = (field: string, extra: Partial<BA> = {}): BA =>
  ({ field, assumed: "", value: null, correctable: true, reason: "", lineId: "l1", serviceLabel: "Primary Care Visit", serviceSlug: "pcp_visit", ...extra }) as BA;

// The exact bill Andrew hit: plan cost KNOWN ($30 copay, so no service_cost
// chip), toggles all answered by Done — but the plan never said whether the
// deductible applies, so the engine still emits `deductible_applies`.
const afterDone = pendingAssumptionFields(
  [asum("deductible_applies")],
  { userNetworkOverride: "in_network", deductibleMet: false, oopMet: false } as Parameters<typeof pendingAssumptionFields>[1],
);
check(
  "Done + unanswered deductible_applies → still pending (the false green)",
  afterDone.has("deductible_applies") && afterDone.size === 1,
  JSON.stringify([...afterDone]),
);

const allAnswered = pendingAssumptionFields(
  [],
  { userNetworkOverride: "in_network", deductibleMet: false, oopMet: false } as Parameters<typeof pendingAssumptionFields>[1],
);
check("everything answered → empty set → green", allAnswered.size === 0, JSON.stringify([...allAnswered]));

const togglesOnly = pendingAssumptionFields(
  [asum("network"), asum("deductible_met"), asum("oop_met")],
  null,
);
check(
  "toggle rows are pending until Done saves them",
  togglesOnly.size === 3,
  JSON.stringify([...togglesOnly]),
);

const multi = pendingAssumptionFields(
  [asum("deductible_applies"), asum("aca_preventive"), asum("service_cost", { serviceSlug: "mri" })],
  { userNetworkOverride: "in_network", deductibleMet: false, oopMet: false } as Parameters<typeof pendingAssumptionFields>[1],
);
check(
  "every missing row is flagged, not just one (no hardcoded winner)",
  multi.size === 3 && multi.has("service_cost:mri"),
  JSON.stringify([...multi]),
);

// ── Provenance stamping — the root fix that made mig 217 unnecessary ───────
// A card-scanned copay and a hand-typed one used to be byte-identical rows, so
// no query could retire the fabricated ones without destroying real answers.
const cardProv = buildDirectEntryProvenance(
  "plan_covered_services",
  [["in_copay", 0]],
  "card_corroboration",
);
const userProv = buildDirectEntryProvenance(
  "plan_covered_services",
  [["in_copay", 0]],
  "user_correction",
);
check(
  "identical $0 copays are now DISTINGUISHABLE by provenance",
  cardProv.in_copay?.source === "card_corroboration" &&
    userProv.in_copay?.source === "user_correction",
  `${cardProv.in_copay?.source} vs ${userProv.in_copay?.source}`,
);
check(
  "a typed value outranks a scanned one",
  (userProv.in_copay?.confidence ?? 0) > (cardProv.in_copay?.confidence ?? 1),
  `user ${userProv.in_copay?.confidence} > card ${cardProv.in_copay?.confidence}`,
);
check(
  "confidence comes from the calibrated table, not a literal",
  cardProv.in_copay?.confidence === SOURCE_DEFAULT_CONFIDENCE.card_corroboration &&
    userProv.in_copay?.confidence === SOURCE_DEFAULT_CONFIDENCE.user_correction,
  `${cardProv.in_copay?.confidence} / ${userProv.in_copay?.confidence}`,
);
check(
  "null values are not stamped (nothing to attribute)",
  Object.keys(
    buildDirectEntryProvenance("plan_covered_services", [["in_copay", null]], "card_corroboration"),
  ).length === 0,
);
check(
  "the value travels with the entry (Pattern 1 #3 corroboration)",
  cardProv.in_copay?.value === 0,
  JSON.stringify(cardProv.in_copay?.value),
);

// ── Accumulator rows are DATA, not assumptions (S291 transparency reversal) ─
// The deductible/OOP rows are now emitted even when our tally already knows, so
// the user can see and override them instead of watching them vanish. They must
// NOT be counted as assumptions — doing so silently demotes every
// accumulator-backed bill from `confident` to `correct` with identical dollars.
function knownAccBill(acc: ComputeCostShareV2Args["accumulator"]): ComputeCostShareV2Args {
  const a = cleanBill(DOC_PLAN, false);
  return {
    ...a,
    service: { copay: 20, coinsurance: null, deductibleApplies: true, covered: true } as unknown as ComputeCostShareV2Args["service"],
    accumulator: acc,
  };
}
const accKnown = computeCostShareV2(
  knownAccBill({ deductibleApplied: 3000, deductibleMax: 3000, oopApplied: 100, oopMax: 7900 }),
);
check(
  "accumulator-known → rows ARE emitted (they used to disappear)",
  accKnown.assumptions.filter((a) => a.reason === "accumulator").length === 2,
  JSON.stringify(accKnown.assumptions.map((a) => `${a.field}/${a.reason}`)),
);
check(
  "accumulator-known → still `confident`, not demoted to `correct`",
  accKnown.verdict === "confident",
  `got ${accKnown.verdict}`,
);
const accAbsent = computeCostShareV2(knownAccBill(null));
check(
  "no accumulator → a real assumption → `correct`",
  accAbsent.verdict === "correct",
  `got ${accAbsent.verdict}`,
);
check(
  "emitting the rows changed no dollars",
  accKnown.potentialRecovery === 0 && accKnown.shouldOwe === 20,
  `shouldOwe ${accKnown.shouldOwe} recovery ${accKnown.potentialRecovery}`,
);
check(
  "an accumulator row is NOT pending (visible, already answered, still overridable)",
  !pendingAssumptionFields(
    [asum("deductible_met", { reason: "accumulator" }), asum("oop_met", { reason: "accumulator" })],
    null,
  ).size,
);

const total = 26;
console.log(`\n${total} assertions — ${total - failures} passed, ${failures} failed`);
if (failures > 0) {
  console.error("✗ s291-plan-honesty fixture RED");
  process.exit(1);
}
console.log("✓ s291-plan-honesty fixture green");
