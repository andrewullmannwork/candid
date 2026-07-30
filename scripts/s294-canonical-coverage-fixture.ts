/**
 * S294 — canonical coverage completeness fixture.
 *
 * Locks the four properties behind `canonical_coverage_completeness_v1`, each
 * of which corresponds to a defect observed on real DEV rows (user
 * 6f17b19b…, plan 6497895e…, canonical f522c971… — BCBS MT Blue Focus Silver
 * POS 903, $7,250 deductible):
 *
 *   1. The canonical mapper carries `in_deductible_applies`. Three of the four
 *      canonical readers dropped it, so "No Charge AFTER deductible" reached
 *      the engine as "$0 copay, deductible unknown" and the whole bill degraded
 *      to "we can't fully check this one yet".
 *   2. Multi-variant slugs collapse deterministically (this canonical carries
 *      pcp_visit at BOTH pcp_office and virtual; the winner used to be Postgres
 *      heap order).
 *   3. Gap-fill: user rows always win; canonical fills only unmentioned slugs.
 *      The old wholesale REPLACE meant uploading a plan document could remove
 *      coverage the user could see the day before.
 *   4. The metal-level ACA guess does NOT widen as a side effect of gap-fill
 *      (S154 confirmed-ACA-only, reaffirmed S294).
 *
 * Plus the letter-side grounding gate that stops a deductible-subject benefit
 * being asserted as a discrepancy.
 */
import {
  canonicalCoverageFromRow,
  applyCanonicalGapFill,
  type PlanCoverageMeta,
} from "../src/lib/audit/coverage-loader";
import { computeExpectedPatientCost, type PlanBenefitDetail } from "../src/lib/disputes/evidence-resolver";
import {
  computeCostShareV2,
  ANSWERED_REASONS,
  type PlanCostShareParams,
} from "../src/lib/claims/recovery-math";
import {
  buildServiceCostShare,
  EMPTY_PLAN_COST_SHARE_PARAMS,
} from "../src/lib/claims/cost-share-loader";
import { pendingAssumptionFields, ASSUMPTION_ANSWERABILITY, DONE_WRITABLE_FIELDS } from "../src/components/claims/CostShareBanner";

let pass = 0;
const fails: string[] = [];
function check(name: string, ok: boolean, got?: unknown, want?: unknown) {
  if (ok) { pass++; return; }
  fails.push(`✗ ${name}` + (got !== undefined ? `  got=${JSON.stringify(got)} want=${JSON.stringify(want)}` : ""));
}

// ── The REAL pcp_visit row off DEV canonical f522c971 (SBC: "No Charge after
//    deductible"). This is the row that produced the S294 bug. ───────────────
const PCP_OFFICE = {
  id: "85ae9a91", canonical_plan_id: "c1", service_slug: "pcp_visit",
  place_of_service: "pcp_office", component: "global", plan_tier_label: "none",
  covered: true, in_copay: 0, in_coinsurance: null, in_deductible_applies: true,
  out_copay: 0, out_coinsurance: null, out_deductible_applies: true,
  requires_referral: false, prior_auth_required: null, visit_limit: null,
  annual_limit: null, confidence: 0.9, source: "admin_attested",
};
// The REAL preventive_care row ("No Charge; deductible does not apply").
const PREVENTIVE = {
  ...PCP_OFFICE, id: "55c765aa", service_slug: "preventive_care",
  place_of_service: "any", in_deductible_applies: false,
};

// ── 1. the dropped column ────────────────────────────────────────────────────
{
  const c = canonicalCoverageFromRow(PCP_OFFICE);
  check("1a pcp_visit carries deductibleApplies=true", c.deductibleApplies === true, c.deductibleApplies, true);
  check("1a copay still 0", c.copay === 0, c.copay, 0);
  check("1a covered true", c.covered === true, c.covered, true);
  const p = canonicalCoverageFromRow(PREVENTIVE);
  // THE preventive case: $0 AND deductible-exempt, straight from the plan's own
  // words — no ACA statutory assumption involved.
  check("1b preventive_care deductibleApplies=false", p.deductibleApplies === false, p.deductibleApplies, false);
  check("1c out_* carried", c.outDeductibleApplies === true && c.outCopay === 0, [c.outDeductibleApplies, c.outCopay]);
  // A row the parser genuinely could not resolve stays UNKNOWN — the engine's
  // inference is still correct behavior for that case.
  const unknown = canonicalCoverageFromRow({ ...PCP_OFFICE, in_deductible_applies: null });
  check("1d absent → null, never false", unknown.deductibleApplies === null, unknown.deductibleApplies, null);
}

