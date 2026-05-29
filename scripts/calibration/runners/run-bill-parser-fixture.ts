/**
 * PR4 (S142) Ship Gate G4 fixture runner.
 *
 * Validates sum-invariants verifier outputs against the expected verdicts in
 * scripts/calibration/fixtures/bill-parser/negative-column-eob.json (and any
 * other fixtures dropped in that dir). Does NOT call Haiku — this asserts
 * the persist-side verifier semantics for B-1 / B-2 / B-3 on synthetic
 * inputs. Live-corpus Haiku validation lives in the separate smoke loop
 * (`scripts/findings/pr4-smoke-2026-05-28.ts` — disposable, deleted pre-PR).
 *
 * Run: cd candid && npx tsx scripts/calibration/runners/run-bill-parser-fixture.ts
 */
import fs from "node:fs";
import path from "node:path";
import {
  detectSignViolations,
  verifyPerLineSums,
  verifyHeaderReconciliation,
  type VerifierTolerances,
} from "../../../src/lib/billing/sum-invariants.js";
import { computeVerdict } from "../../../src/lib/billing/bill-parser-decisions.js";
import type { ParsedBill, BillLineItem } from "../../../src/lib/billing/types.js";

const FIXTURE_DIR = path.join(__dirname, "../fixtures/bill-parser");

const TOLERANCES: VerifierTolerances = {
  perLineSumAbs: 0.01,
  perLineSumRel: 0.001,
  headerReconciliationAbs: 0.5,
  headerReconciliationRel: 0.005,
};

interface FixtureRow {
  fixture_id: string;
  block_id: string;
  block_name: string;
  input: { bill_type: "eob" | "itemized_bill"; ocr_text: string };
  expected_parser_output: {
    service_date: string;
    network_status?: string;
    provider?: { name?: string };
    lineItems: Array<Record<string, unknown>>;
    totals: Record<string, number>;
  };
  assertions: {
    sign_convention: { fields_must_be_positive_or_undefined: string[] };
    per_line_breakdown: { lines_with_populated_per_line: number };
    sum_equals_header: { checks: Array<{ field: string; line_sum: number; header: number; delta_max: number }> };
    persist_verdict: { expected: string };
  };
  negative_cases: Array<{
    name: string;
    input_overrides: Record<string, number | null>;
    expected_persist_verdict: string;
    expected_dropped_per_line_fields?: string[];
  }>;
}

function buildParsedBill(fixture: FixtureRow, overrides?: Record<string, number | null>): ParsedBill {
  const lineItems: BillLineItem[] = fixture.expected_parser_output.lineItems.map((raw, idx) => {
    const insAdjustedRaw = (raw.ins_adjusted as number | undefined) ?? undefined;
    const insurancePaidRaw = (raw.insurance_paid as number | undefined) ?? undefined;
    const patientPaidRaw = (raw.patient_paid as number | undefined) ?? undefined;
    const insAdjustedOverride = applyOverride(overrides, `lineItems[${idx}].ins_adjusted`, insAdjustedRaw);
    const insurancePaidOverride = applyOverride(overrides, `lineItems[${idx}].insurance_paid`, insurancePaidRaw);
    const patientPaidOverride = applyOverride(overrides, `lineItems[${idx}].patient_paid`, patientPaidRaw);
    return {
      lineNumber: idx + 1,
      line_number_in_eob: raw.line_number_in_eob as string | undefined,
      procedureCode: (raw.procedure_code as string | undefined) ?? "",
      description: (raw.description as string | undefined) ?? "fixture",
      category: "Medical Service",
      serviceDate: (raw.service_date as string | undefined) ?? fixture.expected_parser_output.service_date,
      quantity: 1,
      billedAmount: (raw.billed_amount as number | undefined) ?? 0,
      insurancePaid: insurancePaidOverride,
      ins_adjusted: insAdjustedOverride,
      patient_paid: patientPaidOverride,
      patientResponsibility: raw.patient_responsibility as number | undefined,
    };
  });
  const totals = fixture.expected_parser_output.totals;
  return {
    id: "fixture-" + fixture.fixture_id,
    documentId: "fixture-doc",
    userId: "fixture-user",
    billType: fixture.input.bill_type,
    provider: { name: fixture.expected_parser_output.provider?.name ?? "Fixture" },
    patient: { name: "Fixture" },
    serviceDate: fixture.expected_parser_output.service_date,
    lineItems,
    totals: {
      totalBilled: totals.total_billed,
      totalAllowed: totals.total_allowed,
      totalInsurancePaid: totals.total_insurance_paid,
      totalPatientResponsibility: totals.total_patient_responsibility,
      totalPatientPaid: totals.total_patient_paid,
      totalInsAdjusted: totals.total_ins_adjusted,
    },
    rawText: fixture.input.ocr_text,
    confidence: 0.85,
    parseErrors: [],
  };
}

