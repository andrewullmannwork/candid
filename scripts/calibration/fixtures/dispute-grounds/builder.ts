/**
 * §18 Stage 1 — DisputeGround builder unit fixtures (PII-free synthetic).
 * Locks: per-line ground derivation (primary + additive non-contradictory secondaries),
 * the service_not_rendered whole-charge pool, clean → [], dispute-level grouping +
 * strength ordering, the grounds-by-line index, the Gap-1 description/billedAmount on
 * GroundFinding, and the §18.5/Call-A exposure cap (inert without shouldOwe; binds with it).
 * Run: npx tsx scripts/calibration/fixtures/dispute-grounds/builder.ts
 */
import {
  buildDisputeGrounds,
  groundsForLine,
  computeCappedRecovery,
  type DisputeGroundType,
} from "../../../../src/lib/disputes/dispute-grounds";
import type { DisputeEvidence, LineItemEvidence, ClaimEvidence } from "../../../../src/lib/disputes/evidence-resolver";

let pass = 0;
const fails: string[] = [];
function check(name: string, cond: boolean, got?: unknown) {
  if (cond) pass++;
  else fails.push(`✗ ${name}${got !== undefined ? `  got=${JSON.stringify(got)}` : ""}`);
}
const near = (a: number, b: number, eps = 0.01) => Math.abs(a - b) <= eps;
const types = (gs: { type: DisputeGroundType }[]) => gs.map((g) => g.type);

type Finding = NonNullable<LineItemEvidence["auditFindings"]>[number];
const finding = (over: Partial<Finding> = {}): Finding => ({
  type: "overcharge",
  severity: "high",
  title: "Audit finding",
  description: "Plain-English explanation.",
  estimatedOvercharge: 100,
  benchmarkAmount: 70,
  benchmarkSource: "CMS PPL",
  ...over,
});

function makeLine(over: Partial<LineItemEvidence> = {}): LineItemEvidence {
  return {
    lineItemId: "li-1",
    billingCode: { value: "99213", type: "CPT" },
    serviceSlug: "office_visit",
    serviceName: "Office visit",
    billedAmount: 300,
    insurancePaid: null,
    patientOwes: null,
    patientPaid: null,
    planBenefit: null,
    expectedPatientCost: null,
    actualPatientCost: null,
    discrepancyAmount: null,
    discrepancyReason: null,
    communityOutcome: null,
    siblingCodes: null,
    pricingBenchmark: null,
    auditFindings: null,
    auditRan: false,
    peerCodes: null,
    disputeType: "other",
    citeGradeTier: "header",
    dollarAtStake: 0,
    serviceNotRenderedAttested: false,
    secondaryCoverageVerify: null,
    ...over,
  };
}
// A truthy plan benefit; the builder only reads truthiness + line.discrepancyAmount.
const PLAN_BENEFIT = {} as unknown as LineItemEvidence["planBenefit"];

function makeEvidence(lines: LineItemEvidence[], claimId = "claim-1"): DisputeEvidence {
  const claim = {
    claimId,
    dateOfService: "2024-03-15",
    providerName: "Sample Medical Center",
    totalBilled: 500,
    planYear: 2024,
    lineItemEvidence: lines,
    effectiveTotals: {} as unknown as ClaimEvidence["effectiveTotals"],
    dataTrust: { headerReconciliationFailed: false, signViolation: false },
  } satisfies ClaimEvidence;
  return {
    claims: [claim],
    totals: { claimCount: 1, lineItemCount: lines.length, totalBilled: 500, totalDiscrepancy: 0 },
    planEvidence: null,
    networkEvidence: null,
    communityEvidence: null,
    legalBasis: [],
    gaps: [],
    dataTrust: { headerReconciliationFailed: false, signViolation: false },
  };
}

// G1 — a clean line (no findings, no plan benefit, not attested) → no grounds.
{
  const g = groundsForLine(makeLine(), "claim-1");
  check("G1 clean line → []", g.length === 0, types(g));
}

