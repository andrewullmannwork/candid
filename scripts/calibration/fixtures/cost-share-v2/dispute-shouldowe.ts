/**
 * §18.10 incr-2 GATE — loadDisputeGroundBasis shouldOwe (the dispute path).
 *
 * Locks the PURE core of loadDisputeGroundBasis (src/lib/disputes/dispute-ground-basis.ts
 * `resolveDisputeShouldOwe`): that loaded claim bundles resolve, through the shared
 * recipe (resolveLineCostShare, strategy "detail"), to the correct deductible-aware
 * `shouldOwe` keyed by lineItemId, MERGED across the dispute's claims. Mirrors
 * resolve-parity.ts / prep-parity.ts (synthetic, pure, no DB).
 *
 * Asserts the two crux behaviors increment 2 introduces:
 *   1. the id bridge + multi-claim merge (recipe keys per lineNumber; this keys per
 *      claim_line_items.id, what resolveLetterRecovery consumes), and
 *   2. conservative-when-blind carries through — a no-coverage line resolves to
 *      shouldOwe = full allowed (a NUMBER, so the cap binds to ~$0), never absent
 *      (absent = the deductible-blind raw-sum revert this arc kills).
 *
 * Run: npx tsx scripts/calibration/fixtures/cost-share-v2/dispute-shouldowe.ts
 */
import {
  resolveDisputeShouldOwe,
  type ClaimBasisBundle,
} from "../../../../src/lib/disputes/dispute-ground-basis";
import {
  type ClaimCostSharePrep,
  type CostShareClaimCtx,
} from "../../../../src/lib/claims/resolve-cost-share";
import { EMPTY_PLAN_COST_SHARE_PARAMS } from "../../../../src/lib/claims/cost-share-loader";
import { resolveEffectiveClaimTotals } from "../../../../src/lib/claims/effective-totals";
import {
  type PlanCoverageInput,
  type PlanCostShareParams,
} from "../../../../src/lib/claims/recovery-math";
import {
  DEFAULT_SECONDARY_GATE,
  type CoveredSlugMeta,
  type BillSlugMeta,
} from "../../../../src/lib/audit/coverage-loader";

let pass = 0;
const fails: string[] = [];
function check(name: string, cond: boolean, got?: unknown) {
  if (cond) pass++;
  else fails.push(`✗ ${name}  got=${JSON.stringify(got)}`);
}
const near = (a: number, b: number, eps = 0.01) => Math.abs(a - b) <= eps;

const planParams: PlanCostShareParams = {
  ...EMPTY_PLAN_COST_SHARE_PARAMS,
  inDeductibleIndividual: 7050,
  inOopMaxIndividual: 7050,
  coverageTier: "individual",
};
const baseCtx: CostShareClaimCtx = {
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

// Cite-grade effective totals (header == per-line sums → raw per-line values used).
function citeEffective(lines: Array<Record<string, unknown>>) {
  const sum = (k: string) =>
    lines.reduce((s, l) => s + (l[k] != null ? Number(l[k]) : 0), 0);
  return resolveEffectiveClaimTotals({
    claim: {
      total_billed: sum("billed_amount"),
      total_patient_paid: sum("patient_paid_amount"),
      total_insurance_paid: 0,
      total_insurance_adjusted: sum("insurance_adjusted_amount"),
      total_patient_responsibility: sum("patient_owes"),
    },
    lineItems: lines,
  });
}

function prepFor(
  lines: Array<Record<string, unknown>>,
  coverageMap: Map<string, PlanCoverageInput & { source?: string | null }>,
  coveredMeta: CoveredSlugMeta[],
  billSlugMeta: Map<string, BillSlugMeta>,
  planAcaCompliant: boolean | null,
): ClaimCostSharePrep {
  return {
    coverageMap,
    coveredMeta,
    billSlugMeta,
    planAcaCompliant,
    secondaryGate: DEFAULT_SECONDARY_GATE,
    secondaryEnabled: true,
    acaFallback: { bySlug: new Map(), byLineNumber: new Map(), planMeta: { isAcaCompliant: planAcaCompliant === true, basis: null, excerpt: null } },
    claimTotalBilled: lines.reduce((s, l) => s + Number(l.billed_amount || 0), 0),
    claimStillOutstanding: 0,
    effectiveTotals: citeEffective(lines),
  };
}

// ── Claim A — copay line + blind (no-coverage) line. ──
const claimALines = [
  { id: "A1", line_number: 1, service_slug: "office_visit", billed_amount: 292.41, patient_paid_amount: 292.41, insurance_adjusted_amount: 0, insurance_paid: 0, patient_owes: 0, network_status: null },
  { id: "A2", line_number: 2, service_slug: "mri", billed_amount: 221, patient_paid_amount: 163.27, insurance_adjusted_amount: 57.73, insurance_paid: 0, patient_owes: 0, network_status: null },
];
const claimAprep = prepFor(
  claimALines,
  new Map([["office_visit", { covered: true, copay: 20, coinsurance: null, source: "plan" }]]),
  [],
  new Map(),
  true,
);

// ── Claim B — ACA-preventive secondary-match line. ──
const claimBLines = [
  { id: "B1", line_number: 1, service_slug: "annual_physical", billed_amount: 200, patient_paid_amount: 200, insurance_adjusted_amount: 0, insurance_paid: 0, patient_owes: 0, network_status: null },
];
const claimBprep = prepFor(
  claimBLines,
  new Map(),
  [],
  new Map([["annual_physical", { category: "preventive", isPreventiveEligible: true }]]),
  true,
);

const bundles: ClaimBasisBundle[] = [
  { rawLines: claimALines, prep: claimAprep, ctx: baseCtx },
  { rawLines: claimBLines, prep: claimBprep, ctx: baseCtx },
];

const resolved = resolveDisputeShouldOwe(bundles);

// ── id bridge + multi-claim merge ──
check("D1 merged map has all 3 line ids", resolved.size === 3, resolved.size);
check("D1 claim A ids present", resolved.has("A1") && resolved.has("A2"), Array.from(resolved.keys()));
check("D1 claim B id present (merge across claims)", resolved.has("B1"), Array.from(resolved.keys()));

// ── deductible-aware shouldOwe per line ──
check("D2 A1 copay shouldOwe $20", near(resolved.get("A1")!.shouldOwe, 20), resolved.get("A1")?.shouldOwe);
check("D3 A2 blind shouldOwe = full allowed $163.27 (conservative, NUMBER not absent)", near(resolved.get("A2")!.shouldOwe, 163.27), resolved.get("A2")?.shouldOwe);
check("D3 A2 blind recovery $0", near(resolved.get("A2")!.potentialRecovery, 0), resolved.get("A2")?.potentialRecovery);
check("D4 B1 aca-preventive shouldOwe $0", near(resolved.get("B1")!.shouldOwe, 0), resolved.get("B1")?.shouldOwe);

if (fails.length) {
  console.error(`\ncost-share-v2 dispute-shouldowe: ${pass} passed, ${fails.length} failed`);
  for (const f of fails) console.error("  " + f);
  process.exit(1);
}
console.log(`\ncost-share-v2 dispute-shouldowe: ${pass} passed, 0 failed`);
console.log("ALL GREEN ✓");
