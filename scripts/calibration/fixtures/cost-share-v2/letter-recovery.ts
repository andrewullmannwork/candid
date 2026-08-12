/**
 * §18 incr-4 GATE — the deductible-aware letter dollar.
 *
 * Proves the letter's request-block dollar is sourced from the SAME cost-share engine the
 * CARD uses (computeCostShareV2), not the deductible-BLIND `discrepancyAmount`, and that the
 * §18.10.D / OON-rate gate OMITS the precise dollar when shouldOwe rests on a guess. Each
 * scenario derives BOTH the card recovery (result.potentialRecovery) and the letter dollar
 * (resolveLetterRecovery) from ONE engine call → "letter dollar == card recovery" is proven
 * by construction, not by hand-tuned numbers.
 *
 * Run: npx tsx scripts/calibration/fixtures/cost-share-v2/letter-recovery.ts
 */
import {
  computeCostShareV2,
  type CostShareV2Result,
  type ServiceCostShare,
  type PlanCostShareParams,
  type AccumulatorSnapshot,
  type CostShareOverrides,
  type InsurerAdjudication,
  type NetworkTier,
} from "../../../../src/lib/claims/recovery-math";
import {
  resolveLetterRecovery,
  isPreciseDollarAssertable,
  type LineRecovery,
} from "../../../../src/lib/disputes/dispute-grounds";
import { LETTER_TEMPLATES } from "../../../../src/lib/disputes/templates";
import type {
  DisputeEvidence,
  LineItemEvidence,
  ClaimEvidence,
} from "../../../../src/lib/disputes/evidence-resolver";
import type { ParsedBill } from "../../../../src/lib/billing/types";

const fails: string[] = [];
function check(name: string, cond: boolean, got?: unknown) {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    fails.push(name);
    console.log(`  ✗ ${name}${got !== undefined ? ` — got ${JSON.stringify(got)}` : ""}`);
  }
}
const near = (a: number, b: number) => Math.abs(a - b) < 0.005;

// ── fixed plan / service (PPO, 20% coinsurance, $1,500 deductible, $5,000 OOP) ──
const PLAN: PlanCostShareParams = {
  inDeductibleIndividual: 1500, inDeductibleFamily: 3000,
  outDeductibleIndividual: 3000, outDeductibleFamily: 6000,
  inOopMaxIndividual: 5000, inOopMaxFamily: 10000,
  outOopMaxIndividual: 10000, outOopMaxFamily: 20000,
  inCoinsuranceDefault: 0.2, outCoinsuranceDefault: 0.4,
  deductibleCalcMethod: "embedded", combinedMedicalRxOop: true, coverageTier: "individual",
};
const SERVICE: ServiceCostShare = { covered: true, copay: null, coinsurance: 0.2, deductibleApplies: true, userStatedRate: false };
// Covered, but NO parsed cost-share rate (the cf91a49e case) → the engine can't compute the share
// → service_cost assumption → confirming deductible/network can't unlock the dollar.
const SERVICE_NO_RATE: ServiceCostShare = { covered: true, copay: null, coinsurance: null, deductibleApplies: true, userStatedRate: false };
// And the plan carries no default coinsurance either (else the default fills the rate).
const PLAN_NO_RATE: PlanCostShareParams = { ...PLAN, inCoinsuranceDefault: null, outCoinsuranceDefault: null };
const NO_OVERRIDE: CostShareOverrides = {
  deductibleMet: null, deductibleMetAsOf: null, oopMet: null, oopMetAsOf: null, userNetworkOverride: null,
};
const EMPTY_INSURER: InsurerAdjudication = {
  memberAppliedToDeductible: null, memberCoinsurance: null, memberCopay: null, deniedAmount: null, insurancePaid: null,
};
const ACC_UNMET: AccumulatorSnapshot = { deductibleApplied: 0, deductibleMax: 1500, oopApplied: 0, oopMax: 5000 };
const ACC_MET: AccumulatorSnapshot = { deductibleApplied: 1500, deductibleMax: 1500, oopApplied: 1500, oopMax: 5000 };

// Office visit billed $300, allowed $300, patient PAID $300 in full (the over-payment we recover).
function engine(accumulator: AccumulatorSnapshot | null, networkClaim: NetworkTier | null, service: ServiceCostShare = SERVICE, plan: PlanCostShareParams = PLAN): CostShareV2Result {
  return computeCostShareV2({
    line: { billed: 300, allowed: 300, patientPaid: 300, patientResponsibility: 300 },
    service,
    insurer: EMPTY_INSURER,
    plan,
    accumulator,
    overrides: NO_OVERRIDE,
    networkLine: null,
    networkClaim,
    claimInsurerPaidZero: false,
  });
}

