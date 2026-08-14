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

function evidenceWith(sourcedFromYear: number | null, sourcedFrom: "canonical_archive" | "user_exact" | "user_fallback" = "canonical_archive"): DisputeEvidence {
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
              source: sourcedFrom,
              sourcedFrom,
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

function render(serviceYear: number | null, sourcedFromYear: number | null, sourcedFrom: "canonical_archive" | "user_exact" | "user_fallback" = "canonical_archive"): string {
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
    evidence: evidenceWith(sourcedFromYear, sourcedFrom),
    gateUnverified: false,
    v3DesignOn: true,
  } as never);
}

const NOTE = "plan documents are not on file";
/** Only the per-line evidence bullets — the header and body legitimately name
 *  the pinned plan's year in the S111 proxy framing, which is a DIFFERENT
 *  question from what the citation may claim as authority. */
const bulletsOf = (body: string) =>
  body.split("\n").filter((l) => l.trimStart().startsWith("- ")).join("\n");
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

// ── 4. EVERY sourcedFrom case obeys the rule ────────────────────────────────
// Each of the three builds its own year-stamped prefix in its own words, so a
// fix applied to one of them looks complete and is not. Andrew's letter paste
// found user_exact still reading "<plan>, 2026 specifies …" for 2023 care after
// canonical_archive had been fixed.
console.log("\nflag ON, care 2024, every sourcedFrom case:");
for (const src of ["canonical_archive", "user_exact", "user_fallback"] as const) {
  const body = render(2024, 2026, src);
  check(`${src}: no 2026 stamp in the BULLETS`, !bulletsOf(body).includes("2026"), body);
  check(`${src}: asserts without citing`, body.includes("Per my plan's benefits for this service"), body);
  check(`${src}: the year-gap note renders`, body.includes(NOTE), body);
}

// ── 5. NULL sourcedFromYear on user_exact — the case that shipped TWICE ──────
// user_exact does not print sourcedFromYear at all; it prints the PINNED plan's
// year. So a benefit carrying no source year still stamped "<plan>, 2026
// specifies …" over 2023 care while a check keyed only on sourcedFromYear sat
// false. Andrew pasted that letter twice before this case existed.
console.log("\nflag ON, care 2024, user_exact with NO sourcedFromYear (pinned plan is 2026):");
const nullYear = render(2024, null, "user_exact");
check("no 2026 stamp from the PINNED plan", !nullYear.includes("2026 specifies"), nullYear);
check("asserts without citing", nullYear.includes("Per my plan's benefits for this service"), nullYear);
check("the year-gap note still renders", nullYear.includes(NOTE), nullYear);

// ── 6. The PLAN LABEL — S111's proxy framing, which never once fired ────────
// Both the Re: header and the body derived the bill year as
// `plan.planYear ?? missingForYear` — the same value the label prints — so the
// proxy test compared the plan against itself and was permanently false
// whenever a plan was pinned. Two byte-identical copies of that derivation, so
// fixing one would have left the other lying.
console.log("\nflag ON, care 2024, pinned plan 2026 — the plan label:");
const lbl = render(2024, 2026, "user_exact");
check("header uses the PROXY framing", lbl.includes("Current plan (cited as proxy):"), lbl);
check('header no longer says plain "Plan: …, plan year 2026"', !lbl.includes("\nPlan: "), lbl);
check("the false 'This claim was processed under' sentence is GONE",
  !lbl.includes("This claim was processed under"), lbl);
check("body says it is citing CURRENT coverage as evidence",
  lbl.includes("as evidence of present coverage under this insurer"), lbl);
check("and points at the date-of-service plan as the subject",
  lbl.includes("the plan in effect on the date of service is the subject"), lbl);

// The LABEL and the CITATION answer different questions, and can legitimately
// disagree. Here the bill-year archive supplied a correct 2024 cite while the
// PINNED plan is still 2026 — so the bullet keeps its citation AND the header
// still says "proxy", because "Plan: … 2026" on 2024 care is misleading no
// matter where the coverage terms came from. Pinned so a later "simplification"
// cannot collapse the two into one test.
const lblOk = render(2024, 2024, "canonical_archive");
check("right-year cite SURVIVES in the bullet",
  bulletsOf(lblOk).includes("2024 Summary of Benefits and Coverage"), lblOk);
check("but the header still flags the 2026 PINNED plan as a proxy",
  lblOk.includes("Current plan (cited as proxy):"), lblOk);
check("no year-gap note (the citation itself is the right year)", !lblOk.includes(NOTE), lblOk);

// ── 7. The letter must ASK for what its opening promises ────────────────────
// The proxy intro says "the plan in effect on the date of service is the
// subject of the request below". Until S313 the request below never asked for
// it — an insurer could answer both existing items as written and never produce
// the governing year.
console.log("\nflag ON, care 2024, pinned plan 2026 — the relief section:");
const ask = render(2024, 2026, "user_exact");
check("asks the insurer to produce the DATE-OF-SERVICE year's plan documents",
  ask.includes("Produce my plan documents for 2024"), ask);
check("names SPD / Evidence of Coverage",
  ask.includes("Summary Plan Description or Evidence of Coverage in effect on the date of service"), ask);
check("puts the difference on the insurer",
  ask.includes("please identify the difference"), ask);
// The ask keys on the LABEL being a proxy — i.e. we do not hold the member's
// own year-correct plan document — which stays true even when the bill-year
// archive supplied correct TERMS. So the right-year-citation letter still
// carries it; the true control is a letter with NO year gap at all.
check("right-year CITATION still asks (we still lack the member's 2024 document)",
  render(2024, 2024, "canonical_archive").includes("Produce my plan documents for 2024"), lblOk);
const noGap = render(2026, 2026, "user_exact"); // care 2026, pinned plan 2026
check("NO-GAP letter does not ask for plan documents",
  !noGap.includes("Produce my plan documents for"), noGap);
check("NO-GAP letter keeps the plain 'Plan:' framing",
  !noGap.includes("Current plan (cited as proxy):"), noGap);
check("NO-GAP letter has no year-gap note", !noGap.includes(NOTE), noGap);

if (failures > 0) {
  console.error(`\n✗ plan-year-authority FAILED — ${failures} check(s).`);
  process.exit(1);
}
console.log("\n✓ plan-year-authority PASSED (14 checks).");
