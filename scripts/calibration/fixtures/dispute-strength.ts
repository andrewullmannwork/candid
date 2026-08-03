/**
 * Dispute strength scoring fixture — Block A (Dispute Letter Overhaul).
 *
 * Block Ship Gate G4 — manually-runnable fixture (no CI wiring yet; follow-up
 * obligation per Gate 4 spec). Exercises the pure scoring contract in
 * src/lib/disputes/strength-scoring.ts: the three axes, the §1e safe defaults
 * (divide-by-zero / empty → "Needs support" / "Attention", never the top band),
 * the data-trust precedence rule, the dispute-type classifier, and config
 * parsing with per-field fallback.
 *
 * Run:
 *   cd /Users/andrewullmann/Desktop/candid
 *   npx tsx scripts/calibration/fixtures/dispute-strength.ts
 *
 * Pass criteria: all cases assert PASS. Exit code 0 on PASS, 1 on any failure.
 */

import {
  computeDisputeStrength,
  classifyDisputeType,
  deriveCiteGradeTier,
  deriveDollarAtStake,
  evaluateDataTrust,
  parseStrengthConfig,
  DEFAULT_STRENGTH_CONFIG,
  DEFAULT_STRENGTH_WEIGHTS,
} from "../../../src/lib/disputes/strength-scoring";
import type {
  DisputeEvidence,
  LineItemEvidence,
  ClaimEvidence,
  PlanBenefitDetail,
  EvidenceGap,
  LegalBasisRef,
} from "../../../src/lib/disputes/evidence-resolver";

