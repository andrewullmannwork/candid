/**
 * conspicuous-statement — S326 eleven-rules Rule 4 (§81.101(c), unflagged).
 *
 * Proves EVERY composed letter carries the verbatim Tex. Gov't Code §81.101(c)
 * conspicuous statement exactly ONCE — across every letter type through the
 * real composer, the itemized request, the follow-up letters, and the helper's
 * idempotency (double-application still yields exactly one).
 *
 * Also the ORIGINAL-CREDITOR fix (review doc §3.1, unflagged): a
 * debt_validation letter whose collector IS the bill's provider composes NO
 * §1692g validation demand and drops the "as required by the FDCPA" clause;
 * a third-party collector keeps both (the denominator).
 *
 * Run: npx tsx scripts/calibration/fixtures/legal/conspicuous-statement.ts
 */
import {
  CONSPICUOUS_STATEMENT,
  withConspicuousStatement,
} from "../../../../src/lib/disputes/letter-type";
import { generateItemizedBillRequest } from "../../../../src/lib/disputes";
import { buildFollowupLetter } from "../../../../src/lib/disputes/followup-letter";
import type { DisputeLetterType } from "../../../../src/lib/billing/types";
import { mkFinding, mkLine, mkEvidence, composeLetter } from "./_compose-harness";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean) {
  if (cond) pass++;
  else {
    fail++;
    console.error(`  ✗ ${name}`);
  }
}

function countStatement(body: string): number {
  return body.split(CONSPICUOUS_STATEMENT).length - 1;
}

const CASES: Array<{ type: DisputeLetterType; findingType: string }> = [
  { type: "insurance_appeal", findingType: "insurance_underpayment" },
  { type: "external_review", findingType: "insurance_underpayment" },
  { type: "overcharge", findingType: "overcharge" },
  { type: "duplicate_charge", findingType: "duplicate" },
  { type: "balance_billing", findingType: "balance_billing" },
  { type: "final_notice", findingType: "overcharge" },
  { type: "negotiation", findingType: "overcharge" },
  { type: "debt_validation", findingType: "overcharge" },
];

for (const c of CASES) {
  const findings = [mkFinding(c.findingType as never, 110)];
  const body = composeLetter(c.type, findings, mkEvidence([mkLine(findings)], null), {
    appealExhausted: { attested: true, denialDate: "2026-02-01" },
    collector: { name: "Apex Recovery LLC", address: "2 Collection Way" },
    debtWithinWindow: true,
  });
  check(`${c.type} carries the statement exactly once`, countStatement(body) === 1);
}

// itemized_request (its own composer)
{
  const body = generateItemizedBillRequest({
    patientName: "Pat Example",
    providerName: "Sample Medical Center",
    serviceDate: "2026-03-11",
  }).body;
  check("itemized_request carries the statement exactly once", countStatement(body) === 1);
}

// follow-up letters
{
  const body = buildFollowupLetter({
    recipientKind: "provider",
    parentLetterType: "overcharge",
    parentSentDate: "2026-03-11",
    deadlineType: null,
    governingDeadlineDate: null,
    isFinal: false,
  } as never);
  check("follow-up letter carries the statement exactly once", countStatement(body) === 1);
}

// idempotency — the lockstep guarantee across composer + rerender.
{
  const once = withConspicuousStatement("Dear sir,\n\nSincerely,\n\nPat");
  const twice = withConspicuousStatement(once);
  check("withConspicuousStatement is idempotent", countStatement(twice) === 1);
}

// ---------------------------------------------------------------------------
// The original-creditor §1692g fix (unflagged; safe both directions).
// ---------------------------------------------------------------------------
{
  const findings = [mkFinding("overcharge", 110)];
  const ev = mkEvidence([mkLine(findings)], null);
  const thirdParty = composeLetter("debt_validation", findings, ev, {
    collector: { name: "Apex Recovery LLC" },
    debtWithinWindow: true,
  });
  check("third-party collector: §1692g demand present (denominator)", thirdParty.includes("§1692g"));
  check("third-party collector: FDCPA disputed-marking clause present", thirdParty.includes("§1692e(8)"));

  const ownBill = composeLetter("debt_validation", findings, ev, {
    // the collector IS the bill's provider (name-matched)
    collector: { name: "Sample Medical Center" },
    debtWithinWindow: true,
  });
  check("original creditor: NO §1692g validation demand", !ownBill.includes("§1692g"));
  check("original creditor: no FDCPA-required clause", !ownBill.includes("§1692e(8)"));
  check("original creditor: still asks disputed-marking (plain)", ownBill.includes("mark this debt as disputed"));

  const statedOc = composeLetter("debt_validation", findings, ev, {
    collector: { name: "Valley Health Billing", originalCreditor: "Valley Health Billing" },
    debtWithinWindow: true,
  });
  check("collector == its own stated original creditor: NO §1692g demand", !statedOc.includes("§1692g"));
}

console.log(`\nconspicuous-statement: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log("FAILED ✗");
  process.exit(1);
}
console.log("ALL GREEN ✓");
