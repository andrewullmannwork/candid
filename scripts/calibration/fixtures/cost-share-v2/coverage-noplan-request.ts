/**
 * D3 (S242) GATE — dispute_noplan_coverage_request_v1.
 *
 * Proves the no-plan coverage-ask REFRAME in buildRequestSection (tested directly — the pure
 * fn under change), plus one full-body render to prove the flag THREADS generate→body→request:
 *  - FLAG OFF  → today's asserting copy ("under the plan terms cited above" / "under my plan's
 *                coverage") — byte-identical, for a no-plan AND a plan-backed coverage line.
 *  - FLAG ON + NO plan on file (no planBenefit on any coverage line) → the counsel-approved
 *                REQUEST copy (insurer: "State, in writing, the specific plan provision…";
 *                provider: "place any collection activity on this balance on hold…").
 *  - INSURER TAIL (flag-independent — Item A's A1′ fix): the insurer is asked for the claim's
 *                line-by-line adjudication (EOB), its own artifact, in BOTH flag states — NEVER the
 *                provider's itemized statement of charges (which the provider holds). Asserted below.
 *  - FLAG ON + plan IS cited (planBenefit present) → asserting copy UNCHANGED (the reframe only
 *                fires when there's nothing to cite — never weakens a backed letter).
 *  - A bill-side ground (balance-billing) alongside the coverage line renders in BOTH modes
 *                (the reframe is isolated to the coverage ask).
 *
 * Run: npx tsx scripts/calibration/fixtures/cost-share-v2/coverage-noplan-request.ts
 * Exits non-zero on any failure (gate-usable).
 */
import { LETTER_TEMPLATES, buildRequestSection } from "../../../../src/lib/disputes/templates";
import type {
  DisputeEvidence,
  LineItemEvidence,
  ClaimEvidence,
} from "../../../../src/lib/disputes/evidence-resolver";
import type { ParsedBill } from "../../../../src/lib/billing/types";

let pass = 0;
const fails: string[] = [];
function has(name: string, body: string, needle: string) {
  if (body.includes(needle)) pass++;
  else fails.push(`✗ ${name}\n    MISSING: "${needle}"`);
}
function absent(name: string, body: string, needle: string) {
  if (!body.includes(needle)) pass++;
  else fails.push(`✗ ${name}\n    UNEXPECTED: "${needle}"`);
}

const PLAN_BENEFIT = {} as unknown as LineItemEvidence["planBenefit"]; // truthy → "plan cited"

// A denied covered service: disputeType coverage_contradiction → lands in the coverage bucket.
// insurancePaid:null → no per-line breakdown → the itemized/adjudication tail fires.
function coverageLine(withPlan: boolean): LineItemEvidence {
  return {
    lineItemId: "li-1",
    billingCode: { value: "99213", type: "CPT" },
    serviceSlug: "office_visit",
    serviceName: "Office visit",
    billedAmount: 300,
    insurancePaid: null,
    patientOwes: 300,
    patientPaid: 0,
    planBenefit: withPlan ? PLAN_BENEFIT : null,
    expectedPatientCost: null,
    actualPatientCost: 300,
    discrepancyAmount: 0,
    discrepancyReason: null,
    communityOutcome: null,
    siblingCodes: null,
    pricingBenchmark: null,
    auditFindings: [{
      type: "insurance_underpayment", severity: "high", title: "Claim denied",
      description: "The insurer denied this covered service.",
      estimatedOvercharge: 0, benchmarkAmount: null, benchmarkSource: null,
    }],
    auditRan: true,
    peerCodes: null,
    disputeType: "coverage_contradiction",
    citeGradeTier: "header",
    dollarAtStake: 300,
    serviceNotRenderedAttested: false,
    secondaryCoverageVerify: null,
  };
}
// A bill-side ground (balance-billing) that needs no plan — must still render in both modes.
function billSideLine(): LineItemEvidence {
  return {
    ...coverageLine(false),
    lineItemId: "li-2",
    serviceName: "Lab panel",
    billingCode: { value: "80053", type: "CPT" },
    disputeType: "balance_billing",
    auditFindings: [{
      type: "balance_billing", severity: "high", title: "Balance billed",
      description: "Billed above the allowed amount.",
      estimatedOvercharge: 50, benchmarkAmount: null, benchmarkSource: null,
    }],
    discrepancyAmount: 50,
  };
}
function makeEvidence(lines: LineItemEvidence[]): DisputeEvidence {
  const claim = {
    claimId: "claim-1", dateOfService: "2024-03-15", providerName: "Sample Medical Center",
    totalBilled: 600, planYear: 2024, lineItemEvidence: lines,
    effectiveTotals: {} as unknown as ClaimEvidence["effectiveTotals"],
    dataTrust: { headerReconciliationFailed: false, signViolation: false },
  } satisfies ClaimEvidence;
  return {
    claims: [claim],
    totals: { claimCount: 1, lineItemCount: lines.length, totalBilled: 600, totalDiscrepancy: 0 },
    planEvidence: null, networkEvidence: null, communityEvidence: null, legalBasis: [], gaps: [],
    dataTrust: { headerReconciliationFailed: false, signViolation: false },
  };
}