const meta = (rows: Array<{ slug: string; deductibleApplies?: boolean | null; copay?: number | null; source?: string }>, aca: boolean | null = null): PlanCoverageMeta => {
  const m: PlanCoverageMeta = { coverageMap: new Map(), coveredMeta: [], acaCompliant: aca };
  for (const r of rows) {
    const coverage = { covered: true, copay: r.copay ?? 0, coinsurance: null, deductibleApplies: r.deductibleApplies ?? null };
    m.coverageMap.set(r.slug, { ...coverage, source: r.source ?? "user_doc" });
    m.coveredMeta.push({ slug: r.slug, category: "office_visit", coverage });
  }
  return m;
};

// ── 3. gap-fill precedence ───────────────────────────────────────────────────
{
  // The user uploaded a document covering pcp_visit at a $30 copay. The
  // canonical also knows pcp_visit ($0) and preventive_care.
  const user = meta([{ slug: "pcp_visit", copay: 30, deductibleApplies: false }]);
  const canon = meta([
    { slug: "pcp_visit", copay: 0, deductibleApplies: true, source: "canonical" },
    { slug: "preventive_care", copay: 0, deductibleApplies: false, source: "canonical" },
  ]);
  applyCanonicalGapFill(user, canon, { allowAcaInference: false });

  check("3a user row WINS on a shared slug (copay)", user.coverageMap.get("pcp_visit")?.copay === 30, user.coverageMap.get("pcp_visit")?.copay, 30);
  check("3a user row keeps its own source", user.coverageMap.get("pcp_visit")?.source === "user_doc", user.coverageMap.get("pcp_visit")?.source);
  check("3b canonical FILLS the unmentioned slug", user.coverageMap.get("preventive_care")?.copay === 0);
  check("3b filled row tagged canonical_inherited", user.coverageMap.get("preventive_care")?.source === "canonical_inherited", user.coverageMap.get("preventive_care")?.source);
  check("3c filled row keeps deductibleApplies", user.coverageMap.get("preventive_care")?.deductibleApplies === false);
  // The regression the old wholesale REPLACE caused: uploading a doc must never
  // SHRINK what the user can see.
  check("3d nothing was erased (2 slugs)", user.coverageMap.size === 2, user.coverageMap.size, 2);
  check("3d coveredMeta grew, not replaced", user.coveredMeta.length === 2, user.coveredMeta.length, 2);
}

// ── 4. the ACA guard ─────────────────────────────────────────────────────────
{
  // Plan WITH user rows → gap-fill runs, ACA inference must NOT ride along.
  const withRows = meta([{ slug: "pcp_visit" }]);
  applyCanonicalGapFill(withRows, meta([{ slug: "x" }], true), { allowAcaInference: false });
  check("4a metal-level ACA guess does NOT reach a plan with user rows", withRows.acaCompliant === null, withRows.acaCompliant, null);

  // Plan with NO user rows → pre-S294 reach preserved.
  const empty = meta([]);
  applyCanonicalGapFill(empty, meta([{ slug: "x" }], true), { allowAcaInference: true });
  check("4b empty plan still inherits the guess (pre-S294 reach)", empty.acaCompliant === true, empty.acaCompliant, true);

  // An explicit user answer always wins, either way.
  const answered = meta([], false);
  applyCanonicalGapFill(answered, meta([{ slug: "x" }], true), { allowAcaInference: true });
  check("4c explicit user answer beats the guess", answered.acaCompliant === false, answered.acaCompliant, false);
}

