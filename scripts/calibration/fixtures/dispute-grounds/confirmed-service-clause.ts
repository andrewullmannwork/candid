/**
 * confirmed-service-clause — S293 (#6 structural).
 *
 * INVARIANT LOCKED HERE:
 *   A disputed service whose coverage the needs panel presented as KNOWN
 *   (covered, with a non-null copay or coinsurance — the precondition for the
 *   S292 aggregate "Looks right" confirm) and that the user CONFIRMED cannot
 *   fail to produce its SUPPORTING DETAIL clause in the composed letter —
 *   even on the sparsest real bill shape: an itemized bill whose per-line EOB
 *   fields (insurance_paid, patient_owes) are ALL NULL and which carries no
 *   audit / community / pricing / peer signals.
 *
 * Data shape is the REAL account this failed on (andrewullmanntest292@,
 * claim 146b1b9f, dispute 80a705ac, DEV): a catalog-matched plan with ZERO
 * plan_covered_services rows whose coverage lives on the linked canonical
 * (pcp_visit $10 copay) plus three preventive $0 borrows — the user confirmed
 * all four services and the persisted letter still had zero clauses. The
 * resolver-side fixes (Tier-1 canonical gap-fill parity with S290 +
 * confirmed-exact-match adoption in the S154 post-pass) are proven against
 * the live rows by scripts/s293-probe-test292-pipeline.ts; THIS fixture locks
 * the compose-side contract those fixes feed:
 *   (a) a confirmed-known benefit (covered:true, cost term non-null,
 *       citation possibly "", sbcExcerptVerified false) renders a Case-2
 *       clause under gateUnverified — for BOTH v3DesignOn states;
 *   (b) an empty citation NEVER renders a dangling "Source: ." fragment;
 *   (c) a REJECTED line (benefit stripped) silently drops its clause while
 *       the others keep the section;
 *   (d) the compose-time counterfactual (nothing confirmed, no benefits)
 *       still omits the section header entirely (S292 bare-header rule).
 *
 * Run:  npx tsx scripts/calibration/fixtures/dispute-grounds/confirmed-service-clause.ts
 * CI:   .github/workflows/ci.yml (S293 #6).
 */
import { LETTER_TEMPLATES } from "../../../../src/lib/disputes/templates";
import type { ParsedBill } from "../../../../src/lib/billing/types";
import type {
  DisputeEvidence,
  LineItemEvidence,
  PlanBenefitDetail,
} from "../../../../src/lib/disputes/evidence-resolver";

let pass = 0;
const fails: string[] = [];
function check(name: string, cond: boolean, got?: unknown) {
  if (cond) pass++;
  else fails.push(`✗ ${name}${got !== undefined ? `  ${String(got).slice(0, 200)}` : ""}`);
}

// ── the four real lines (billed amounts + codes from claim 146b1b9f) ─────────
// Benefit shapes are EXACTLY what the fixed resolver emits:
//  - pcp_visit: Tier-1 canonical gap-fill (loadCoverageFromCanonical) — real
//    citation string, community-verified framing, sourcedFrom canonical_archive.
//  - the other three: user-confirmed adoption (buildSecondaryPlanBenefit /
//    buildExactMatchPlanBenefit) — citation "" (no doc excerpt), confidence 0.6.
function benefit(over: Partial<PlanBenefitDetail>): PlanBenefitDetail {
  return {
    covered: true,
    copay: 0,
    coinsurance: null,
    source: "canonical",
    confidence: 0.6,
    citation: "",
    sbcExcerpt: null,
    sbcPage: null,
    sbcExcerptVerified: false,
    citationSource: null,
    sourcedFrom: "user_exact",
    sourcedFromYear: 2026,
    coverageDecision: undefined,
    ...over,
  } as PlanBenefitDetail;
}