// ---------------------------------------------------------------------------
// Tiny assertion harness
// ---------------------------------------------------------------------------
let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
function eq<T>(name: string, actual: T, expected: T): void {
  check(name, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------
let counter = 0;

function makePlanBenefit(over: Partial<PlanBenefitDetail> = {}): PlanBenefitDetail {
  return {
    covered: true,
    copay: 20,
    coinsurance: null,
    source: "sbc_parser",
    confidence: 0.9,
    citation: "Plan SBC — Office visit",
    sbcExcerpt: "Primary care visit: $20 copay",
    sbcPage: 3,
    sbcExcerptVerified: false,
    citationSource: "user_doc",
    sourcedFrom: "user_exact",
    sourcedFromYear: 2024,
    ...over,
  };
}

function makeLine(over: Partial<LineItemEvidence> = {}): LineItemEvidence {
  const base = {
    lineItemId: `li_${++counter}`,
    billingCode: { value: "99213", type: "CPT" },
    serviceSlug: "office_visit",
    serviceName: "Office visit",
    billedAmount: 200,
    insurancePaid: null,
    patientOwes: null,
    planBenefit: null,
    expectedPatientCost: null,
    actualPatientCost: null,
    discrepancyAmount: null,
    discrepancyReason: null,
    communityOutcome: null,
    siblingCodes: null,
    pricingBenchmark: null,
    auditFindings: null,
    peerCodes: null,
    ...over,
  } as LineItemEvidence;
  // Mirror the resolver: derive the normalization fields unless overridden.
  base.disputeType = over.disputeType ?? classifyDisputeType(base);
  base.citeGradeTier = over.citeGradeTier ?? deriveCiteGradeTier(base);
  base.dollarAtStake = over.dollarAtStake ?? deriveDollarAtStake(base);
  return base;
}

function makeEvidence(
  lines: LineItemEvidence[],
  opts: {
    dataTrust?: { headerReconciliationFailed: boolean; signViolation: boolean };
    gaps?: EvidenceGap[];
    legalBasis?: LegalBasisRef[];
  } = {},
): DisputeEvidence {
  const dataTrust = opts.dataTrust ?? { headerReconciliationFailed: false, signViolation: false };
  const claim: ClaimEvidence = {
    claimId: "c1",
    dateOfService: "2024-03-01",
    providerName: "Test Clinic",
    totalBilled: lines.reduce((s, l) => s + l.billedAmount, 0),
    planYear: 2024,
    lineItemEvidence: lines,
    effectiveTotals: {
      patientPaid: 0,
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
    dataTrust,
  };
  return {
    claims: [claim],
    totals: {
      claimCount: 1,
      lineItemCount: lines.length,
      totalBilled: claim.totalBilled,
      totalDiscrepancy: 0,
    },
    planEvidence: null,
    networkEvidence: null,
    communityEvidence: null,
    legalBasis: opts.legalBasis ?? [],
    gaps: opts.gaps ?? [],
    dataTrust,
  };
}

const gap = (kind: string): EvidenceGap =>
  ({ kind, title: kind, description: kind } as unknown as EvidenceGap);
const STATUTE: LegalBasisRef = {
  statute: "ACA §2719",
  summary: "full and fair review",
  appliesTo: ["appeal_process"],
};

// ===========================================================================
console.log("\n[1] Safe defaults — empty / null evidence never crash or over-promise");
// ===========================================================================
for (const [label, ev] of [
  ["null", null],
  ["undefined", undefined],
  ["empty claims", makeEvidence([])],
] as const) {
  const r = computeDisputeStrength(ev);
  eq(`${label}: dataTrust gate = pass`, r.dataTrust.gate, "pass");
  eq(`${label}: evidence band = needs_support`, r.evidenceStrength.band, "needs_support");
  eq(`${label}: evidence score = 0`, r.evidenceStrength.score, 0);
  eq(`${label}: readiness = attention`, r.readiness.state, "attention");
  check(`${label}: band is NOT well_supported`, r.evidenceStrength.band !== "well_supported");
  check(`${label}: readiness is NOT airtight`, r.readiness.state !== "airtight");
}

// ===========================================================================
console.log("\n[2] Data-trust gate + precedence (§1a)");
// ===========================================================================
{
  const clean = computeDisputeStrength(makeEvidence([makeLine()]));
  eq("clean bill → pass", clean.dataTrust.gate, "pass");

  const sign = computeDisputeStrength(
    makeEvidence([makeLine()], { dataTrust: { headerReconciliationFailed: false, signViolation: true } }),
  );
  eq("sign violation only → warn", sign.dataTrust.gate, "warn");
  eq("warn carries no reason", sign.dataTrust.reason, null);
  eq("warn flags signViolation", sign.dataTrust.signViolation, true);

  const recon = computeDisputeStrength(
    makeEvidence([makeLine()], { dataTrust: { headerReconciliationFailed: true, signViolation: false } }),
  );
  eq("recon failure → hard_stop", recon.dataTrust.gate, "hard_stop");
  eq("hard_stop reason", recon.dataTrust.reason, "bill_reconciliation_pending");

  const both = computeDisputeStrength(
    makeEvidence([makeLine()], { dataTrust: { headerReconciliationFailed: true, signViolation: true } }),
  );
  eq("recon + sign → hard_stop precedence (§1a)", both.dataTrust.gate, "hard_stop");
  eq("hard_stop still reports sign", both.dataTrust.signViolation, true);

  // evaluateDataTrust directly
  eq("evaluateDataTrust(null) = pass", evaluateDataTrust(null).gate, "pass");
}

// ===========================================================================
console.log("\n[3] Divide-by-zero guard — strong spine but $0 at stake → needs_support");
// ===========================================================================
{
  // Verbatim cite-grade plan quote (strongest line) but zero dollars at stake.
  const line = makeLine({
    planBenefit: makePlanBenefit({ sbcExcerptVerified: true }),
    discrepancyAmount: 0,
    auditFindings: null,
    dollarAtStake: 0,
  });
  const r = computeDisputeStrength(makeEvidence([line]));
  eq("Σ(stake) = 0 → totalDollarAtStake 0", r.evidenceStrength.totalDollarAtStake, 0);
  eq("Σ(stake) = 0 → score 0 (§1e guard)", r.evidenceStrength.score, 0);
  eq("Σ(stake) = 0 → band needs_support (never well_supported)", r.evidenceStrength.band, "needs_support");
  // the per-line score itself is high (verbatim documentary spine) — proving the
  // guard is the money-weight divide, not a weak line.
  check("per-line score is high despite $0 weight", (r.evidenceStrength.perLine[0]?.score ?? 0) >= 0.99);
}

// ===========================================================================
console.log("\n[4] Evidence bands — money-weighted aggregate + thresholds");
// ===========================================================================
{
  // A cost-share line with a verbatim plan quote scores 1.0 (documentary 1.0 ×
  // verbatim 1.0 × spine 1.0), with real dollars at stake.
  const strongLine = makeLine({
    planBenefit: makePlanBenefit({ sbcExcerptVerified: true }),
    discrepancyAmount: 150,
  });
  const ev = makeEvidence([strongLine]);

  const wellR = computeDisputeStrength(ev); // default thresholds (well ≥ 0.67)
  eq("verbatim cost-share line → score ~1.0", Math.round(wellR.evidenceStrength.score * 100) / 100, 1);
  eq("score 1.0 with default thresholds → well_supported", wellR.evidenceStrength.band, "well_supported");
  eq("dollarAtStake threaded through (max(disc, overcharge))", wellR.evidenceStrength.totalDollarAtStake, 150);

  // Same score 1.0, but inject thresholds so it lands in each lower band — proves
  // the band mapping is threshold-driven (G6 tunable), not hardcoded.
  const partial = computeDisputeStrength(ev, {
    config: { weights: DEFAULT_STRENGTH_WEIGHTS, thresholds: { partiallySupported: 0.5, wellSupported: 2.0 } },
    letterRequirementsOn: false,
  });
  eq("score 1.0, well-cutoff 2.0 → partially_supported", partial.evidenceStrength.band, "partially_supported");

  const needs = computeDisputeStrength(ev, {
    config: { weights: DEFAULT_STRENGTH_WEIGHTS, thresholds: { partiallySupported: 1.5, wellSupported: 2.0 } },
    letterRequirementsOn: false,
  });
  eq("score 1.0, partial-cutoff 1.5 → needs_support", needs.evidenceStrength.band, "needs_support");

  // Money-weighting: a high-stake weak line dominates a low-stake strong line.
  const weakBig = makeLine({ billingCode: { value: "X", type: "CPT" }, dollarAtStake: 1000, planBenefit: null, auditFindings: null });
  const strongSmall = makeLine({ planBenefit: makePlanBenefit({ sbcExcerptVerified: true }), discrepancyAmount: 1 });
  const mixed = computeDisputeStrength(makeEvidence([weakBig, strongSmall]));
  check(
    "money-weighted: big weak line pulls aggregate below the small strong line's score",
    mixed.evidenceStrength.score < 0.5,
    `score=${mixed.evidenceStrength.score}`,
  );
}

// ===========================================================================
console.log("\n[5] classifyDisputeType — finding types + structural signals (§1e)");
// ===========================================================================
{
  const f = (type: string) => ({ type, severity: "medium", title: type, estimatedOvercharge: 10, benchmarkAmount: null, benchmarkSource: null });
  eq("balance_billing finding → balance_billing", classifyDisputeType({ auditFindings: [f("balance_billing")] } as never), "balance_billing");
  eq("insurance_underpayment → coverage_contradiction", classifyDisputeType({ auditFindings: [f("insurance_underpayment")] } as never), "coverage_contradiction");
  eq("zero_cost_share_overcharge → cost_share_misapplication", classifyDisputeType({ auditFindings: [f("zero_cost_share_overcharge")] } as never), "cost_share_misapplication");
  eq("overcharge → benchmark", classifyDisputeType({ auditFindings: [f("overcharge")] } as never), "benchmark");
  eq("planBenefit + discrepancy → cost_share_misapplication", classifyDisputeType({ planBenefit: makePlanBenefit(), discrepancyAmount: 50 } as never), "cost_share_misapplication");
  eq("planBenefit only → coverage_contradiction", classifyDisputeType({ planBenefit: makePlanBenefit() } as never), "coverage_contradiction");
  eq("peerCodes≥2 (no plan) → coding_peer", classifyDisputeType({ peerCodes: [{ code: "a", codeType: "CPT", confidence: 0.9, promotionState: "corroborated" }, { code: "b", codeType: "CPT", confidence: 0.9, promotionState: "corroborated" }] } as never), "coding_peer");
  eq("no signals → other", classifyDisputeType({} as never), "other");
}

// ===========================================================================
console.log("\n[6] deriveCiteGradeTier + deriveDollarAtStake");
// ===========================================================================
{
  eq("verified plan quote → verbatim", deriveCiteGradeTier({ planBenefit: makePlanBenefit({ sbcExcerptVerified: true }) }), "verbatim");
  eq("unverified plan quote → header", deriveCiteGradeTier({ planBenefit: makePlanBenefit({ sbcExcerptVerified: false }) }), "header");
  eq("no plan quote → statute", deriveCiteGradeTier({ planBenefit: null }), "statute");

  eq("dollarAtStake = max(discrepancy, Σovercharge)", deriveDollarAtStake({ discrepancyAmount: 30, auditFindings: [{ type: "overcharge", severity: "high", title: "t", estimatedOvercharge: 80, benchmarkAmount: null, benchmarkSource: null }] }), 80);
  eq("dollarAtStake floors at 0 (negative discrepancy)", deriveDollarAtStake({ discrepancyAmount: -5, auditFindings: null }), 0);
  eq("dollarAtStake from discrepancy when no findings", deriveDollarAtStake({ discrepancyAmount: 42, auditFindings: null }), 42);
}

// ===========================================================================
console.log("\n[7] Readiness (MVDL §1b) — attention / ready_to_send / airtight");
// ===========================================================================
{
  const backedLine = makeLine({ planBenefit: makePlanBenefit({ sbcExcerptVerified: true }), discrepancyAmount: 50 });

  // All required met (data-trust pass, backed claim, address present, identity
  // resolved) + no optional gaps → airtight.
  const airtight = computeDisputeStrength(makeEvidence([backedLine], { legalBasis: [STATUTE], gaps: [] }), { patientIdentityResolved: true, letterRequirementsOn: false });
  eq("MVDL met + no optional gaps → airtight", airtight.readiness.state, "airtight");
  eq("airtight: mvdlMet true", airtight.readiness.mvdlMet, true);
  eq("airtight: requiredMet 4/4", `${airtight.readiness.requiredMet}/${airtight.readiness.requiredTotal}`, "4/4");

  // MVDL met but an optional "make it stronger" gap open → ready_to_send.
  const ready = computeDisputeStrength(makeEvidence([backedLine], { legalBasis: [STATUTE], gaps: [gap("cite_grade_incomplete")] }), { patientIdentityResolved: true, letterRequirementsOn: false });
  eq("MVDL met + optional gap → ready_to_send", ready.readiness.state, "ready_to_send");
  check("ready_to_send lists the optional gap", ready.readiness.optionalOpen.includes("cite_grade_incomplete"));

  // Missing recipient address → required floor not met → attention.
  const noAddr = computeDisputeStrength(makeEvidence([backedLine], { legalBasis: [STATUTE], gaps: [gap("provider_address_missing")] }), { patientIdentityResolved: true, letterRequirementsOn: false });
  eq("missing address → attention", noAddr.readiness.state, "attention");
  eq("missing address → recipientAddress false", noAddr.readiness.required.recipientAddress, false);

  // Patient identity unresolved (Block A default on first drafts) → attention.
  const noIdentity = computeDisputeStrength(makeEvidence([backedLine], { legalBasis: [STATUTE], gaps: [] }));
  eq("patient identity unknown → attention", noIdentity.readiness.state, "attention");
  eq("patient identity unknown → patientIdentity false", noIdentity.readiness.required.patientIdentity, false);

  // Statute alone backs the claim (binding NOT required, §1b/§2).
  eq("statute-backed counts as backedClaim", noIdentity.readiness.required.backedClaim, true);

  // Hard-stop fails the data-trust required item.
  const hs = computeDisputeStrength(makeEvidence([backedLine], { legalBasis: [STATUTE], dataTrust: { headerReconciliationFailed: true, signViolation: false } }), { patientIdentityResolved: true, letterRequirementsOn: false });
  eq("hard_stop → dataTrustPass required false", hs.readiness.required.dataTrustPass, false);
  eq("hard_stop → readiness attention", hs.readiness.state, "attention");
}

// ===========================================================================
console.log("\n[8] parseStrengthConfig — per-field fallback to §1e defaults");
// ===========================================================================
{
  const fromNull = parseStrengthConfig(null);
  eq("null config → default well threshold", fromNull.thresholds.wellSupported, DEFAULT_STRENGTH_CONFIG.thresholds.wellSupported);
  eq("null config → default documentary weight", fromNull.weights.probativeTier.documentary, 1.0);

  const garbage = parseStrengthConfig({ weights: "nope", thresholds: 42 });
  eq("garbage config → default header factor", garbage.weights.citeGradeFactor.header, 0.7);

  const partial = parseStrengthConfig({ thresholds: { wellSupported: 0.8 } });
  eq("partial override applies wellSupported", partial.thresholds.wellSupported, 0.8);
  eq("partial override keeps default partiallySupported", partial.thresholds.partiallySupported, 0.34);
  eq("partial override keeps default weights", partial.weights.categoryWeight.spine, 1.0);

  const full = parseStrengthConfig({
    weights: {
      probativeTier: { documentary: 0.9, statistical: 0.5, inferred: 0.3 },
      citeGradeFactor: { verbatim: 0.95, header: 0.6, statute: 0.4 },
      categoryWeight: { spine: 0.9, boost: 0.4, benchmark: 0.3 },
    },
    thresholds: { partiallySupported: 0.4, wellSupported: 0.75 },
  });
  eq("full override applies documentary", full.weights.probativeTier.documentary, 0.9);
  eq("full override applies wellSupported", full.thresholds.wellSupported, 0.75);

  // NaN / non-finite rejected → fallback.
  const nan = parseStrengthConfig({ thresholds: { wellSupported: "0.8" } });
  eq("string number rejected → default", nan.thresholds.wellSupported, 0.67);
}

// ---------------------------------------------------------------------------
console.log(`\n${"=".repeat(60)}`);
console.log(`Dispute strength fixture: ${pass} passed, ${fail} failed`);
console.log("=".repeat(60));
process.exit(fail > 0 ? 1 : 0);
