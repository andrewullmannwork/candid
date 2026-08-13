/**
 * plan-year-authority.ts — S313 CI fixture.
 *
 * Pins the rule: a plan document is authority only for care delivered in its
 * OWN plan year. Live defect it locks (PROD claim 046f64cd): a 2024 date of
 * service pinned to the member's 2026 plan produced a letter quoting the 2026
 * Summary of Benefits VERBATIM as the authority for 2024 care.
 *
 * The three cases that matter, and why the third is not optional:
 *   1. OFF                       → byte-identical: year-stamped cite + verbatim quote
 *   2. ON, source year ≠ care    → assert-without-citing + B' note, no quote, no Source
 *   3. ON, source year = care    → cite INTACT even though the pinned plan is
 *                                  wrong-year. The check compares the CITATION's
 *                                  year, not the pinned plan's, so a successful
 *                                  bill-year canonical archive lookup stays a
 *                                  valid cite. Without this case a future
 *                                  "simplification" to gate on the pinned plan
 *                                  would pass every other assertion here — and
 *                                  that is exactly the hole this rule already
 *                                  had once (manual Tier-2 canonical bind).
 *
 * Run: npx tsx scripts/calibration/fixtures/dispute-grounds/plan-year-authority.ts
 */
import { LETTER_TEMPLATES } from "../../../../src/lib/disputes/templates";
import type { DisputeEvidence } from "../../../../src/lib/disputes/evidence-resolver";
import type { PlanContext } from "../../../../src/lib/disputes/plan-context";
import type { ParsedBill } from "../../../../src/lib/billing/types";

let failures = 0;
function check(label: string, cond: boolean, got?: string) {
  if (cond) {
    console.log(`  ✓ ${label}`);
  } else {
    console.error(`  ✗ ${label}`);
    if (got) console.error(`      body was:\n${got.split("\n").slice(0, 24).join("\n")}`);
    failures++;
  }
}

const EXCERPT = "Primary care visit to treat an injury or illness No charge";

const bill = {
  serviceDate: "2024-07-01",
  provider: { name: "SWEDISH PRIMARY CARE SAND POINT", address: "1 Care St\nSeattle, WA 98115" },
  patient: { name: "Test Patient", memberId: "MBR1" },
  insurer: { name: "Blue Cross Blue Shield of Michigan", planName: "Bronze Secure" },
  lineItems: [],
  totalBilled: 372,
} as unknown as ParsedBill;

function evidenceWith(sourcedFromYear: number): DisputeEvidence {
  return {
    claims: [
      {
        claimId: "c1",
        providerName: "SWEDISH PRIMARY CARE SAND POINT",
        dateOfService: "2024-07-01",
        effectiveTotals: { patientResponsibility: 264.68, patientPaid: 264.68 },
        lineItemEvidence: [
          {
            lineItemId: "li-1",
            billingCode: { value: "99214", type: "CPT" },
            serviceSlug: "office_visit",
            serviceName: "OFFICE/OUTPATIENT VISIT EST",
            billedAmount: 330,
            insurancePaid: null,
            patientOwes: 234.8,
            patientPaid: null,
            expectedPatientCost: 0,
            actualPatientCost: 234.8,
            discrepancyAmount: 234.8,
            discrepancyReason: null,
            communityOutcome: null,
            siblingCodes: null,
            pricingBenchmark: null,
            auditFindings: [],
            auditRan: true,
            peerCodes: null,
            planBenefit: {
              covered: true,
              copay: 0,
              coinsurance: null,
              source: "canonical_archive",
              sourcedFrom: "canonical_archive",
              sourcedFromYear,
              confidence: 1,
              citation: "Summary of Benefits and Coverage — Primary Care Visit",
              sbcExcerpt: EXCERPT,
              sbcPage: 1,
              sbcExcerptVerified: true,
              citationSource: "canonical_fallback",
            },
          },
        ],
      },
    ],
  } as unknown as DisputeEvidence;
}

function render(serviceYear: number | null, sourcedFromYear: number): string {
  return LETTER_TEMPLATES["insurance_appeal"].body({
    patientName: "Test Patient",
    providerName: "SWEDISH PRIMARY CARE SAND POINT",
    serviceDate: "2024-07-01",
    findings: [],
    bill,
    planContext: {
      plan: { id: "p1", planName: "Bronze Secure", planYear: 2026, insurerName: "Blue Cross Blue Shield of Michigan", planType: null, canonicalPlanId: "cp1" },
      insurer: { name: "Blue Cross Blue Shield of Michigan" },
      serviceYear,
      missingForYear: serviceYear,
      planSource: null,
    } as unknown as PlanContext,
    evidence: evidenceWith(sourcedFromYear),
    gateUnverified: false,
    v3DesignOn: true,
  } as never);
}

const NOTE = "plan documents are not on file";
const YEAR_STAMPED = "2026 Summary of Benefits and Coverage";
const SOURCE_SUFFIX = "Source: Summary of Benefits and Coverage";
const QUOTE = `Plan language: "`;

// ── 1. Flag OFF → byte-identical, today's behaviour ──────────────────────────
console.log("flag OFF (serviceYear null):");
const off = render(null, 2026);
check("cites the year-stamped booklet", off.includes(YEAR_STAMPED), off);
check("renders the verbatim quote", off.includes(QUOTE), off);
check("no year-gap note", !off.includes(NOTE), off);

// ── 2. ON + wrong-year citation → assert, do not cite ────────────────────────
console.log("\nflag ON, care 2024, citation sourced 2026:");
const on = render(2024, 2026);
check("the year-stamped booklet is GONE", !on.includes(YEAR_STAMPED), on);
check("the Source: suffix is GONE", !on.includes(SOURCE_SUFFIX), on);
check("the verbatim quote is GONE", !on.includes(QUOTE), on);
check("still ASSERTS the plan's benefit", on.includes("Per my plan's benefits for this service"), on);
check("the year-gap note renders", on.includes(NOTE), on);
check("the note names the CARE year (2024)", on.includes("My 2024 plan documents"), on);
check("the note renders exactly ONCE", on.split(NOTE).length - 1 === 1, on);
check("the discrepancy math is untouched", on.includes("234.80"), on);

// ── 3. ON + right-year citation → cite stays intact (the archive-success case)
console.log("\nflag ON, care 2024, citation sourced 2024 (archive hit):");
const okYear = render(2024, 2024);
check("the cite SURVIVES (compares the citation's year, not the pinned plan's)",
  okYear.includes("2024 Summary of Benefits and Coverage"), okYear);
check("the verbatim quote survives", okYear.includes(QUOTE), okYear);
check("NO year-gap note (nothing to disclose)", !okYear.includes(NOTE), okYear);

if (failures > 0) {
  console.error(`\n✗ plan-year-authority FAILED — ${failures} check(s).`);
  process.exit(1);
}
console.log("\n✓ plan-year-authority PASSED (14 checks).");
