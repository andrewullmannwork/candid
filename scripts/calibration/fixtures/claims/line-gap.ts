/**
 * line-gap — S326: synthetic gap entries require REAL insurer adjudication.
 *
 * ⚠ DO NOT REVERT (Andrew ruling, S326): a line the insurer never adjudicated
 * gets NO synthetic "insurer under-paid" entry — the Riverside defect: a
 * self-pay bill with no EOB grew an insurer-appeal offer and fact prose
 * asserting an EOB that did not exist (the S304 absence-read-as-contradiction
 * class). Presence-based (S314): an explicit $0 is a statement; null is
 * absence, never zero.
 *
 * Run: npx tsx scripts/calibration/fixtures/claims/line-gap.ts
 */
import {
  lineGapFindingKind,
  insurerAdjudicationPresent,
  type LineGapLineSignals,
  type LineGapClaimSignals,
} from "../../../../src/lib/claims/line-gap";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean) {
  if (cond) pass++;
  else {
    fail++;
    console.error(`  ✗ ${name}`);
  }
}

const NO_HEADER: LineGapClaimSignals = {
  totalInsurancePaid: null,
  totalAllowed: null,
  totalInsuranceAdjusted: null,
};
const line = (over: Partial<LineGapLineSignals>): LineGapLineSignals => ({
  billedAmount: 395,
  allowedAmount: null,
  insurancePaid: null,
  insuranceAdjusted: null,
  patientOwes: null,
  coverageStatus: "covered",
  costShareVerdict: null,
  refundComponent: 0,
  forgivenessComponent: 0,
  hasPlanCoverage: true,
  ...over,
});

// 1 — THE RIVERSIDE CASE, BY NAME: engine says "recovery" (plan-vs-billed
// forgiveness) on a line with NO insurer adjudication anywhere → NO entry.
check(
  "unadjudicated engine-recovery line → NO synthetic entry (the Riverside defect; DO NOT REVERT)",
  lineGapFindingKind(line({ costShareVerdict: "recovery", forgivenessComponent: 450 }), NO_HEADER) === null,
);
check(
  "unadjudicated plan-coverage forgiveness (off-engine) → NO synthetic entry",
  lineGapFindingKind(line({ forgivenessComponent: 450 }), NO_HEADER) === null,
);

// 2 — real adjudication keeps the real stories.
check(
  "line-level insurer payment + engine recovery → 'recovery' entry",
  lineGapFindingKind(line({ insurancePaid: 20, costShareVerdict: "recovery" }), NO_HEADER) === "recovery",
);
check(
  "header-level adjudication (S304: stated once) + engine recovery → 'recovery'",
  lineGapFindingKind(line({ costShareVerdict: "recovery" }), { ...NO_HEADER, totalInsurancePaid: 120 }) === "recovery",
);
check(
  "explicit line zeros (a statement, not absence) → 'mystery'",
  lineGapFindingKind(line({ insurancePaid: 0, patientOwes: 0 }), NO_HEADER) === "mystery",
);
check(
  "null-null (absence) is NEVER 'mystery' — even with header adjudication",
  lineGapFindingKind(line({}), { ...NO_HEADER, totalAllowed: 300 }) === null,
);

// 3 — untouched behavior.
check("not_covered → null regardless", lineGapFindingKind(line({ coverageStatus: "not_covered", insurancePaid: 20, costShareVerdict: "recovery" }), NO_HEADER) === null);
check(
  "adjudicated line with no story → null",
  lineGapFindingKind(line({ insurancePaid: 300, costShareVerdict: "correct" }), NO_HEADER) === null,
);

// 4 — the presence predicate itself.
check("explicit 0 counts as presence", insurerAdjudicationPresent({ allowedAmount: null, insurancePaid: 0, insuranceAdjusted: null }, NO_HEADER) === true);
check("all-null everywhere = absent", insurerAdjudicationPresent({ allowedAmount: null, insurancePaid: null, insuranceAdjusted: null }, NO_HEADER) === false);

console.log(`\nline-gap: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log("FAILED ✗");
  process.exit(1);
}
console.log("ALL GREEN ✓");