function line(over: Partial<LineItemEvidence>): LineItemEvidence {
  return {
    lineItemId: "li-x",
    billingCode: null,
    serviceSlug: null,
    serviceName: "Service",
    billedAmount: 0,
    insurancePaid: null, // itemized bill — the whole point: NULL EOB fields
    patientOwes: null,
    patientPaid: null,
    allowedAmount: null,
    networkStatus: null,
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
    citeGradeTier: "statute",
    dollarAtStake: 0,
    serviceNotRenderedAttested: false,
    ...over,
  } as LineItemEvidence;
}

const pcpVisit = line({
  lineItemId: "li-1",
  billingCode: { value: "99214", type: "CPT" },
  serviceSlug: "pcp_visit",
  serviceName: "OFFICE/OUTPATIENT VISIT EST",
  billedAmount: 428,
  planBenefit: benefit({
    copay: 10,
    source: "canonical",
    citation: "Summary of Benefits and Coverage — Primary care visit",
    sourcedFrom: "canonical_archive",
  }),
  expectedPatientCost: 10,
});
const annualPhysical = line({
  lineItemId: "li-2",
  billingCode: { value: "99395", type: "CPT" },
  serviceSlug: "annual_physical",
  serviceName: "PREV VISIT EST AGE 18-39",
  billedAmount: 390,
  planBenefit: benefit({ copay: 0 }), // confirmed borrow — citation ""
  expectedPatientCost: 0,
});
const vaccine = line({
  lineItemId: "li-3",
  billingCode: { value: "91320", type: "CPT" },
  serviceSlug: "immunizations",
  serviceName: "Sarscov2 Vacc 30Mcg/0.3Ml Tris-Sucrose Im Use",
  billedAmount: 347,
  planBenefit: benefit({ copay: 0 }),
  expectedPatientCost: 0,
});
const vaccineAdmin = line({
  lineItemId: "li-4",
  billingCode: { value: "90480", type: "CPT" },
  serviceSlug: "immunizations",
  serviceName: "Imm Admn Sarscov2 Vaccine Single Dose",
  billedAmount: 132,
  planBenefit: benefit({ copay: 0 }),
  expectedPatientCost: 0,
});
const CONFIRMED_LINES = [pcpVisit, annualPhysical, vaccine, vaccineAdmin];

function evidenceWith(lines: LineItemEvidence[]): DisputeEvidence {
  return {
    compositionScope: null,
    claims: [
      {
        claimId: "claim-146b1b9f",
        dateOfService: "2025-06-23",
        providerName: "SWEDISH PRIMARY CARE SAND POINT",
        totalBilled: 1297,
        planYear: 2026,
        lineItemEvidence: lines,
        effectiveTotals: {
          patientPaid: 146.21,
          insurancePaid: 511.5,
          insuranceAdjusted: 639.29,
          patientResponsibility: 146.21,
          provenance: {
            patientPaidSource: "claim_header",
            insurancePaidSource: "claim_header",
            insuranceAdjustedSource: "claim_header",
            patientResponsibilitySource: "claim_header",
          },
        },
        dataTrust: { headerReconciliationFailed: false, signViolation: false },
      },
    ],
    totals: { claimCount: 1, lineItemCount: lines.length, totalBilled: 1297, totalDiscrepancy: 0 },
    planEvidence: null,
    networkEvidence: null,
    communityEvidence: null,
    legalBasis: [],
    gaps: [],
    dataTrust: { headerReconciliationFailed: false, signViolation: false },
  } as DisputeEvidence;
}

const bill: ParsedBill = {
  id: "b",
  documentId: "b",
  userId: "b",
  billType: "itemized_bill",
  provider: { name: "SWEDISH PRIMARY CARE SAND POINT" },
  patient: { name: "Nicole Marie Gurtler", memberId: "2888783" },
  serviceDate: "2025-06-23",
  lineItems: [],
  totals: { totalBilled: 1297 },
  rawText: "",
  confidence: 1,
  parseErrors: [],
} as ParsedBill;

const COMMON = {
  patientName: "Nicole Marie Gurtler",
  providerName: "SWEDISH PRIMARY CARE SAND POINT",
  serviceDate: "2025-06-23",
  findings: [],
  planContext: null,
  bill,
  gateUnverified: true, // the PROD path — trust gates active
  disputeGroundsOn: false,
};

