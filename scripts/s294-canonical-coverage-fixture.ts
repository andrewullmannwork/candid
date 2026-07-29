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

if (fails.length) {
  console.error(`\ns294 canonical-coverage fixture: ${pass} passed, ${fails.length} failed`);
  for (const f of fails) console.error("  " + f);
  process.exit(1);
}
console.log(`\ns294 canonical-coverage fixture: ${pass} passed, 0 failed`);
console.log("ALL GREEN ✓");
