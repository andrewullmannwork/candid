/**
 * patient-paid-override — dispute-letters v2 S264 (Z1.1b) unit fixture.
 *
 * Proves the user-confirmed amount-paid override (claims.metadata.userPatientPaid) on
 * deterministic synthetic inputs — no DB, no clock dependence:
 *   - readUserPatientPaidOverride parses/rejects correctly (0 is valid; negatives, strings,
 *     NaN, missing → null → caller no-ops → byte-identical),
 *   - applyUserPatientPaidOverride sets the claim header AND prorates per-line by billed
 *     share, remainder on the largest-billed line, so per-line sum == header exactly,
 *   - THE DIVERGENCE GUARD: after the overlay, resolveEffectiveClaimTotals returns the
 *     override (source per_line_sum) EVEN WHEN the old parsed header disagreed — i.e. a
 *     lines-only overlay would have been silently discarded by header reconciliation.
 *
 * Run:  npx tsx scripts/calibration/fixtures/dispute-grounds/patient-paid-override.ts
 */
import {
  readUserPatientPaidOverride,
  applyUserPatientPaidOverride,
  resolveEffectiveClaimTotals,
} from "../../../../src/lib/claims/effective-totals";

let pass = 0;
const fails: string[] = [];
function check(name: string, cond: boolean, got?: unknown) {
  if (cond) pass++;
  else fails.push(`✗ ${name}${got !== undefined ? `  (${String(got)})` : ""}`);
}
const near = (a: number, b: number) => Math.abs(a - b) < 0.005;
const sumPaid = (lines: Array<{ patient_paid_amount?: number | null }>) =>
  lines.reduce((s, li) => s + Number(li.patient_paid_amount ?? 0), 0);

// ── readUserPatientPaidOverride ─────────────────────────────────────────────
check("read · dollar", readUserPatientPaidOverride({ userPatientPaid: 340.5 }) === 340.5);
check("read · zero is valid", readUserPatientPaidOverride({ userPatientPaid: 0 }) === 0);
check("read · negative → null", readUserPatientPaidOverride({ userPatientPaid: -5 }) === null);
check("read · string → null", readUserPatientPaidOverride({ userPatientPaid: "340" }) === null);
check("read · NaN → null", readUserPatientPaidOverride({ userPatientPaid: Number.NaN }) === null);
check("read · missing key → null", readUserPatientPaidOverride({}) === null);
check("read · null metadata → null", readUserPatientPaidOverride(null) === null);
check("read · non-object → null", readUserPatientPaidOverride(42) === null);
check("read · rounds to cents", readUserPatientPaidOverride({ userPatientPaid: 12.34 }) === 12.34);

// ── applyUserPatientPaidOverride: proration + header ─────────────────────────
{
  const claim: { total_patient_paid?: number | null } = { total_patient_paid: 999 };
  const lines = [{ billed_amount: 100, patient_paid_amount: 999 }, { billed_amount: 300, patient_paid_amount: 999 }];
  applyUserPatientPaidOverride(claim, lines, 200);
  check("prorate · header set", claim.total_patient_paid === 200, claim.total_patient_paid);
  check("prorate · line0 (100/400·200)", near(Number(lines[0].patient_paid_amount), 50), lines[0].patient_paid_amount);
  check("prorate · line1 (300/400·200)", near(Number(lines[1].patient_paid_amount), 150), lines[1].patient_paid_amount);
  check("prorate · sum == override", near(sumPaid(lines), 200), sumPaid(lines));
}
{
  const claim: { total_patient_paid?: number | null } = { total_patient_paid: null };
  const lines = [{ billed_amount: 250, patient_paid_amount: null }];
  applyUserPatientPaidOverride(claim, lines, 175);
  check("single line · gets whole override", near(Number(lines[0].patient_paid_amount), 175), lines[0].patient_paid_amount);
  check("single line · header set", claim.total_patient_paid === 175);
}
{
  const claim: { total_patient_paid?: number | null } = {};
  applyUserPatientPaidOverride(claim, [], 100);
  check("no lines · header still set, no crash", claim.total_patient_paid === 100);
}
{
  const claim: { total_patient_paid?: number | null } = {};
  const lines = [{ billed_amount: 0, patient_paid_amount: null }, { billed_amount: 0, patient_paid_amount: null }];
  applyUserPatientPaidOverride(claim, lines, 100);
  check("zero billed · equal split", near(Number(lines[0].patient_paid_amount), 50) && near(Number(lines[1].patient_paid_amount), 50));
  check("zero billed · sum == override", near(sumPaid(lines), 100), sumPaid(lines));
}
{
  // rounding remainder: 1/3 each rounds to 33.33 → sum 99.99 → +0.01 residual on line 0.
  const claim: { total_patient_paid?: number | null } = {};
  const lines = [{ billed_amount: 1, patient_paid_amount: null }, { billed_amount: 1, patient_paid_amount: null }, { billed_amount: 1, patient_paid_amount: null }];
  applyUserPatientPaidOverride(claim, lines, 100);
  check("remainder · residual on line0", near(Number(lines[0].patient_paid_amount), 33.34), lines[0].patient_paid_amount);
  check("remainder · sum == override exactly", near(sumPaid(lines), 100), sumPaid(lines));
}
{
  const claim: { total_patient_paid?: number | null } = { total_patient_paid: 40 };
  const lines = [{ billed_amount: 100, patient_paid_amount: 40 }];
  applyUserPatientPaidOverride(claim, lines, 0);
  check("zero override · suppresses (header 0)", claim.total_patient_paid === 0);
  check("zero override · line 0", near(Number(lines[0].patient_paid_amount), 0), lines[0].patient_paid_amount);
}

// ── THE DIVERGENCE GUARD ─────────────────────────────────────────────────────
// Old parsed header (500) DISAGREES with the override (200). A lines-only overlay would be
// silently discarded (decideField(200, 500) → header wins → 500). Setting header + lines
// keeps them in sync so the effective total is the override, cite-grade per_line_sum.
{
  const claim = { total_patient_paid: 500, total_billed: 400 };
  const lines = [{ billed_amount: 100, patient_paid_amount: 999 }, { billed_amount: 300, patient_paid_amount: 999 }];
  applyUserPatientPaidOverride(claim, lines, 200);
  const eff = resolveEffectiveClaimTotals({ claim, lineItems: lines, userTotalsSource: null });
  check("guard · effective patientPaid == override (NOT stale 500)", near(eff.patientPaid, 200), eff.patientPaid);
  check("guard · source is per_line_sum (header==sum)", eff.provenance.patientPaidSource === "per_line_sum", eff.provenance.patientPaidSource);
}
// Absent override → read returns null → caller never overlays → effective totals untouched.
{
  const claim = { total_patient_paid: 500, total_billed: 400 };
  const lines = [{ billed_amount: 100, patient_paid_amount: 120 }, { billed_amount: 300, patient_paid_amount: 380 }];
  const ov = readUserPatientPaidOverride({ someOtherKey: 1 });
  const eff = resolveEffectiveClaimTotals({ claim, lineItems: lines, userTotalsSource: null });
  check("absent · no override read", ov === null);
  check("absent · effective == header 500 (byte-identical path)", near(eff.patientPaid, 500), eff.patientPaid);
}

console.log(`\npatient-paid-override fixture: ${pass} passed, ${fails.length} failed`);
if (fails.length) {
  console.log(fails.join("\n"));
  console.log("FAILED ✗");
  process.exit(1);
}
console.log("ALL GREEN ✓");