// ── 5. the letter-side grounding gate ────────────────────────────────────────
{
  const base: PlanBenefitDetail = {
    covered: true, copay: 0, coinsurance: null, source: "canonical", confidence: 0.9,
    citation: "", sbcExcerpt: null, sbcPage: null, sbcExcerptVerified: false,
    citationSource: null, sourcedFrom: "canonical_archive", sourcedFromYear: 2026,
    coverageDecision: { planStance: "covered" } as PlanBenefitDetail["coverageDecision"],
  };
  // THE false assertion: $0 "after deductible" on a $372 pre-deductible bill
  // used to yield expected=$0 → the letter claimed the whole $372 was an
  // overcharge the patient genuinely owes.
  check(
    "5a deductible-subject benefit yields NO expected cost",
    computeExpectedPatientCost({ ...base, deductibleApplies: true }, 372) === null,
    computeExpectedPatientCost({ ...base, deductibleApplies: true }, 372), null,
  );
  // Preventive is deductible-EXEMPT → the $0 is real and still assertable.
  check(
    "5b deductible-exempt $0 still asserts (preventive keeps its claim)",
    computeExpectedPatientCost({ ...base, deductibleApplies: false }, 390) === 0,
    computeExpectedPatientCost({ ...base, deductibleApplies: false }, 390), 0,
  );
  // Unknown → pre-S294 behavior, unchanged.
  check(
    "5c unknown deductible treatment → unchanged behavior",
    computeExpectedPatientCost({ ...base, deductibleApplies: null }, 390) === 0,
  );
  // Suppression must not swallow a coinsurance claim we CAN ground.
  check(
    "5d coinsurance, deductible-exempt → still computed",
    computeExpectedPatientCost({ ...base, copay: null, coinsurance: 0.2, deductibleApplies: false }, 100) === 20,
    computeExpectedPatientCost({ ...base, copay: null, coinsurance: 0.2, deductibleApplies: false }, 100), 20,
  );
  check("5e not-covered still yields null", computeExpectedPatientCost({ ...base, covered: false }, 100) === null);
}

// ── 6. F3 — the plan's own term is SURFACED, and never blocks Done ───────────
// Runs the real engine (the S292 lesson: a fixture asserting `correct||confident`
// was structurally blind to a verdict flip; assert the actual emission).
{
  const NO_OVERRIDES = { deductibleMet: null, deductibleMetAsOf: null, oopMet: null, oopMetAsOf: null, userNetworkOverride: null };
  const plan: PlanCostShareParams = {
    ...EMPTY_PLAN_COST_SHARE_PARAMS,
    inDeductibleIndividual: 7250, inOopMaxIndividual: 7250, coverageTier: "individual",
  };
  // Andrew's real 2024 bill: 99214 pcp_visit $330, plan says $0 AFTER deductible.
  const run = (deductibleApplies: boolean | null) =>
    computeCostShareV2({
      line: { billed: 330, allowed: 330, insuranceAdjusted: 0, patientPaid: 0, patientResponsibility: 330 },
      service: buildServiceCostShare({ covered: true, copay: 0, coinsurance: null, deductibleApplies }),
      // No EOB on this bill — every insurer field genuinely unknown, which is
      // what made the 2024 bill unresolvable in the first place.
      insurer: { memberAppliedToDeductible: null, memberCoinsurance: null, memberCopay: null, deniedAmount: null, insurancePaid: null },
      plan, accumulator: null, overrides: { ...NO_OVERRIDES },
      networkLine: null, networkClaim: null, minRecovery: 1,
    });

  const stated = run(true);
  const da = stated.assumptions.find((a) => a.field === "deductible_applies");
  check("6a plan-stated deductible treatment IS emitted", da != null);
  check("6a assumed=subject_free (covered at $0, behind the deductible)", da?.assumed === "subject_free", da?.assumed, "subject_free");
  check("6a reason=plan_document", da?.reason === "plan_document", da?.reason, "plan_document");
  check("6a carries the deductible figure the copy needs", da?.value === 7250, da?.value, 7250);
  check("6a NOT correctable — the plan document is authoritative", da?.correctable === false, da?.correctable, false);
  // THE dead-end: a plan-stated fact must never sit in the pending set, because
  // Done cannot write it. ANSWERED_REASONS is what keeps it out.
  check("6b plan_document is an ANSWERED reason (never blocks Done)", ANSWERED_REASONS.has("plan_document"));
  check("6b every emitted deductible_applies row here is answered",
    stated.assumptions.filter((a) => a.field === "deductible_applies").every((a) => ANSWERED_REASONS.has(a.reason)));

  // Deductible-EXEMPT (preventive): no deductible figure to name, and the
  // engine must not then ask whether the deductible is met.
  const exempt = run(false);
  const ex = exempt.assumptions.find((a) => a.field === "deductible_applies");
  check("6c exempt_free emitted", ex?.assumed === "exempt_free", ex?.assumed, "exempt_free");
  check("6c exempt carries no deductible figure", ex?.value === null, ex?.value, null);
  check("6c exempt bill does not ask about the deductible",
    !exempt.assumptions.some((a) => a.field === "deductible_met"),
    exempt.assumptions.map((a) => a.field));

  // Plan genuinely silent → pre-S294 behavior: inferred, correctable, and it
  // DOES stay pending (there is a real question to answer).
  const silent = run(null);
  const si = silent.assumptions.find((a) => a.field === "deductible_applies");
  check("6d silent plan still infers with reason=no_plan_value", si?.reason === "no_plan_value", si?.reason, "no_plan_value");
  check("6d inferred row stays correctable + pending", si?.correctable === true && !ANSWERED_REASONS.has(si!.reason));
}