// G2 — a single balance_billing finding → one balance_billing ground at the finding dollar.
{
  const g = groundsForLine(makeLine({ auditFindings: [finding({ type: "balance_billing", estimatedOvercharge: 150 })] }), "claim-1");
  check("G2 balance_billing ground", types(g).join() === "balance_billing", types(g));
  check("G2 dollar = finding overcharge", near(g[0].dollarAtStake, 150), g[0]?.dollarAtStake);
}

// G3 — MULTI-GROUND: balance_billing finding + a cost-share discrepancy → TWO grounds
//      (additive, non-contradictory), strength-ordered balance_billing before cost_share.
{
  const line = makeLine({
    auditFindings: [finding({ type: "balance_billing", estimatedOvercharge: 150 })],
    planBenefit: PLAN_BENEFIT,
    discrepancyAmount: 80,
  });
  const g = groundsForLine(line, "claim-1");
  check("G3 two grounds (balance + cost_share)", types(g).join() === "balance_billing,cost_share_misapplication", types(g));
  check("G3 balance dollar 150", near(g[0].dollarAtStake, 150), g[0]?.dollarAtStake);
  check("G3 cost_share dollar 80 (discrepancy)", near(g[1].dollarAtStake, 80), g[1]?.dollarAtStake);
}

// G4 — coverage_contradiction is MUTUALLY EXCLUSIVE with cost_share (only one fires).
{
  const underpay = groundsForLine(makeLine({ auditFindings: [finding({ type: "insurance_underpayment", estimatedOvercharge: 120 })], planBenefit: PLAN_BENEFIT }), "claim-1");
  check("G4 underpayment → coverage_contradiction only", types(underpay).join() === "coverage_contradiction", types(underpay));
  check("G4 not also cost_share", !types(underpay).includes("cost_share_misapplication"));
}

// G5 — attestation → service_not_rendered PRIMARY, dollar = the whole billed charge.
{
  const g = groundsForLine(makeLine({ serviceNotRenderedAttested: true, billedAmount: 420, auditFindings: [finding({ type: "balance_billing", estimatedOvercharge: 150 })] }), "claim-1");
  check("G5 service_not_rendered is first", g[0].type === "service_not_rendered", types(g));
  check("G5 whole-charge dollar 420", near(g[0].dollarAtStake, 420), g[0]?.dollarAtStake);
}

// G6 — GroundFinding carries the Gap-1 description (metadata) + billedAmount (the line).
{
  const g = groundsForLine(makeLine({ billedAmount: 300, auditFindings: [finding({ type: "balance_billing", description: "Charged above the in-network allowed amount." })] }), "claim-1");
  const f = g[0].findings[0];
  check("G6 finding description surfaced", f.description === "Charged above the in-network allowed amount.", f.description);
  check("G6 finding billedAmount from line", near(f.billedAmount, 300), f.billedAmount);
}

// G7 — buildDisputeGrounds groups per (claim,type) + strength-orders the whole set.
{
  const lineA = makeLine({ lineItemId: "li-A", auditFindings: [finding({ type: "overcharge", estimatedOvercharge: 90 })] }); // → benchmark
  const lineB = makeLine({ lineItemId: "li-B", auditFindings: [finding({ type: "balance_billing", estimatedOvercharge: 150 })] });
  const { grounds, byLine } = buildDisputeGrounds(makeEvidence([lineA, lineB]));
  check("G7 two grounds, balance before benchmark", types(grounds).join() === "balance_billing,benchmark", types(grounds));
  check("G7 byLine indexes li-A → benchmark", byLine.get("li-A")?.[0].type === "benchmark", byLine.get("li-A")?.map((x) => x.type));
  check("G7 byLine indexes li-B → balance_billing", byLine.get("li-B")?.[0].type === "balance_billing");
}