// The deductible-BLIND discrepancy a pre-deductible bill produces: expected = 20% coinsurance
// ($60), actual = full $300 → $240. This is exactly what the OLD letter wrongly demanded.
const BLIND_DISCREPANCY = 240;
const PLAN_BENEFIT = {} as unknown as LineItemEvidence["planBenefit"]; // truthy → structuralCostShare ground

function costShareLine(): LineItemEvidence {
  return {
    lineItemId: "li-1",
    billingCode: { value: "99213", type: "CPT" },
    serviceSlug: "office_visit",
    serviceName: "Office visit",
    billedAmount: 300,
    insurancePaid: null,
    patientOwes: 0,
    patientPaid: 300,
    planBenefit: PLAN_BENEFIT,
    expectedPatientCost: 60,
    actualPatientCost: 300,
    discrepancyAmount: BLIND_DISCREPANCY,
    discrepancyReason: null,
    communityOutcome: null,
    siblingCodes: null,
    pricingBenchmark: null,
    auditFindings: [{
      type: "overcharge", severity: "high", title: "Cost-share misapplied",
      description: "Charged more than the plan's cost-sharing terms.",
      estimatedOvercharge: BLIND_DISCREPANCY, benchmarkAmount: null, benchmarkSource: null,
    }],
    auditRan: true,
    peerCodes: null,
    disputeType: "cost_share_misapplication",
    citeGradeTier: "header",
    dollarAtStake: BLIND_DISCREPANCY,
    serviceNotRenderedAttested: false,
    secondaryCoverageVerify: null,
  };
}
function makeEvidence(): DisputeEvidence {
  const claim = {
    claimId: "claim-1", dateOfService: "2024-03-15", providerName: "Sample Medical Center",
    totalBilled: 300, planYear: 2024, lineItemEvidence: [costShareLine()],
    // S309 F12 — real-shaped totals (provenance is REQUIRED by the per-line
    // money resolvers the recovery now shares with the claim page).
    // per_line_sum = cite-grade → the resolvers keep the lines' own values →
    // S1–S5 stay byte-identical.
    effectiveTotals: {
      patientPaid: 300,
      insurancePaid: 0,
      insuranceAdjusted: 0,
      patientResponsibility: 0,
      provenance: {
        patientPaidSource: "per_line_sum",
        insurancePaidSource: "per_line_sum",
        insuranceAdjustedSource: "per_line_sum",
        patientResponsibilitySource: "per_line_sum",
      },
    },
    dataTrust: { headerReconciliationFailed: false, signViolation: false },
  } satisfies ClaimEvidence;
  return {
    claims: [claim],
    totals: { claimCount: 1, lineItemCount: 1, totalBilled: 300, totalDiscrepancy: BLIND_DISCREPANCY },
    planEvidence: null, networkEvidence: null, communityEvidence: null, legalBasis: [], gaps: [],
    dataTrust: { headerReconciliationFailed: false, signViolation: false },
  };
}
function makeBill(): ParsedBill {
  return {
    id: "fx-bill", documentId: "fx-doc", userId: "fx-user", billType: "eob",
    provider: { name: "Sample Medical Center", address: "123 Care St\nAnytown, CA 90000" },
    patient: { name: "Jordan Sample", memberId: "MBR0" },
    insurer: { name: "Sample Health Plan", planName: "Sample PPO" },
    serviceDate: "2024-03-15", lineItems: [], totals: { totalBilled: 300 },
    rawText: "", confidence: 1, parseErrors: [],
  } as ParsedBill;
}

// Render the "overcharge" provider letter and isolate its RELIEF-REQUESTED block.
function renderReqBlock(evidence: DisputeEvidence, letterRecovery?: Map<string, LineRecovery>): string {
  const body = LETTER_TEMPLATES["overcharge"].body({
    patientName: "Jordan Sample", providerName: "Sample Medical Center", serviceDate: "2024-03-15",
    findings: [], bill: makeBill(), planContext: null, evidence,
    gateUnverified: true, v3DesignOn: true, disputeGroundsOn: true, letterRecovery,
  });
  const i = body.indexOf("RELIEF REQUESTED");
  return i >= 0 ? body.slice(i) : body;
}

const evidence = makeEvidence();