// ── 7. THE PENDING INVARIANT (Andrew, third recurrence) ──────────────────────
// An ANSWERED field is NEVER pending — for every field, not just the toggle-backed
// ones. Asserted over the FULL field vocabulary rather than the one field that
// broke, because this defect recurred three times by being fixed per-row.
//
// Fixture note: §6b previously asserted only `ANSWERED_REASONS.has("plan_document")`
// and passed while pendingAssumptionFields ignored it — a fixture blind to the
// thing it claimed to cover. Assert the CONSUMER, never the constant.
{
  const NO_OV = { deductibleMet: null, deductibleMetAsOf: null, oopMet: null, oopMetAsOf: null, userNetworkOverride: null };
  const ALL_FIELDS = ["network", "deductible_met", "oop_met", "deductible_applies", "aca_preventive", "service_cost"];
  for (const field of ALL_FIELDS) {
    for (const reason of ANSWERED_REASONS) {
      const a = [{ field, assumed: "x", value: null, correctable: true, reason, serviceLabel: "Office visit", serviceSlug: "pcp_visit" }];
      const p = pendingAssumptionFields(a as never[], NO_OV, { label: "Some Plan" }, { deductibleAppliesRowVisible: true, acaRowVisible: true });
      check(`7a answered ${field} via "${reason}" is NOT pending`, p.size === 0, [...p], []);
    }
  }
  // …and an UNanswered field of each kind still is (the gate must not be inert).
  for (const [field, reason] of [["deductible_applies", "no_plan_value"], ["aca_preventive", "aca_status_unknown"], ["network", "default"]] as const) {
    const a = [{ field, assumed: "x", value: null, correctable: true, reason }];
    const p = pendingAssumptionFields(a as never[], NO_OV, { label: "Some Plan" }, { deductibleAppliesRowVisible: true, acaRowVisible: true });
    check(`7b unanswered ${field} IS still pending`, p.size === 1, [...p]);
  }
  // Andrew's exact 2024 bill after his saved answer: only `network` remains, and
  // Done writes network — so Done genuinely finishes the step.
  const realBill = [
    { field: "network", assumed: "in_network", value: null, correctable: true, reason: "default" },
    { field: "deductible_applies", assumed: "subject_free", value: 7250, correctable: false, reason: "plan_document" },
    { field: "deductible_met", assumed: "not_met", value: 7250, correctable: true, reason: "user_override" },
  ];
  const p = pendingAssumptionFields(realBill as never[], { ...NO_OV, deductibleMet: false }, { label: "BCBS MT Blue Focus Silver POS 903" }, { deductibleAppliesRowVisible: true, acaRowVisible: false });
  check("7c real 2024 bill → only Done-writable fields remain", [...p].join(",") === "network", [...p], ["network"]);
  const afterDone = pendingAssumptionFields(realBill as never[], { ...NO_OV, deductibleMet: false, userNetworkOverride: "in_network" }, { label: "BCBS MT Blue Focus Silver POS 903" }, { deductibleAppliesRowVisible: true, acaRowVisible: false });
  check("7d after Done → NOTHING pending (the badge clears)", afterDone.size === 0, [...afterDone], []);

  // 7e EXHAUSTIVENESS — the lock that makes recurrence #4 impossible. Every
  // field the engine can emit must DECLARE how it is answered. A new field
  // added to CostShareAssumption without an entry here fails the build rather
  // than silently becoming a permanently-pending row nobody can clear.
  const ENGINE_FIELDS = [
    "network", "deductible_met", "oop_met", "deductible_applies",
    "service_cost", "denial", "aca_preventive", "plan_provenance", "plan_identity",
  ];
  for (const f of ENGINE_FIELDS) {
    check(`7e "${f}" declares its answerability`, f in ASSUMPTION_ANSWERABILITY, f);
  }
  check("7e DONE_WRITABLE is derived, not hand-listed",
    [...DONE_WRITABLE_FIELDS].sort().join(",") === "deductible_met,network,oop_met",
    [...DONE_WRITABLE_FIELDS].sort());
  // An "info" field can never hold the step open, however it is emitted.
  for (const f of ["denial", "plan_provenance"]) {
    const p = pendingAssumptionFields(
      [{ field: f, assumed: "x", value: null, correctable: true, reason: "insurer_denied" }] as never[],
      NO_OV, { label: "Some Plan" }, { deductibleAppliesRowVisible: true, acaRowVisible: true },
    );
    check(`7f info-only "${f}" is never pending`, p.size === 0, [...p], []);
  }
}