// insurance_appeal titles the section per design generation (templates.ts):
// v3 ON → "Supporting detail" (uppercased at render), OFF → the legacy
// "Why this service should be covered". The invariant is title-agnostic —
// a confirmed service must produce its clause under WHICHEVER header renders.
function sectionOf(body: string, title: string): string | null {
  const h = body.indexOf(title);
  if (h < 0) return null;
  const r = body.indexOf("RELIEF REQUESTED");
  return r > h ? body.slice(h, r) : body.slice(h);
}

for (const v3DesignOn of [false, true]) {
  const tag = v3DesignOn ? "[v3 ON]" : "[v3 OFF]";
  const TITLE = v3DesignOn ? "SUPPORTING DETAIL" : "WHY THIS SERVICE SHOULD BE COVERED";

  // (a) every confirmed-known line renders its clause.
  const bodyAll = LETTER_TEMPLATES.insurance_appeal.body({
    ...COMMON,
    v3DesignOn,
    evidence: evidenceWith(CONFIRMED_LINES),
  });
  const section = sectionOf(bodyAll, TITLE);
  check(`${tag} evidence section (${TITLE}) present`, section !== null);
  if (section) {
    for (const li of CONFIRMED_LINES) {
      check(
        `${tag} clause for ${li.serviceSlug} (${li.serviceName.slice(0, 24)}…)`,
        section.includes(li.serviceName),
        section.slice(0, 400),
      );
    }
    // Numbered 1..4 — one clause per confirmed line, none swallowed.
    for (let n = 1; n <= 4; n++) {
      check(`${tag} clause #${n} numbered`, new RegExp(`^${n}\\. `, "m").test(section));
    }
    check(
      `${tag} canonical copay cited ($10.00 copay)`,
      section.includes("$10.00 copay"),
      section,
    );
    // Case-2: no verbatim quote for unverified excerpts.
    check(`${tag} no verbatim quote (Case 2)`, !section.includes("Plan language:"));
  }
  // (b) empty citation NEVER dangles — no "Source: ." fragment anywhere.
  check(`${tag} no dangling "Source: ." fragment`, !/Source:\s*\.\s*$/m.test(bodyAll) && !bodyAll.includes("Source: ."));

  // (c) a rejected line (benefit stripped) drops ITS clause; others survive.
  const rejected = { ...vaccine, planBenefit: null, expectedPatientCost: null };
  const bodyRej = LETTER_TEMPLATES.insurance_appeal.body({
    ...COMMON,
    v3DesignOn,
    evidence: evidenceWith([pcpVisit, annualPhysical, rejected, vaccineAdmin]),
  });
  const secRej = sectionOf(bodyRej, TITLE);
  check(`${tag} rejected line: section survives`, secRej !== null);
  if (secRej) {
    check(`${tag} rejected line: its clause dropped`, !secRej.includes(rejected.serviceName));
    check(`${tag} rejected line: others keep clauses`, secRej.includes(pcpVisit.serviceName) && secRej.includes(vaccineAdmin.serviceName));
  }

  // (d) compose-time counterfactual — nothing confirmed, no benefits → header
  // absent entirely (the S292 bare-header rule holds on this 4-line shape).
  const bodyNone = LETTER_TEMPLATES.insurance_appeal.body({
    ...COMMON,
    v3DesignOn,
    evidence: evidenceWith(
      CONFIRMED_LINES.map((l) => ({ ...l, planBenefit: null, expectedPatientCost: null })),
    ),
  });
  check(`${tag} unconfirmed counterfactual: no header`, !bodyNone.includes(TITLE));
}

console.log(`\nconfirmed-service-clause (S293 #6): ${pass} passed, ${fails.length} failed`);
if (fails.length) {
  console.log(fails.join("\n"));
  process.exit(1);
}
console.log("ALL GREEN ✓");