function applyOverride(
  overrides: Record<string, number | null> | undefined,
  key: string,
  fallback: number | undefined,
): number | undefined {
  if (!overrides) return fallback;
  if (!(key in overrides)) return fallback;
  const v = overrides[key];
  if (v === null) return undefined;
  return v;
}

interface AssertionResult {
  name: string;
  passed: boolean;
  detail: string;
}

function runFixture(fixture: FixtureRow): AssertionResult[] {
  const results: AssertionResult[] = [];

  // Positive case (expected parser output → clean verdict).
  const bill = buildParsedBill(fixture);
  const signs = detectSignViolations(bill);
  const perLine = verifyPerLineSums(bill, TOLERANCES);
  const header = verifyHeaderReconciliation(bill, TOLERANCES);
  const verdict = computeVerdict(signs, perLine, header);

  results.push({
    name: "B-3 positive-magnitude case → no sign violations",
    passed: signs.length === 0,
    detail: signs.length === 0 ? "ok" : `signs fired: ${JSON.stringify(signs)}`,
  });

  for (const check of fixture.assertions.sum_equals_header.checks) {
    const verdictForField = perLine.find((v) => v.field === check.field || keyForField(v.field) === check.field);
    if (!verdictForField) continue;
    results.push({
      name: `B-1 sum-equals-header (${check.field})`,
      passed: verdictForField.withinTolerance,
      detail: `populated=${verdictForField.populated} lineSum=${verdictForField.lineSum} header=${verdictForField.header} delta=${verdictForField.delta} tol=${verdictForField.tolerance}`,
    });
  }

  // header reconciliation: fixture has no total_patient_paid → allHeaderTotalsPresent=false
  results.push({
    name: "B-2 header reconciliation skipped when totals incomplete",
    passed: !header.allHeaderTotalsPresent,
    detail: `allHeaderTotalsPresent=${header.allHeaderTotalsPresent} delta=${header.delta} tol=${header.tolerance}`,
  });

  results.push({
    name: "Positive case → verdict=" + fixture.assertions.persist_verdict.expected,
    passed: verdict.verdict === fixture.assertions.persist_verdict.expected || (fixture.assertions.persist_verdict.expected === "clean" && verdict.verdict === "clean"),
    detail: `actual=${verdict.verdict} categories=[${verdict.categories.join(",")}]`,
  });

  // Negative cases.
  for (const neg of fixture.negative_cases) {
    const billNeg = buildParsedBill(fixture, neg.input_overrides);
    const signsNeg = detectSignViolations(billNeg);
    const perLineNeg = verifyPerLineSums(billNeg, TOLERANCES);
    const headerNeg = verifyHeaderReconciliation(billNeg, TOLERANCES);
    const verdictNeg = computeVerdict(signsNeg, perLineNeg, headerNeg);
    results.push({
      name: `Negative case [${neg.name}] → verdict=${neg.expected_persist_verdict}`,
      passed: verdictNeg.verdict === neg.expected_persist_verdict,
      detail: `actual=${verdictNeg.verdict} categories=[${verdictNeg.categories.join(",")}] signs=${signsNeg.length}`,
    });
  }

  return results;
}

function keyForField(field: string): string {
  switch (field) {
    case "insurance_paid":
      return "insurance_paid";
    case "insurance_adjusted_amount":
      return "ins_adjusted";
    case "patient_paid_amount":
      return "patient_responsibility";
    default:
      return field;
  }
}

function main() {
  const fixtureFiles = fs
    .readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort();
  if (fixtureFiles.length === 0) {
    console.error("No fixtures found in " + FIXTURE_DIR);
    process.exit(1);
  }

  let totalPass = 0;
  let totalFail = 0;
  for (const fname of fixtureFiles) {
    const data = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, fname), "utf8")) as FixtureRow;
    console.log("\n[fixture] " + fname + " — " + data.fixture_id);
    const results = runFixture(data);
    for (const r of results) {
      const mark = r.passed ? "✓" : "✗";
      console.log("  " + mark + " " + r.name + " — " + r.detail);
      if (r.passed) totalPass++;
      else totalFail++;
    }
  }
  console.log("\n[summary] " + totalPass + " passed, " + totalFail + " failed");
  if (totalFail > 0) process.exit(1);
}

main();
