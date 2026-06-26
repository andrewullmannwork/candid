/**
 * §18.10 incr-2 PREP PARITY GATE — resolveLineCostShare == the inline route prep.
 *
 * Proves the shared per-line PREP recipe (src/lib/claims/resolve-cost-share.ts
 * `resolveLineCostShare`) reproduces, byte-identically, the inline prep the list
 * + detail card routes run today (coverage resolution → secondary → ACA fallback;
 * the writeoff proration + allowed; patientPaid + patientResponsibility) before
 * those routes are swapped onto it (Step D). The `inlineRoutePrep` side below is a
 * VERBATIM copy of the route code (claims/route.ts:442-509 list,
 * claims/[claimId]/route.ts:421-559 detail) — the source of truth being extracted;
 * deep-equal of the full ResolvedLineCostShare = parity. The ONLY route-divergent
 * values are patientPaid + patientResponsibility (the `strategy` arg).
 *
 * After the swap this fixture is the drift guard: an edit to either the recipe OR
 * (the frozen copy of) the route prep breaks it.
 *
 * Run: npx tsx scripts/calibration/fixtures/cost-share-v2/prep-parity.ts
 */
import {
  resolveLineCostShare,
  resolveLinePrep,
  resolveCostShareForLine,
  type ClaimCostSharePrep,
  type CostShareClaimCtx,
  type CostSharePrepStrategy,
  type ResolvedLineCostShare,
} from "../../../../src/lib/claims/resolve-cost-share";
import { EMPTY_PLAN_COST_SHARE_PARAMS } from "../../../../src/lib/claims/cost-share-loader";
import {
  resolveEffectiveClaimTotals,
  resolvePerLinePatientPaid,
  resolvePerLineInsuranceAdjusted,
} from "../../../../src/lib/claims/effective-totals";
import {
  resolveStillOutstanding,
  type PlanCoverageInput,
  type PlanCostShareParams,
} from "../../../../src/lib/claims/recovery-math";
import {
  resolveLineCoverage,
  resolveSecondaryCoverage,
  DEFAULT_SECONDARY_GATE,
} from "../../../../src/lib/audit/coverage-loader";

let pass = 0;
const fails: string[] = [];
function eq(name: string, a: unknown, b: unknown) {
  const A = JSON.stringify(a);
  const B = JSON.stringify(b);
  if (A === B) pass++;
  else fails.push(`✗ ${name}\n    recipe=${A}\n    inline=${B}`);
}
function check(name: string, cond: boolean, got?: unknown) {
  if (cond) pass++;
  else fails.push(`✗ ${name}  got=${JSON.stringify(got)}`);
}
const near = (a: number, b: number, eps = 0.01) => Math.abs(a - b) <= eps;

