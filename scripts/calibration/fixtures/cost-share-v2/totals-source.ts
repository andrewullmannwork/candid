/**
 * totals-source — the S302 line-items-vs-summary adjudication.
 *
 * A bill is internally consistent on paper, so when our line-item parse and our
 * header parse disagree, one of OURS is wrong. This fixture locks:
 *   - the DEFAULT rule is untouched when the user has not answered
 *   - the user's answer OUTRANKS it, in both directions
 *   - choosing "the line items" makes raw per-line values CITE-GRADE — without
 *     that, the per-line resolvers keep prorating and the choice does nothing
 *     visible, which is the subtle way this feature could ship dead
 *   - the answer is a CHOICE between two already-parsed numbers: neither branch
 *     invents a value
 *   - the request/parse union accepts it and rejects nonsense
 *
 * Run: npx tsx scripts/calibration/fixtures/cost-share-v2/totals-source.ts
 */
import {
  resolveEffectiveClaimTotals,
  resolvePerLinePatientPaid,
  readUserTotalsSource,
  isPerLineCiteGrade,
} from "../../../../src/lib/claims/effective-totals";
import { parseCostShareOverride } from "../../../../src/lib/claims/cost-share-override";

let pass = 0;
const fails: string[] = [];
function check(name: string, cond: boolean, got?: unknown) {
  if (cond) pass++;
  else fails.push(`✗ ${name}${got !== undefined ? `  (got: ${JSON.stringify(got)})` : ""}`);
}

// Lines sum to 100; the bill's own summary says 130. One of our parses is wrong.
const LINES = [
  { billed_amount: 60, patient_paid_amount: 60, patient_owes: 60 },
  { billed_amount: 40, patient_paid_amount: 40, patient_owes: 40 },
];
const CLAIM = { total_billed: 100, total_patient_paid: 130, total_patient_responsibility: 130 };
const eff = (use: "summary" | "line_items" | null) =>
  resolveEffectiveClaimTotals({ claim: CLAIM, lineItems: LINES, userTotalsSource: use });

// ── Default rule, unchanged ────────────────────────────────────────────────
{
  const d = eff(null);
  check("default · header wins when the two disagree", d.patientPaid === 130, d.patientPaid);
  check("default · provenance says claim_header", d.provenance.patientPaidSource === "claim_header");
}

// ── The user's answer outranks it ──────────────────────────────────────────
{
  const lines = eff("line_items");
  check("answer · line items chosen → the per-line sum", lines.patientPaid === 100, lines.patientPaid);
  check("answer · provenance records WHO decided", lines.provenance.patientPaidSource === "user_line_items");

  const summary = eff("summary");
  check("answer · summary chosen → the header", summary.patientPaid === 130, summary.patientPaid);
  check("answer · provenance records WHO decided", summary.provenance.patientPaidSource === "user_summary");

  // Neither branch invents a number — both are values already on the claim.
  check(
    "answer · both outcomes are already-parsed numbers, never a new one",
    [100, 130].includes(lines.patientPaid) && [100, 130].includes(summary.patientPaid),
  );
  // And the answer applies to every disagreeing total, not just the one asked.
  check(
    "answer · applies to every disagreeing total on the bill",
    lines.provenance.patientResponsibilitySource === "user_line_items" &&
      summary.provenance.patientResponsibilitySource === "user_summary",
  );
}

// ── The subtle one: cite-grade must follow the answer ──────────────────────
{
  check("cite-grade · per_line_sum is citable", isPerLineCiteGrade("per_line_sum"));
  check("cite-grade · user_line_items is citable — the user SAID the lines are right", isPerLineCiteGrade("user_line_items"));
  check("cite-grade · claim_header is NOT citable per line", !isPerLineCiteGrade("claim_header"));
  check("cite-grade · user_summary is NOT citable per line", !isPerLineCiteGrade("user_summary"));

  const chosenLines = resolvePerLinePatientPaid({
    lineBilled: 60,
    linePatientPaid: 60,
    claimTotalBilled: 100,
    effectiveClaimPatientPaid: eff("line_items"),
  });
  check(
    "cite-grade · choosing the line items uses the RAW line value, not a proration",
    chosenLines.value === 60 && chosenLines.source === "per_line",
    chosenLines,
  );
  const chosenSummary = resolvePerLinePatientPaid({
    lineBilled: 60,
    linePatientPaid: 60,
    claimTotalBilled: 100,
    effectiveClaimPatientPaid: eff("summary"),
  });
  check(
    "cite-grade · choosing the summary prorates the confirmed total instead",
    chosenSummary.source === "header_prorated" && chosenSummary.value === 78,
    chosenSummary,
  );
}

// ── The durable answer ─────────────────────────────────────────────────────
{
  check("read · absent metadata → no answer", readUserTotalsSource(null) === null);
  check("read · junk → no answer", readUserTotalsSource({ userTotalsSource: "banana" }) === null);
  check("read · summary", readUserTotalsSource({ userTotalsSource: "summary" }) === "summary");
  check("read · line_items", readUserTotalsSource({ userTotalsSource: "line_items" }) === "line_items");
}

// ── The wire contract ──────────────────────────────────────────────────────
{
  const ok = parseCostShareOverride({ field: "totals_source", use: "line_items" });
  check("parse · accepts line_items", ok.ok && ok.value.field === "totals_source");
  const clear = parseCostShareOverride({ field: "totals_source", use: null });
  check("parse · null CLEARS the answer", clear.ok && clear.value.field === "totals_source" && clear.value.use === null);
  const bad = parseCostShareOverride({ field: "totals_source", use: "charges" });
  check("parse · rejects an unknown source", !bad.ok, bad);
  const missing = parseCostShareOverride({ field: "totals_source" });
  check("parse · rejects a missing source", !missing.ok);
}

console.log(`\ntotals-source fixture: ${pass} passed, ${fails.length} failed`);
if (fails.length) {
  console.log(fails.join("\n"));
  console.log("FAILED ✗");
  process.exit(1);
}
console.log("ALL GREEN ✓");