// ── S1 — pre-deductible, KNOWN not-met: the BUG FIX. Blind discrepancy = $240, but the
//        deductible-aware recovery is $0 (you owe the full allowed toward your deductible). ──
console.log("\nS1 — pre-deductible (known not-met): the $240 blind over-claim is eliminated");
{
  const result = engine(ACC_UNMET, "in_network");
  const rec = resolveLetterRecovery(evidence, new Map([["li-1", result]]), "provider");
  const byLine = rec.byLine.get("li-1")!;
  check("S1 card recovery is $0 (owe full allowed pre-deductible)", near(result.potentialRecovery, 0), result.potentialRecovery);
  check("S1 shouldOwe grounded (accumulator known)", result.shouldOweGrounded === true);
  check("S1 line assertable (grounded, no blocking assumption)", byLine.assertable === true);
  check("S1 not weakened (no prompt needed)", rec.weakened === false && rec.strengthenableFields.length === 0);
  check("S1 letter dollar == card recovery == $0", near(byLine.refund + byLine.writeOff, result.potentialRecovery), byLine);
  const off = renderReqBlock(evidence); // no letterRecovery → deductible-blind fallback
  const on = renderReqBlock(evidence, new Map([["li-1", { ...byLine }]]));
  check("S1 OFF (blind) demands the $240.00 the patient legitimately owes", off.includes("$240.00"), off.match(/\$[\d,.]+/g));
  check("S1 ON omits the $240 over-claim (only the reprocess demand)", !on.includes("$240.00"));
}

// ── S2 — deductible MET: a REAL $240 recovery; letter dollar == card recovery exactly. ──
console.log("\nS2 — deductible met: real $240 recovery preserved (letter == card)");
{
  const result = engine(ACC_MET, "in_network");
  const rec = resolveLetterRecovery(evidence, new Map([["li-1", result]]), "provider");
  const byLine = rec.byLine.get("li-1")!;
  check("S2 card recovery is $240 (paid $300, owe $60 coinsurance)", near(result.potentialRecovery, 240), result.potentialRecovery);
  check("S2 line assertable", byLine.assertable === true);
  check("S2 refund == $240, writeOff == $0", near(byLine.refund, 240) && near(byLine.writeOff, 0), byLine);
  check("S2 letter dollar == card recovery == $240", near(byLine.refund + byLine.writeOff, result.potentialRecovery), byLine);
  const on = renderReqBlock(evidence, new Map([["li-1", { ...byLine }]]));
  check("S2 ON letter demands the $240.00 refund", on.includes("$240.00"));
}

// ── S3 — deductible UNKNOWN (no accumulator): §18.10.D OMIT — the dollar rests on a guess. ──
console.log("\nS3 — deductible unknown: §18.10.D omit (not grounded → prompt to confirm)");
{
  const result = engine(null, "in_network");
  const rec = resolveLetterRecovery(evidence, new Map([["li-1", result]]), "provider");
  const byLine = rec.byLine.get("li-1")!;
  check("S3 shouldOwe NOT grounded (no met-status data)", result.shouldOweGrounded === false);
  check("S3 deductible_met assumption present", result.assumptions.some((a) => a.field === "deductible_met"));
  check("S3 line NOT assertable (omit + prompt)", byLine.assertable === false);
  check("S3 weakened + prompts to confirm DEDUCTIBLE", rec.weakened === true && rec.strengthenableFields.includes("deductible"));
  check("S3 isPreciseDollarAssertable === false", isPreciseDollarAssertable(result) === false);
  const on = renderReqBlock(evidence, new Map([["li-1", { ...byLine }]]));
  check("S3 ON omits the dollar (no $240, demand stands alone)", !on.includes("$240.00"));
}

// ── S4 — deductible met but NETWORK ASSUMED: the OON-rate gate omits a grounded recovery. ──
console.log("\nS4 — network assumed (no signal): OON-rate gate omits even a grounded $240");
{
  const result = engine(ACC_MET, null); // no networkClaim → networkAssumed → network assumption
  const rec = resolveLetterRecovery(evidence, new Map([["li-1", result]]), "provider");
  const byLine = rec.byLine.get("li-1")!;
  check("S4 shouldOwe grounded (deductible met)", result.shouldOweGrounded === true);
  check("S4 network assumption present (assumed in-network)", result.assumptions.some((a) => a.field === "network"));
  check("S4 line NOT assertable (OON gate fires despite grounding)", byLine.assertable === false);
  check("S4 weakened + prompts to confirm NETWORK", rec.weakened === true && rec.strengthenableFields.includes("network"));
  check("S4 isPreciseDollarAssertable === false (network gate)", isPreciseDollarAssertable(result) === false);
  const on = renderReqBlock(evidence, new Map([["li-1", { ...byLine }]]));
  check("S4 ON omits the dollar (could secretly be OON)", !on.includes("$240.00"));
}