// ── VERBATIM copy of the routes' inline per-line prep (the source being extracted). ──
function inlineRoutePrep(
  raw: Record<string, unknown>,
  prep: ClaimCostSharePrep,
  ctx: CostShareClaimCtx,
  strategy: CostSharePrepStrategy,
): ResolvedLineCostShare {
  const slug = (raw.service_slug as string | null) ?? null;
  const billed = Number(raw.billed_amount || 0);
  const lineNumber = Number(raw.line_number ?? 0);

  let rawPlanCoverage: PlanCoverageInput | null = slug
    ? prep.coverageMap.get(slug) ?? null
    : null;
  let secondaryMatchedSlug: string | null = null;
  let secondaryCoverageSource: "secondary_match" | "aca_preventive" | null = null;
  let secondaryConfidence: "confident" | "estimate" | null = null;
  if (prep.secondaryEnabled && !rawPlanCoverage && slug) {
    const meta = prep.billSlugMeta.get(slug);
    if (meta) {
      const sec = resolveSecondaryCoverage(
        slug,
        meta,
        prep.coveredMeta,
        prep.planAcaCompliant,
        prep.secondaryGate,
      );
      if (sec) {
        rawPlanCoverage = sec.coverage;
        secondaryMatchedSlug = sec.matchedSlug;
        secondaryCoverageSource = sec.source;
        secondaryConfidence = sec.confidence;
      }
    }
  }
  const acaCoverage: PlanCoverageInput | null =
    prep.acaFallback.byLineNumber.get(lineNumber) || null;
  const { coverage, acaOverride } = resolveLineCoverage(
    rawPlanCoverage,
    acaCoverage,
    prep.acaFallback.planMeta,
  );
  const coverageFromAca = coverage === acaCoverage && coverage != null;
  const coverageSource = coverageFromAca
    ? "aca_zero_cost_share"
    : secondaryCoverageSource
      ? secondaryCoverageSource
      : coverage && slug
        ? prep.coverageMap.get(slug)?.source ?? null
        : null;

  const { value: insuranceAdjusted, source: insuranceAdjustedSource } =
    resolvePerLineInsuranceAdjusted({
      lineBilled: billed,
      lineInsuranceAdjusted:
        raw.insurance_adjusted_amount != null
          ? Number(raw.insurance_adjusted_amount)
          : null,
      claimTotalBilled: prep.claimTotalBilled,
      effectiveClaimInsuranceAdjusted: prep.effectiveTotals,
    });
  const allowed = Math.max(0, billed - insuranceAdjusted);

  let patientPaid: number;
  let patientPaidSource: "per_line" | "header_prorated";
  if (strategy === "detail") {
    const r = resolvePerLinePatientPaid({
      lineBilled: billed,
      linePatientPaid:
        raw.patient_paid_amount != null ? Number(raw.patient_paid_amount) : null,
      claimTotalBilled: prep.claimTotalBilled,
      effectiveClaimPatientPaid: prep.effectiveTotals,
    });
    patientPaid = r.value;
    patientPaidSource = r.source;
  } else {
    patientPaid = Number(raw.patient_paid_amount ?? 0);
    patientPaidSource = "per_line";
  }

  let patientResponsibility: number;
  if (strategy === "detail") {
    patientResponsibility =
      raw.patient_owes != null
        ? Number(raw.patient_owes)
        : resolveStillOutstanding({
            lineBilled: billed,
            lineStillOutstanding:
              raw.amount_still_outstanding != null
                ? Number(raw.amount_still_outstanding)
                : null,
            linePatientOwes: null,
            claimTotalBilled: prep.claimTotalBilled,
            claimStillOutstanding: prep.claimStillOutstanding,
          });
  } else {
    const owed = Number(raw.patient_owes || 0);
    patientResponsibility =
      owed ||
      resolveStillOutstanding({
        lineBilled: billed,
        lineStillOutstanding:
          raw.amount_still_outstanding != null
            ? Number(raw.amount_still_outstanding)
            : null,
        linePatientOwes: owed,
        claimTotalBilled: prep.claimTotalBilled,
        claimStillOutstanding: prep.claimStillOutstanding,
      });
  }
  const patientResponsibilitySource: "per_line" | "header_prorated" =
    raw.patient_owes != null ? "per_line" : "header_prorated";

  const result = resolveCostShareForLine(
    {
      lineNumber,
      billed,
      allowed,
      insuranceAdjusted,
      patientPaid,
      patientResponsibility,
      coverage,
      networkStatus: (raw.network_status as string | null) ?? null,
      raw,
    },
    ctx,
  );

  return {
    result,
    coverage,
    coverageSource,
    secondaryMatchedSlug,
    secondaryConfidence,
    acaOverride,
    allowed,
    patientPaid,
    patientPaidSource,
    insuranceAdjusted,
    insuranceAdjustedSource,
    patientResponsibility,
    patientResponsibilitySource,
  };
}