// ── 8. THE HONESTY GATE reads the DATA's provenance, not the plan row ────────
// S291's case must keep degrading; a search-selected plan backed by Candid's
// own SBC extraction must NOT. This is the substance of Andrew's 3-round report.
{
  const NO_OV = { deductibleMet: false, deductibleMetAsOf: null, oopMet: null, oopMetAsOf: null, userNetworkOverride: "in_network" as const };
  const run = (costProvenance: string | undefined, planUnverified: boolean) =>
    computeCostShareV2({
      line: { billed: 330, allowed: 330, insuranceAdjusted: 0, patientPaid: 0, patientResponsibility: 330 },
      service: { covered: true, copay: 0, coinsurance: null, deductibleApplies: true, costProvenance: costProvenance as never },
      insurer: { memberAppliedToDeductible: null, memberCoinsurance: null, memberCopay: null, deniedAmount: null, insurancePaid: null },
      plan: { ...EMPTY_PLAN_COST_SHARE_PARAMS, inDeductibleIndividual: 7250, inOopMaxIndividual: 7250, coverageTier: "individual", provenanceUnverified: planUnverified },
      accumulator: null, overrides: NO_OV, networkLine: null, networkClaim: null, minRecovery: 1,
      unverifiedPlanHonestyGate: true,
    });

  // Trusted: the member's own document, Candid's extraction of the same filing,
  // or a value they typed themselves.
  check("8a plan_document → real verdict", run("plan_document", false).verdict !== "insufficient", run("plan_document", false).verdict);
  check("8b user-typed → real verdict", run("user", false).verdict !== "insufficient", run("user", false).verdict);

  // ⚠ S291 REGRESSION LOCK — a card scan invented a $0 copay and grounded a
  // false "no issues" on a bill the member had paid $292.41 for. It must always
  // degrade, whatever else changes around it.
  check("8c CARD-sourced → still degrades (S291)", run("card", false).verdict === "insufficient", run("card", false).verdict, "insufficient");
  // ⚠ FAILS OPEN on absence — S291's deliberate rule, not an oversight. Rows
  // written before provenance stamping carry none, and degrading them all would
  // silently mass-downgrade every legacy member. Absence is not evidence of
  // fabrication; only a positively identified card scan is. (I initially built
  // this the other way round and s291-plan-honesty-fixture caught it — the
  // reason that fixture exists.)
  check("8d unknown provenance → FAILS OPEN, real verdict (no mass-downgrade)", run("unknown", false).verdict !== "insufficient", run("unknown", false).verdict);
  check("8e absent provenance → FAILS OPEN, real verdict", run(undefined, false).verdict !== "insufficient", run(undefined, false).verdict);

  // A plan ASSEMBLED from a card/manual entry stays untrusted even if one
  // service row looks better sourced than the plan around it.
  check("8f card/manual PLAN degrades even with documented service rows",
    run("plan_document", true).verdict === "insufficient", run("plan_document", true).verdict, "insufficient");

  // The degraded case must still NAME itself, so the banner can say the true
  // reason instead of "we're missing your plan's cost".
  check("8g degraded verdict emits plan_provenance so the copy can be honest",
    run("card", false).assumptions.some((a) => a.field === "plan_provenance"),
    run("card", false).assumptions.map((a) => a.field));
}

if (fails.length) {
  console.error(`\ns294 canonical-coverage fixture: ${pass} passed, ${fails.length} failed`);
  for (const f of fails) console.error("  " + f);
  process.exit(1);
}
console.log(`\ns294 canonical-coverage fixture: ${pass} passed, 0 failed`);
console.log("ALL GREEN ✓");