const ASSERT_INSURER = "under the plan terms cited above";
const ASSERT_PROVIDER = "under my plan's coverage";
const REFRAME_INSURER = "State, in writing, the specific plan provision";
const REFRAME_PROVIDER = "place any collection activity on this balance on hold";
const TAIL_PROVIDER_ITEMIZED = "Provide a fully itemized statement for this account";
const TAIL_ADJUDICATION = "line-by-line adjudication";

// reqSection — the pure fn under change, called directly (no body scaffolding).
const reqSection = (recipient: "insurer" | "provider", ev: DisputeEvidence, flagOn: boolean) =>
  buildRequestSection({ evidence: ev, planContext: null, recipient, letterRecovery: undefined, noPlanCoverageRequestOn: flagOn });

// ── INSURER ─────────────────────────────────────────────────────────────────
{
  const noPlan = makeEvidence([coverageLine(false)]);
  const off = reqSection("insurer", noPlan, false);
  has("insurer OFF no-plan → asserting copy", off, ASSERT_INSURER);
  absent("insurer OFF no-plan → no reframe", off, REFRAME_INSURER);
  has("insurer OFF → adjudication (EOB) tail (A1′ — insurer never gets an itemized-charges tail)", off, TAIL_ADJUDICATION);
  absent("insurer OFF → never the provider's itemized tail", off, TAIL_PROVIDER_ITEMIZED);

  const on = reqSection("insurer", noPlan, true);
  has("insurer ON no-plan → REFRAME request", on, REFRAME_INSURER);
  absent("insurer ON no-plan → drops the assertion", on, ASSERT_INSURER);
  has("insurer ON → adjudication (EOB) tail", on, TAIL_ADJUDICATION);
  absent("insurer ON → never the provider's itemized tail", on, TAIL_PROVIDER_ITEMIZED);

  const withPlan = reqSection("insurer", makeEvidence([coverageLine(true)]), true);
  has("insurer ON + plan cited → asserting copy (reframe inert)", withPlan, ASSERT_INSURER);
  absent("insurer ON + plan cited → no reframe", withPlan, REFRAME_INSURER);
}

// ── PROVIDER ────────────────────────────────────────────────────────────────
{
  const noPlan = makeEvidence([coverageLine(false)]);
  const off = reqSection("provider", noPlan, false);
  has("provider OFF no-plan → asserting copy", off, ASSERT_PROVIDER);
  absent("provider OFF no-plan → no reframe", off, REFRAME_PROVIDER);

  const on = reqSection("provider", noPlan, true);
  has("provider ON no-plan → REFRAME (collections hold)", on, REFRAME_PROVIDER);
  absent("provider ON no-plan → drops the assertion", on, ASSERT_PROVIDER);
}

// ── MIXED: a bill-side ground must still render in BOTH modes (reframe isolated) ──
{
  const mixed = makeEvidence([coverageLine(false), billSideLine()]);
  const on = reqSection("insurer", mixed, true);
  has("mixed ON → coverage reframe present", on, REFRAME_INSURER);
  has("mixed ON → bill-side (balance-billing) ask still present", on, "in-network cost-sharing");
}

// ── THREADING: full overcharge (provider) body render proves flag→body→buildRequestSection ──
{
  const bill = {
    id: "fx", documentId: "fx", userId: "fx", billType: "eob",
    provider: { name: "Sample Medical Center", address: "123 Care St\nAnytown, CA 90000" },
    patient: { name: "Jordan Sample", memberId: "MBR0" },
    insurer: { name: "Sample Health Plan", planName: "Sample PPO" },
    serviceDate: "2024-03-15", lineItems: [], totals: { totalBilled: 300 },
    rawText: "", confidence: 1, parseErrors: [],
  } as ParsedBill;
  const body = LETTER_TEMPLATES["overcharge"].body({
    patientName: "Jordan Sample", providerName: "Sample Medical Center", serviceDate: "2024-03-15",
    findings: [], bill, planContext: null, evidence: makeEvidence([coverageLine(false)]),
    gateUnverified: false, v3DesignOn: true, disputeGroundsOn: true, attestingName: "Jordan Sample",
    letterRecovery: undefined, noPlanCoverageRequestOn: true,
  });
  has("THREADING overcharge body ON → reframe reaches buildRequestSection", body, REFRAME_PROVIDER);
}

// ── Report ───────────────────────────────────────────────────────────────────
if (fails.length === 0) {
  console.log(`coverage-noplan-request: ALL GREEN ✓ (${pass} checks)`);
  process.exit(0);
} else {
  console.error(`coverage-noplan-request: ${fails.length} FAILED (${pass} passed)\n${fails.join("\n")}`);
  process.exit(1);
}