// ── Synthetic claim context (HDHP individual; ACA-confirmed; insurer paid $0). ──
const planParams: PlanCostShareParams = {
  ...EMPTY_PLAN_COST_SHARE_PARAMS,
  inDeductibleIndividual: 7050,
  inOopMaxIndividual: 7050,
  coverageTier: "individual",
};
const ctx: CostShareClaimCtx = {
  planParams,
  overrides: null,
  accRows: [],
  memberSums: { deductible: 0, oop: 0 },
  preventiveLines: new Set<number>(),
  acaStatus: "confirmed",
  claimInsurerPaidZero: true,
  gate: { minRecovery: 1 },
  networkClaim: null,
  coverageTier: "individual",
  planYear: 2025,
};

const coverageMap = new Map<string, PlanCoverageInput & { source?: string | null }>([
  // copay service, deductible-exempt → copay branch.
  ["office_visit", { covered: true, copay: 20, coinsurance: null, deductibleApplies: false, source: "plan" }],
  ["specialist_visit", { covered: true, copay: 50, coinsurance: null, deductibleApplies: false, source: "plan" }],
]);

// Two-line claim header so effectiveTotals can header-source a sparse line.
const claimRows = [
  { billed_amount: 292.41, patient_paid_amount: 292.41, insurance_paid: 0, insurance_adjusted_amount: 0, patient_owes: 0 },
  { billed_amount: 100, patient_paid_amount: null, insurance_paid: null, insurance_adjusted_amount: null, patient_owes: null },
];
const effectiveTotals = resolveEffectiveClaimTotals({
  claim: { total_billed: 392.41, total_patient_paid: 372.41, total_insurance_paid: 0, total_patient_responsibility: 0 },
  lineItems: claimRows,
});

const prep: ClaimCostSharePrep = {
  coverageMap,
  coveredMeta: [],
  billSlugMeta: new Map([["annual_physical", { category: "preventive", isPreventiveEligible: true }]]),
  planAcaCompliant: true,
  secondaryGate: DEFAULT_SECONDARY_GATE,
  secondaryEnabled: true,
  acaFallback: { bySlug: new Map(), byLineNumber: new Map(), planMeta: { isAcaCompliant: true, basis: null, excerpt: null } },
  claimTotalBilled: 392.41,
  claimStillOutstanding: 0,
  effectiveTotals,
};

// ── Representative rows exercising each prep path. ──
const rows: Array<{ name: string; raw: Record<string, unknown> }> = [
  { name: "P1 plan-covered copay", raw: { service_slug: "office_visit", billed_amount: 292.41, patient_paid_amount: 292.41, insurance_adjusted_amount: 0, insurance_paid: 0, patient_owes: 0, network_status: null, line_number: 1 } },
  { name: "P2 HDHP blind (no coverage)", raw: { service_slug: "mri", billed_amount: 221, patient_paid_amount: 163.27, insurance_adjusted_amount: 57.73, insurance_paid: 0, patient_owes: 0, network_status: null, line_number: 2 } },
  { name: "P3 secondary aca-preventive", raw: { service_slug: "annual_physical", billed_amount: 200, patient_paid_amount: 200, insurance_adjusted_amount: 0, insurance_paid: 0, patient_owes: 0, network_status: null, line_number: 3 } },
  { name: "P4 sparse header-only", raw: { service_slug: "office_visit", billed_amount: 100, patient_paid_amount: null, insurance_adjusted_amount: null, insurance_paid: null, patient_owes: null, amount_still_outstanding: null, network_status: null, line_number: 4 } },
  { name: "P5 OON specialist", raw: { service_slug: "specialist_visit", billed_amount: 300, patient_paid_amount: 300, insurance_adjusted_amount: 0, insurance_paid: 0, patient_owes: 0, network_status: "out_of_network", line_number: 5 } },
];

