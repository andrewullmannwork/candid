/**
 * §18 — DisputeGround per-line derivation + exposure-cap unit fixtures (PII-free synthetic).
 * Locks: per-line ground derivation (primary + additive non-contradictory secondaries),
 * the service_not_rendered whole-charge pool, clean → [], the Gap-1 description/billedAmount on
 * GroundFinding, and the §18.5/Call-A exposure cap (inert without shouldOwe; binds with it).
 * (R3 step 1 removed the dead `buildDisputeGrounds` aggregator + its G7–G9 tests; the grounds
 * taxonomy SoT is now `DISPUTE_GROUND_CATALOG`, pinned by catalog-projection-parity.)
 * Run: npx tsx scripts/calibration/fixtures/dispute-grounds/builder.ts
 */
import {
  groundsForLine,
  computeLineRecovery,
  type DisputeGroundType,
} from "../../../../src/lib/disputes/dispute-grounds";
import type { LineItemEvidence } from "../../../../src/lib/disputes/evidence-resolver";

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

// ── §18.5 / Call A — the exposure cap ────────────────────────────────────────
// C1 — INERT without shouldOwe: the raw sum passes through (Stages 1–3 behavior).
{
  const line = makeLine({ patientPaid: 260, patientOwes: 0, auditFindings: [finding({ type: "balance_billing", estimatedOvercharge: 200 })], planBenefit: PLAN_BENEFIT, discrepancyAmount: 230 });
  const { capped } = computeLineRecovery(line, "claim-1", null); // no shouldOwe → cap inert
  check("C1 cap inert → raw sum 430", near(capped, 430), capped);
}

// C2 — ADDITIVE (distinct wrongs): balance 150 + cost-share 80 = 230; exposure 260, shouldOwe 30
//      → cap 230; sum 230 ≤ cap → full 230, cap does NOT bind.
{
  const line = makeLine({ lineItemId: "li-1", patientPaid: 0, patientOwes: 260, auditFindings: [finding({ type: "balance_billing", estimatedOvercharge: 150 })], planBenefit: PLAN_BENEFIT, discrepancyAmount: 80 });
  const { capped, capBound } = computeLineRecovery(line, "claim-1", 30);
  check("C2 additive → 230 recovered", near(capped, 230), capped);
  check("C2 cap does not bind (distinct wrongs)", !capBound, capBound);
}

// C3 — OVERLAP (same dollars, two angles): balance 200 + cost-share 230 = 430; exposure 260,
//      shouldOwe 30 → cap 230. Pure sum (430) would over-claim; capped to 230, cap BINDS.
{
  const line = makeLine({ lineItemId: "li-1", patientPaid: 260, patientOwes: 0, auditFindings: [finding({ type: "balance_billing", estimatedOvercharge: 200 })], planBenefit: PLAN_BENEFIT, discrepancyAmount: 230 });
  const { capped, capBound } = computeLineRecovery(line, "claim-1", 30);
  check("C3 overlap capped at exposure 230", near(capped, 230), capped);
  check("C3 cap BINDS", capBound, capBound);
}

// C4 — service_not_rendered resets shouldOwe→0 → cap = whole exposure (no spurious capping).
{
  const line = makeLine({ lineItemId: "li-1", serviceNotRenderedAttested: true, billedAmount: 420, patientPaid: 420, patientOwes: 0 });
  const { capped, capBound } = computeLineRecovery(line, "claim-1", 999); // not-rendered resets shouldOwe→0
  check("C4 not-rendered → whole charge 420 (shouldOwe ignored)", near(capped, 420), capped);
  check("C4 cap does not bind", !capBound, capBound);
}

console.log(`\ndispute-grounds builder fixtures: ${pass} passed, ${fails.length} failed`);
if (fails.length) {
  console.log(fails.join("\n"));
  process.exit(1);
}
console.log("ALL GREEN ✓");