// ── S5 — rate-starved line (no parsed coinsurance) + deductible/network unknown: the prompt is
//        SUPPRESSED, because confirming deductible/network can't unlock a dollar the missing rate
//        blocks. The cf91a49e honesty case. ──
console.log("\nS5 — rate-starved (no coinsurance) + deductible/network unknown: prompt SUPPRESSED");
{
  const result = engine(null, null, SERVICE_NO_RATE, PLAN_NO_RATE);
  const rec = resolveLetterRecovery(evidence, new Map([["li-1", result]]), "provider");
  const byLine = rec.byLine.get("li-1")!;
  check("S5 service_cost assumption present (rate unknown)", result.assumptions.some((a) => a.field === "service_cost"));
  check("S5 line NOT assertable", byLine.assertable === false);
  check("S5 weakened (a dollar was omitted)", rec.weakened === true);
  check("S5 NO promptable fields (deductible/network wouldn't unlock the dollar)", rec.strengthenableFields.length === 0);
}

// ── S6 (S309 F12) — single-adjudication provider bill: per-line paid/owes are NULL by design
//    (S304 — the header states adjudication once). The recovery now prices lines through the
//    SAME shared proration the claim page uses, so the letter claims the dollars the panel
//    shows. Live case: breast-imaging bill — $30-copay deductible-EXEMPT ultrasound, billed
//    $157.50 of a $388.50 bill whose header says the patient paid $239.71 → prorated paid
//    $97.18 → refund $67.18. The raw read produced $0 → the generic-relief branch. ──
console.log("\nS6 — single-adjudication bill: prorated per-line money reaches the letter (S309 F12)");
{
  const SERVICE_COPAY: ServiceCostShare = { covered: true, copay: 30, coinsurance: null, deductibleApplies: false, userStatedRate: false };
  const result = computeCostShareV2({
    line: { billed: 157.5, allowed: 97.18, patientPaid: 97.18, patientResponsibility: 97.18 },
    service: SERVICE_COPAY,
    insurer: EMPTY_INSURER,
    plan: PLAN,
    accumulator: null,
    overrides: { ...NO_OVERRIDE, deductibleMet: false, userNetworkOverride: "in_network" },
    networkLine: null,
    networkClaim: null,
    claimInsurerPaidZero: true,
  });
  const proLine: LineItemEvidence = {
    ...costShareLine(),
    lineItemId: "li-pro",
    billedAmount: 157.5,
    patientPaid: null,
    patientOwes: null,
    expectedPatientCost: 30,
    actualPatientCost: null,
    discrepancyAmount: 67.18,
    dollarAtStake: 67.18,
    auditFindings: [{
      type: "overcharge", severity: "high", title: "Cost-share misapplied",
      description: "Charged more than the plan's cost-sharing terms.",
      estimatedOvercharge: 67.18, benchmarkAmount: null, benchmarkSource: null,
    }],
  };
  const proEvidence: DisputeEvidence = {
    claims: [{
      claimId: "claim-pro", dateOfService: "2023-08-02", providerName: "Sample Imaging Center",
      totalBilled: 388.5, planYear: 2023, lineItemEvidence: [proLine],
      effectiveTotals: {
        patientPaid: 239.71,
        insurancePaid: 0,
        insuranceAdjusted: 148.79,
        patientResponsibility: 239.71,
        provenance: {
          patientPaidSource: "claim_header",
          insurancePaidSource: "claim_header",
          insuranceAdjustedSource: "claim_header",
          patientResponsibilitySource: "claim_header",
        },
      },
      dataTrust: { headerReconciliationFailed: false, signViolation: false },
    }],
    totals: { claimCount: 1, lineItemCount: 1, totalBilled: 388.5, totalDiscrepancy: 67.18 },
    planEvidence: null, networkEvidence: null, communityEvidence: null, legalBasis: [], gaps: [],
    dataTrust: { headerReconciliationFailed: false, signViolation: false },
  };
  const rec = resolveLetterRecovery(proEvidence, new Map([["li-pro", result]]), "insurer");
  const byLine = rec.byLine.get("li-pro")!;
  check("S6 engine sees the $67.18 recovery (copay 30, ded-exempt, network answered)", near(result.potentialRecovery, 67.18), result.potentialRecovery);
  check("S6 line assertable (grounded copay + answered network + documented exemption)", byLine.assertable === true, result.assumptions);
  check("S6 refund == $67.18 from PRORATED per-line paid (raw columns are null)", near(byLine.refund, 67.18), byLine);
  check("S6 writeOff == $0 (the prorated paid covers the whole recovery)", near(byLine.writeOff, 0), byLine);
  check("S6 letter dollar == panel recovery (the S309 retest gap closed)", near(byLine.refund + byLine.writeOff, result.potentialRecovery), byLine);
}

console.log(`\ncost-share-v2 letter-recovery: ${fails.length === 0 ? "ALL GREEN ✓" : `${fails.length} FAILED`}`);
if (fails.length > 0) {
  for (const f of fails) console.log(`  ✗ ${f}`);
  process.exit(1);
}
