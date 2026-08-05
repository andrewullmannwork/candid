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
import { applySingleLineHeaderIdentity } from "../../../../src/lib/billing/header-identity";

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

// ── S304 · ABSENT is not a disagreement ────────────────────────────────────
// A provider itemised receipt states its adjustments ONCE, in the summary block.
// The lines carry no value at all — which sums to 0, exactly like lines that say
// zero. Treating those as the same thing asked users to settle a conflict that
// did not exist on 14 of 17 DEV claims, and answering "the line items" returned
// $0.00 for money the bill plainly states.
{
  const ABSENT_LINES = [
    { billed_amount: 221, patient_owes: null, insurance_adjusted_amount: null },
  ];
  const ABSENT_CLAIM = {
    total_billed: 221,
    total_patient_responsibility: 163.27,
    total_insurance_adjusted: 57.73,
  };
  const absent = resolveEffectiveClaimTotals({
    claim: ABSENT_CLAIM,
    lineItems: ABSENT_LINES,
    userTotalsSource: null,
  });

  check("absent · the header still wins the total", absent.patientResponsibility === 163.27, absent.patientResponsibility);
  check("absent · present=false — no line carried a value", absent.perLine?.patientResponsibility.present === false);
  check(
    "absent · NOT a contradiction — this is the question that should never have fired",
    absent.perLine?.patientResponsibility.contradictsHeader === false,
  );
  check(
    "absent · a real conflict IS still a contradiction",
    resolveEffectiveClaimTotals({
      claim: CLAIM,
      lineItems: LINES,
      userTotalsSource: null,
    }).perLine?.patientPaid.contradictsHeader === true,
  );
  // The footgun: honoring "the line items are right" when there are none.
  const absentChoseLines = resolveEffectiveClaimTotals({
    claim: ABSENT_CLAIM,
    lineItems: ABSENT_LINES,
    userTotalsSource: "line_items",
  });
  check(
    "absent · 'the line items are right' is REFUSED when there are none — never report $0.00",
    absentChoseLines.patientResponsibility === 163.27 &&
      absentChoseLines.provenance.patientResponsibilitySource !== "user_line_items",
    absentChoseLines.provenance.patientResponsibilitySource,
  );

  // The producer's guarantee, tested rather than commented (perLine is optional
  // on the type so dispute-pipeline fixtures need not hand-build it).
  check(
    "perLine · ALWAYS populated by the resolver, all four fields",
    !!absent.perLine?.patientPaid &&
      !!absent.perLine?.insurancePaid &&
      !!absent.perLine?.insuranceAdjusted &&
      !!absent.perLine?.patientResponsibility,
  );
}

// ── S304 · agreement outranks a stored answer ──────────────────────────────
// The user's answer used to be consulted BEFORE checking whether the two still
// disagreed, so an answer given once suppressed cite-grade for good — even after
// a re-parse (or the single-line header identity) made them agree. A choice
// between two identical numbers is not a choice.
{
  const AGREE_LINES = [{ billed_amount: 100, patient_paid_amount: 130, patient_owes: 130 }];
  const AGREE_CLAIM = { total_billed: 100, total_patient_paid: 130, total_patient_responsibility: 130 };
  const stillAnswered = resolveEffectiveClaimTotals({
    claim: AGREE_CLAIM,
    lineItems: AGREE_LINES,
    userTotalsSource: "summary",
  });
  check(
    "agreement · a stale 'summary' answer no longer suppresses cite-grade",
    stillAnswered.provenance.patientPaidSource === "per_line_sum" &&
      isPerLineCiteGrade(stillAnswered.provenance.patientPaidSource),
    stillAnswered.provenance.patientPaidSource,
  );
  check("agreement · same number either way", stillAnswered.patientPaid === 130, stillAnswered.patientPaid);
  check(
    "agreement · nothing to ask about",
    stillAnswered.perLine?.patientPaid.contradictsHeader === false,
  );
  // And a genuine disagreement still honours the answer.
  check(
    "disagreement · the answer still wins",
    eff("summary").provenance.patientPaidSource === "user_summary",
  );
}

// ── S304 · the single-line header identity ─────────────────────────────────
// One line means the header total IS that line's value — nothing to allocate it
// across. Applied at the parser's exit, so every consumer sees it.
{
  const oneLine = {
    serviceDate: "2023-04-25",
    lineItems: [{ lineNumber: 1, procedureCode: "99213", description: "OFFICE VISIT", category: "", serviceDate: "2023-04-25", quantity: 1, billedAmount: 221 }],
    totals: { totalBilled: 221, totalPatientResponsibility: 163.27, totalInsAdjusted: 57.73, totalInsurancePaid: 0 },
    rawText: "",
    confidence: 0.85,
    parseErrors: [],
  } as unknown as Parameters<typeof applySingleLineHeaderIdentity>[0];
  const res = applySingleLineHeaderIdentity(oneLine);
  const line = oneLine.lineItems[0];
  check("identity · filled from the bill's own summary", res.filled.length === 3, res.filled);
  check("identity · patient responsibility", line.patientResponsibility === 163.27, line.patientResponsibility);
  check("identity · insurer adjustment", line.ins_adjusted === 57.73, line.ins_adjusted);
  check("identity · an explicit $0.00 is still a value", line.insurancePaid === 0, line.insurancePaid);
  check("identity · billed is NOT filled — it is the reconciliation's own check", line.billedAmount === 221);

  // Two lines: the figures genuinely are not stated per line, so nothing is
  // invented. Built from fresh literals — `oneLine` has been mutated in place by
  // the call above, and spreading it would carry the filled values in.
  const freshLine = (n: number, billed: number) => ({
    lineNumber: n,
    procedureCode: "99213",
    description: "OFFICE VISIT",
    category: "",
    serviceDate: "2023-04-25",
    quantity: 1,
    billedAmount: billed,
  });
  const twoLine = {
    serviceDate: "2023-04-25",
    lineItems: [freshLine(1, 221), freshLine(2, 42)],
    totals: { totalBilled: 263, totalPatientResponsibility: 163.27, totalInsAdjusted: 57.73, totalInsurancePaid: 0 },
    rawText: "",
    confidence: 0.85,
    parseErrors: [],
  } as unknown as typeof oneLine;
  const twoRes = applySingleLineHeaderIdentity(twoLine);
  check("identity · multi-line bills untouched — no imputation", twoRes.filled.length === 0, twoRes.filled);
  check("identity · multi-line lines stay absent", twoLine.lineItems[0].patientResponsibility == null);

  // Never overwrite what the bill actually printed on the line.
  const observed = {
    serviceDate: "2023-04-25",
    lineItems: [{ ...freshLine(1, 221), patientResponsibility: 99 }],
    totals: { totalBilled: 221, totalPatientResponsibility: 163.27 },
    rawText: "",
    confidence: 0.85,
    parseErrors: [],
  } as unknown as typeof oneLine;
  applySingleLineHeaderIdentity(observed);
  check(
    "identity · an observed line value is never overwritten — a real conflict stays visible",
    observed.lineItems[0].patientResponsibility === 99,
    observed.lineItems[0].patientResponsibility,
  );
}

console.log(`\ntotals-source fixture: ${pass} passed, ${fails.length} failed`);
if (fails.length) {
  console.log(fails.join("\n"));
  console.log("FAILED ✗");
  process.exit(1);
}
console.log("ALL GREEN ✓");