// ── Parity: recipe == inline route copy, BOTH strategies, every row. ──
for (const { name, raw } of rows) {
  for (const strategy of ["detail", "list"] as CostSharePrepStrategy[]) {
    const inline = inlineRoutePrep(raw, prep, ctx, strategy);
    // full bundle (prep + v2 engine) — the dispute path + costShareV2-ON card branch.
    eq(`${name} [${strategy}]`, resolveLineCostShare(raw, prep, ctx, strategy), inline);
    // prep-only (no engine) — what the OFF card branch + display consume. Must equal
    // the same inline minus `result`.
    const { result: _drop, ...inlinePrepOnly } = inline;
    eq(`${name} [${strategy}] prep-only`, resolveLinePrep(raw, prep, strategy), inlinePrepOnly);
  }
}

// ── Correctness spot-checks (deductible-aware shouldOwe, not just self-consistency). ──
// Build a CITE-GRADE prep per row (single-line claim whose header == the per-line
// values) so patientPaid is the RAW value, not the header-pro-rated one the shared
// `prep` above produces — isolating the engine math from the proration layer.
function citePrep(raw: Record<string, unknown>): ClaimCostSharePrep {
  const billed = Number(raw.billed_amount || 0);
  const pp = raw.patient_paid_amount != null ? Number(raw.patient_paid_amount) : null;
  const ia = raw.insurance_adjusted_amount != null ? Number(raw.insurance_adjusted_amount) : null;
  const po = raw.patient_owes != null ? Number(raw.patient_owes) : null;
  const et = resolveEffectiveClaimTotals({
    claim: {
      total_billed: billed,
      total_patient_paid: pp,
      total_insurance_paid: 0,
      total_insurance_adjusted: ia,
      total_patient_responsibility: po,
    },
    lineItems: [
      { billed_amount: billed, patient_paid_amount: pp, insurance_paid: 0, insurance_adjusted_amount: ia, patient_owes: po },
    ],
  });
  return { ...prep, claimTotalBilled: billed, claimStillOutstanding: po, effectiveTotals: et };
}
{
  const r = resolveLineCostShare(rows[0].raw, citePrep(rows[0].raw), ctx, "detail");
  check("C1 copay shouldOwe $20", near(r.result.shouldOwe, 20), r.result.shouldOwe);
  check("C1 copay refund ~$272.41", near(r.result.refundComponent, 272.41), r.result.refundComponent);
}
{
  const r = resolveLineCostShare(rows[1].raw, citePrep(rows[1].raw), ctx, "detail");
  // conservative-when-blind: shouldOwe = full allowed (221 - 57.73), recovery $0.
  check("C2 blind shouldOwe = full allowed $163.27", near(r.result.shouldOwe, 163.27), r.result.shouldOwe);
  check("C2 blind recovery $0", near(r.result.potentialRecovery, 0), r.result.potentialRecovery);
}
{
  const r = resolveLineCostShare(rows[2].raw, citePrep(rows[2].raw), ctx, "detail");
  check("C3 aca-preventive shouldOwe $0", near(r.result.shouldOwe, 0), r.result.shouldOwe);
  check("C3 aca-preventive coverageSource", r.coverageSource === "aca_preventive", r.coverageSource);
}
{
  // The list/detail divergence MUST be observable on a sparse line:
  // detail pro-rates patientPaid from the header; list uses raw (0).
  const d = resolveLineCostShare(rows[3].raw, prep, ctx, "detail");
  const l = resolveLineCostShare(rows[3].raw, prep, ctx, "list");
  check("C4 sparse: detail patientPaid pro-rated > 0", d.patientPaid > 0, d.patientPaid);
  check("C4 sparse: list patientPaid raw = 0", l.patientPaid === 0, l.patientPaid);
  check("C4 sparse: strategies diverge", d.patientPaid !== l.patientPaid, { detail: d.patientPaid, list: l.patientPaid });
}

if (fails.length) {
  console.error(`\ncost-share-v2 prep-parity: ${pass} passed, ${fails.length} failed`);
  for (const f of fails) console.error("  " + f);
  process.exit(1);
}
console.log(`\ncost-share-v2 prep-parity: ${pass} passed, 0 failed`);
console.log("ALL GREEN ✓");