// G8 — same type across TWO lines on one claim → ONE merged ground (lineItemIds + dollar sum).
{
  const l1 = makeLine({ lineItemId: "li-1", auditFindings: [finding({ type: "duplicate", estimatedOvercharge: 60 })] });
  const l2 = makeLine({ lineItemId: "li-2", auditFindings: [finding({ type: "duplicate", estimatedOvercharge: 40 })] });
  const { grounds } = buildDisputeGrounds(makeEvidence([l1, l2]));
  check("G8 one merged duplicate ground", grounds.length === 1 && grounds[0].type === "duplicate", types(grounds));
  check("G8 merged lineItemIds", grounds[0].lineItemIds.join() === "li-1,li-2", grounds[0]?.lineItemIds);
  check("G8 merged dollar 100", near(grounds[0].dollarAtStake, 100), grounds[0]?.dollarAtStake);
}

// G9 — null evidence → empty.
{
  const r = buildDisputeGrounds(null);
  check("G9 null evidence → []", r.grounds.length === 0 && r.byLine.size === 0);
}

// ── §18.5 / Call A — the exposure cap ────────────────────────────────────────
// C1 — INERT without shouldOwe: the raw sum passes through (Stages 1–3 behavior).
{
  const line = makeLine({ patientPaid: 260, patientOwes: 0, auditFindings: [finding({ type: "balance_billing", estimatedOvercharge: 200 })], planBenefit: PLAN_BENEFIT, discrepancyAmount: 230 });
  const { total } = computeCappedRecovery(makeEvidence([line])); // no shouldOwe map
  check("C1 cap inert → raw sum 430", near(total, 430), total);
}

// C2 — ADDITIVE (distinct wrongs): balance 150 + cost-share 80 = 230; exposure 260, shouldOwe 30
//      → cap 230; sum 230 ≤ cap → full 230, cap does NOT bind.
{
  const line = makeLine({ lineItemId: "li-1", patientPaid: 0, patientOwes: 260, auditFindings: [finding({ type: "balance_billing", estimatedOvercharge: 150 })], planBenefit: PLAN_BENEFIT, discrepancyAmount: 80 });
  const { total, capBoundLineIds } = computeCappedRecovery(makeEvidence([line]), new Map([["li-1", 30]]));
  check("C2 additive → 230 recovered", near(total, 230), total);
  check("C2 cap does not bind (distinct wrongs)", capBoundLineIds.length === 0, capBoundLineIds);
}

// C3 — OVERLAP (same dollars, two angles): balance 200 + cost-share 230 = 430; exposure 260,
//      shouldOwe 30 → cap 230. Pure sum (430) would over-claim; capped to 230, cap BINDS.
{
  const line = makeLine({ lineItemId: "li-1", patientPaid: 260, patientOwes: 0, auditFindings: [finding({ type: "balance_billing", estimatedOvercharge: 200 })], planBenefit: PLAN_BENEFIT, discrepancyAmount: 230 });
  const { total, capBoundLineIds } = computeCappedRecovery(makeEvidence([line]), new Map([["li-1", 30]]));
  check("C3 overlap capped at exposure 230", near(total, 230), total);
  check("C3 cap BINDS", capBoundLineIds.join() === "li-1", capBoundLineIds);
}

// C4 — service_not_rendered resets shouldOwe→0 → cap = whole exposure (no spurious capping).
{
  const line = makeLine({ lineItemId: "li-1", serviceNotRenderedAttested: true, billedAmount: 420, patientPaid: 420, patientOwes: 0 });
  const { total, capBoundLineIds } = computeCappedRecovery(makeEvidence([line]), new Map([["li-1", 999]]));
  check("C4 not-rendered → whole charge 420 (shouldOwe ignored)", near(total, 420), total);
  check("C4 cap does not bind", capBoundLineIds.length === 0, capBoundLineIds);
}

console.log(`\ndispute-grounds builder fixtures: ${pass} passed, ${fails.length} failed`);
if (fails.length) {
  console.log(fails.join("\n"));
  process.exit(1);
}
console.log("ALL GREEN ✓");
