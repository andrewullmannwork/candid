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
import { LETTER_TEMPLATES, buildSenderBlock } from "../../../../src/lib/disputes/templates";
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
function renderReqBlock(evidence: DisputeEvidence, letterRecovery?: Map<string, LineRecovery>, holdCallAt?: string | null): string {
  const body = LETTER_TEMPLATES["overcharge"].body({
    patientName: "Jordan Sample", providerName: "Sample Medical Center", serviceDate: "2024-03-15",
    findings: [], bill: makeBill(), planContext: null, evidence,
    gateUnverified: true, v3DesignOn: true, disputeGroundsOn: true, letterRecovery, holdCallAt,
  });
  const i = body.indexOf("RELIEF REQUESTED");
  return i >= 0 ? body.slice(i) : body;
}

// S310 F18 — the insurer-letter twin, so the refund demand's HOME is pinned in
// both directions (provider letter never prints it; insurer letter does).
function renderInsurerReqBlock(evidence: DisputeEvidence, letterRecovery?: Map<string, LineRecovery>): string {
  const body = LETTER_TEMPLATES["insurance_appeal"].body({
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
  // S310 F18 — the cost-share refund is the INSURER letter's demand; a
  // provider letter never prints it, even on the blind OFF path. The legacy
  // blind over-claim (and its ON-path elimination) now pins on the insurer.
  check("S1 provider letter never demands the cost-share refund — OFF path included (S310 F18)", !off.includes("$240.00"), off.match(/\$[\d,.]+/g));
  check("S1 ON omits the $240 over-claim (only the reprocess demand)", !on.includes("$240.00"));
  const insOff = renderInsurerReqBlock(evidence);
  const insOn = renderInsurerReqBlock(evidence, new Map([["li-1", { ...byLine }]]));
  check("S1 insurer OFF (blind) demands the $240.00 the patient legitimately owes", insOff.includes("$240.00"), insOff.match(/\$[\d,.]+/g));
  check("S1 insurer ON omits the $240 over-claim", !insOn.includes("$240.00"));
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
  // S310 F18 — the real $240 refund is the INSURER letter's demand; the
  // provider letter keeps its correction ask without the refund clause.
  check("S2 provider letter carries no refund demand (S310 F18)", !on.includes("$240.00"));
  check(
    "S2 insurer ON letter demands the $240.00 refund",
    renderInsurerReqBlock(evidence, new Map([["li-1", { ...byLine }]])).includes("$240.00"),
  );
}

// ── S310 — the sender block (prepended at the two compose exits): shape + fail-soft. ──
console.log("\nS310 — sender block: name + address above the dateline, fail-soft");
{
  const addr = { line1: "456 Oak Ave", line2: null, city: "Pittsburg", state: "WA", zip: "87726" };
  check(
    "sender block: name + address, standard shape",
    buildSenderBlock("Jordan Sample", addr) === "Jordan Sample\n456 Oak Ave\nPittsburg, WA 87726",
    buildSenderBlock("Jordan Sample", addr),
  );
  check(
    "sender block: line2 renders when present",
    buildSenderBlock("Jordan Sample", { ...addr, line2: "Apt 2" }) ===
      "Jordan Sample\n456 Oak Ave\nApt 2\nPittsburg, WA 87726",
  );
  check("sender block: no address → nothing (fail-soft)", buildSenderBlock("Jordan Sample", null) === null);
}

// ── S310 — the collections-hold ask: an attested phone hold upgrades the standing
//    clause to a written confirmation of THAT call (Andrew-approved copy). ──
console.log("\nS310 — hold ask: standing clause vs written confirmation of the attested call");
{
  const ev = makeEvidence();
  ev.claims[0].lineItemEvidence[0] = { ...ev.claims[0].lineItemEvidence[0], patientOwes: 120 };
  const plain = renderReqBlock(ev);
  check(
    "S310 hold: standing clause asks for the hold when no call is attested",
    plain.includes("place any collection activity for this balance on hold"),
  );
  const withCall = renderReqBlock(ev, undefined, "2026-08-11T20:00:00.000Z");
  check(
    "S310 hold: attested call upgrades to the written confirmation",
    withCall.includes("Please confirm in writing the hold I requested by phone on August 11, 2026."),
    withCall.match(/hold[^\n]*/g),
  );
  check(
    "S310 hold: the generic clause stands down when confirming",
    !withCall.includes("place any collection activity for this balance on hold"),
  );
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

// ── S312 (Andrew's §0 ruling, approved §1) — the provider letter argues from the BILL:
//    the evidence header names the bill's arithmetic, no-ask lines render as PLAIN charge
//    lines (their plan citations were insurer-side logic on a provider envelope), the
//    disputed line LEADS with the bill's own charge and folds plan basis + Source + Plan
//    language into ONE bullet (the "Discrepancy: $X" sentence — the insurer's reprocessing
//    money — is gone), the sums block renders from the SAME fold the relief reads (F17
//    row ⇒ Overpaid line ⇔ the refund ask), and the fold goes SINGULAR on one cited line.
//    The insurer letter on IDENTICAL evidence keeps the plan-terms evidence byte-for-byte
//    — the party-scope proof at fixture level. Mini fresh-claim (696a7c07) replica. ──
console.log("\nS312 — the provider letter argues from the bill (evidence restructure, both directions)");
{
  const benefit: NonNullable<LineItemEvidence["planBenefit"]> = {
    covered: true, copay: 30, coinsurance: null, deductibleApplies: false,
    source: "sbc_parser", confidence: 1,
    citation: "Plan SBC — Basic Imaging (X-ray / Ultrasound)",
    sbcExcerpt: "Outpatient radiology center   $30/visit   50%", sbcPage: 3,
    sbcExcerptVerified: true, citationSource: null,
    sourcedFrom: "user_exact", sourcedFromYear: 2026,
  };
  const disputed: LineItemEvidence = {
    ...costShareLine(), lineItemId: "li-us",
    serviceName: "HC US UNI BREAST LIMITED", billingCode: { value: "76642", type: "CPT" },
    billedAmount: 157.5, patientPaid: null, patientOwes: null,
    planBenefit: benefit, expectedPatientCost: 30, actualPatientCost: 97.18,
    discrepancyAmount: 67.18, dollarAtStake: 67.18,
    auditFindings: [{
      type: "overcharge", severity: "high", title: "Cost-share misapplied",
      description: "Charged more than the plan's cost-sharing terms.",
      estimatedOvercharge: 67.18, benchmarkAmount: null, benchmarkSource: null,
    }],
  };
  // The no-ask sibling: a trusted planBenefit and nothing wrong — today's letters cite it
  // anyway (the §0 defect); the bill view renders it as a plain charge line.
  const mammo: LineItemEvidence = {
    ...costShareLine(), lineItemId: "li-mam",
    serviceName: "HC MAMMO DIAG BILAT INCL CAD", billingCode: { value: "77066", type: "CPT" },
    billedAmount: 147, patientPaid: null, patientOwes: null, disputeType: "other",
    planBenefit: {
      ...benefit, copay: null, coinsurance: 0.2,
      citation: "Plan SBC — Advanced Imaging (CT/PET/MRI)", sbcExcerpt: "20% coinsurance",
    },
    expectedPatientCost: null, actualPatientCost: null, discrepancyAmount: null,
    dollarAtStake: 0, auditFindings: null,
  };
  const mk312 = (paid: number): DisputeEvidence => ({
    claims: [{
      claimId: "claim-312", dateOfService: "2023-08-02", providerName: "Sample Imaging Center",
      totalBilled: 388.5, planYear: 2026, lineItemEvidence: [mammo, disputed],
      effectiveTotals: {
        patientPaid: paid,
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
    totals: { claimCount: 1, lineItemCount: 2, totalBilled: 388.5, totalDiscrepancy: 67.18 },
    planEvidence: null, networkEvidence: null, communityEvidence: null, legalBasis: [], gaps: [],
    dataTrust: { headerReconciliationFailed: false, signViolation: false },
  });
  const renderFull = (type: "overcharge" | "insurance_appeal", ev: DisputeEvidence): string => {
    const rec = resolveLetterRecovery(ev, new Map(), type === "insurance_appeal" ? "insurer" : "provider");
    return LETTER_TEMPLATES[type].body({
      patientName: "Jordan Sample", providerName: "Sample Imaging Center", serviceDate: "2023-08-02",
      findings: [], bill: makeBill(), planContext: null, evidence: ev,
      gateUnverified: true, v3DesignOn: true, disputeGroundsOn: true,
      letterRecovery: rec.byLine, recovery: rec,
    });
  };

  // Direction 1 — paid $249.71 (the $10 overpayment story).
  const pro = renderFull("overcharge", mk312(249.71));
  check("S312 provider header = the bill's arithmetic", pro.includes("THIS BILL'S CHARGES AND MY PAYMENTS"));
  check("S312 provider: old evidence header gone", !pro.includes("SUPPORTING EVIDENCE FOR EACH CHARGE"));
  check(
    "S312 provider: the no-ask line is a PLAIN charge line (headline, then the next line)",
    pro.includes("1. HC MAMMO DIAG BILAT INCL CAD (CPT 77066) — billed $147.00\n\n2. HC US UNI BREAST LIMITED (CPT 76642) — billed $157.50"),
  );
  check("S312 provider: the no-ask line's plan citation is gone", !pro.includes("specifies 20% coinsurance"));
  check(
    "S312 provider: the disputed line leads with the bill's own charge (§1 approved bytes)",
    pro.includes(
      `   - This bill charges me $97.18 for this service. My plan specifies a $30.00 copay for it, as determined by my insurer. Source: Plan SBC — Basic Imaging (X-ray / Ultrasound). Plan language: "Outpatient radiology center   $30/visit   50%"`,
    ),
  );
  check("S312 provider: the Discrepancy sentence (insurer money) is gone", !pro.includes("Discrepancy:"));
  check(
    "S312 provider: sums block from the fold (charged / payments / overpaid)",
    pro.includes("Charged to me on this bill: $239.71\nMy payments toward this bill: $249.71\nOverpaid: $10.00"),
  );
  check(
    "S312 provider: the fold goes SINGULAR on one cited line",
    pro.includes("for this service (cited above), as determined by my insurer"),
  );
  check("S312 provider: the F17 refund ask agrees with the sums", pro.includes("Refund the $10.00 difference"));

  // Direction 2 — paid reset to $239.71: the overpayment dies; sums two-line; correction-only.
  const proReset = renderFull("overcharge", mk312(239.71));
  check(
    "S312 provider (reset): sums two-line, Overpaid absent",
    proReset.includes("Charged to me on this bill: $239.71\nMy payments toward this bill: $239.71") &&
      !proReset.includes("Overpaid:"),
  );
  check("S312 provider (reset): correction-only (no refund ask)", !proReset.includes("Refund the $10.00 difference"));

  // The party-scope proof — the insurer letter on IDENTICAL evidence keeps the plan-terms
  // evidence: every line cited, the Expected/Actual/Discrepancy arithmetic intact, no sums.
  const ins = renderFull("insurance_appeal", mk312(249.71));
  check("S312 insurer: keeps its own evidence header", ins.includes("SUPPORTING DETAIL"));
  check("S312 insurer: never the bill-view header", !ins.includes("THIS BILL'S CHARGES AND MY PAYMENTS"));
  check("S312 insurer: no-ask line keeps its plan citation", ins.includes("specifies 20% coinsurance for this service"));
  check(
    "S312 insurer: the Expected/Actual/Discrepancy arithmetic intact",
    ins.includes("   - Expected patient cost per plan: $30.00. Actual patient responsibility: $97.18. Discrepancy: $67.18."),
  );
  check("S312 insurer: no bill-view lead sentence", !ins.includes("This bill charges me"));
  check("S312 insurer: no sums block", !ins.includes("Charged to me on this bill:"));
  check("S312 insurer: the F17 overpayment never folds insurer-side", !ins.includes("Refund the $10.00"));
}

console.log(`\ncost-share-v2 letter-recovery: ${fails.length === 0 ? "ALL GREEN ✓" : `${fails.length} FAILED`}`);
if (fails.length > 0) {
  for (const f of fails) console.log(`  ✗ ${f}`);
  process.exit(1);
}
