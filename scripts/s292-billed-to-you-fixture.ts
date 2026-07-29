/**
 * S292 (#4) — "BILLED TO YOU" column fixture.
 *
 * Proves `resolvePerLineBilledToYou` (src/lib/claims/effective-totals.ts) —
 * the pure display resolver behind the bill table's BILLED TO YOU column:
 * billed − insurer's negotiated adjustment − insurer's payment, per line,
 * via the SAME S140 per-line resolvers (cite-grade raw vs header-prorated)
 * the YOU PAID column already uses.
 *
 * Cases:
 *  1. Swedish bill (REAL DEV-clone data, claim 50c1f702…, probed 2026-07-29):
 *     header-prorated path. Line J7298 → ≈ $4.30; the 5 per-line values sum
 *     to the receipt's amount due ≈ $6.77.
 *  2. Fresh unpaid bill: BILLED TO YOU > 0 while YOU PAID = $0.00 — the two
 *     columns are separate facts and legitimately disagree.
 *  3. Honesty fallback: NO insurer data anywhere → gross, no sub-line, no
 *     invented adjustment.
 *  4. Negative clamp: inconsistent data (adjustment + payment exceed the
 *     charge) → gross + no sub-line, never a negative.
 *  5. Zero-billed (quality-measure) line → $0.00, no sub-line.
 *
 * Deliberately hermetic — no network, no DB. Run:
 *   npx tsx scripts/s292-billed-to-you-fixture.ts
 */

import {
  resolveEffectiveClaimTotals,
  resolvePerLineBilledToYou,
  resolvePerLinePatientPaid,
} from "../src/lib/claims/effective-totals";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, got?: unknown) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${got !== undefined ? ` — got ${JSON.stringify(got)}` : ""}`);
  }
}

// ── Case 1: Swedish bill — REAL DEV-clone rows (read-only probe 2026-07-29) ──
// user andrew29@candidclaim.com, claim 50c1f702-a541-4a40-89ad-41124c1a8de1,
// DOS 2023-07-31, 5 lines. Receipt ground truth: ins adjusted −$619.55,
// ins paid −$1,563.68, amount due $6.77. Per-line insurance columns are
// sparse in the DB (ins_adj all 0, ins_paid all NULL) → header fallback →
// proportional split by billed share, exactly like YOU PAID.
console.log("Case 1 — Swedish bill (real data, header-prorated)");
{
  const claim = {
    total_billed: 2190,
    total_insurance_paid: 1563.68,
    total_insurance_adjusted: 619.55,
    total_patient_paid: 6.77,
    total_patient_responsibility: 6.77,
    amount_still_outstanding: null,
  };
  const lines = [
    { code: "84703", billed_amount: 51, insurance_adjusted_amount: 0, insurance_paid: null, patient_paid_amount: 0, patient_owes: null },
    { code: "58300", billed_amount: 422, insurance_adjusted_amount: 0, insurance_paid: null, patient_paid_amount: 0, patient_owes: null },
    { code: "J7298", billed_amount: 1391, insurance_adjusted_amount: 0, insurance_paid: null, patient_paid_amount: 0, patient_owes: null },
    { code: "58301", billed_amount: 309, insurance_adjusted_amount: 0, insurance_paid: null, patient_paid_amount: 0, patient_owes: null },
    { code: "96127", billed_amount: 17, insurance_adjusted_amount: 0, insurance_paid: null, patient_paid_amount: 0, patient_owes: null },
  ];
  const effectiveTotals = resolveEffectiveClaimTotals({ claim, lineItems: lines });
  check(
    "insurer fields resolve from the claim header (sparse per-line)",
    effectiveTotals.provenance.insuranceAdjustedSource === "claim_header" &&
      effectiveTotals.provenance.insurancePaidSource === "claim_header",
    effectiveTotals.provenance,
  );

  const results = lines.map((li) =>
    resolvePerLineBilledToYou({
      lineBilled: li.billed_amount,
      lineInsuranceAdjusted: li.insurance_adjusted_amount,
      lineInsurancePaid: li.insurance_paid,
      claimTotalBilled: claim.total_billed,
      effectiveTotals,
    }),
  );
  const j7298 = results[2];
  const sum = Math.round(results.reduce((s, r) => s + r.value, 0) * 100) / 100;

  check("J7298 billed-to-you ≈ $4.30", Math.abs(j7298.value - 4.3) <= 0.01, j7298.value);
  check("5-line billed-to-you sum ≈ $6.77 (receipt amount due)", Math.abs(sum - 6.77) <= 0.02, sum);
  check(
    "every line shows the gross sub-line (insurer data moved every number)",
    results.every((r) => r.showBeforeInsurance),
    results.map((r) => r.showBeforeInsurance),
  );
  check(
    "gross preserved per line (sub-line shows the provider's charge)",
    j7298.gross === 1391 && results[0].gross === 51,
    { j7298: j7298.gross, l1: results[0].gross },
  );
  check(
    "no per-line value is negative",
    results.every((r) => r.value >= 0),
    results.map((r) => r.value),
  );
}

// ── Case 2: fresh unpaid bill — BILLED TO YOU and YOU PAID disagree ─────────
console.log("Case 2 — fresh unpaid bill (billed-to-you > 0, you-paid $0.00)");
{
  const claim = {
    total_billed: 500,
    total_insurance_paid: 250,
    total_insurance_adjusted: 200,
    total_patient_paid: 0,
    total_patient_responsibility: 50,
    amount_still_outstanding: 50,
  };
  const lines = [
    { billed_amount: 500, insurance_adjusted_amount: null, insurance_paid: null, patient_paid_amount: null, patient_owes: null },
  ];
  const effectiveTotals = resolveEffectiveClaimTotals({ claim, lineItems: lines });
  const bty = resolvePerLineBilledToYou({
    lineBilled: 500,
    lineInsuranceAdjusted: null,
    lineInsurancePaid: null,
    claimTotalBilled: 500,
    effectiveTotals,
  });
  const youPaid = resolvePerLinePatientPaid({
    lineBilled: 500,
    linePatientPaid: null,
    claimTotalBilled: 500,
    effectiveClaimPatientPaid: effectiveTotals,
  });
  check("billed-to-you = $50.00 (500 − 200 adj − 250 paid)", bty.value === 50, bty.value);
  check("sub-line renders (insurer data moved the number)", bty.showBeforeInsurance === true, bty);
  check("YOU PAID stays $0.00 — separate fact, not derived from billed-to-you", youPaid.value === 0, youPaid.value);
  check("the two columns legitimately disagree on an unpaid bill", bty.value > 0 && youPaid.value === 0, {
    billedToYou: bty.value,
    youPaid: youPaid.value,
  });
}

// ── Case 3: honesty fallback — NO insurer data anywhere ─────────────────────
console.log("Case 3 — no insurer adjustment/payment data at all (honesty fallback)");
{
  const claim = {
    total_billed: 997.49,
    total_insurance_paid: null,
    total_insurance_adjusted: null,
    total_patient_paid: null,
    total_patient_responsibility: null,
    amount_still_outstanding: null,
  };
  const lines = [
    { billed_amount: 997.49, insurance_adjusted_amount: null, insurance_paid: null, patient_paid_amount: null, patient_owes: null },
  ];
  const effectiveTotals = resolveEffectiveClaimTotals({ claim, lineItems: lines });
  const bty = resolvePerLineBilledToYou({
    lineBilled: 997.49,
    lineInsuranceAdjusted: null,
    lineInsurancePaid: null,
    claimTotalBilled: 997.49,
    effectiveTotals,
  });
  check("value = gross exactly as today ($997.49)", bty.value === 997.49, bty.value);
  check("NO sub-line — never invent an adjustment", bty.showBeforeInsurance === false, bty);
}

// ── Case 4: negative clamp — inconsistent data falls back to gross ──────────
console.log("Case 4 — inconsistent data (adjustment + payment exceed the charge)");
{
  // Per-line values are cite-grade (sums match the header) but sum past the
  // charge: 100 billed vs 80 adj + 30 paid → raw −10. Never show a negative.
  const claim = {
    total_billed: 100,
    total_insurance_paid: 30,
    total_insurance_adjusted: 80,
    total_patient_paid: 0,
    total_patient_responsibility: null,
    amount_still_outstanding: null,
  };
  const lines = [
    { billed_amount: 100, insurance_adjusted_amount: 80, insurance_paid: 30, patient_paid_amount: 0, patient_owes: null },
  ];
  const effectiveTotals = resolveEffectiveClaimTotals({ claim, lineItems: lines });
  const bty = resolvePerLineBilledToYou({
    lineBilled: 100,
    lineInsuranceAdjusted: 80,
    lineInsurancePaid: 30,
    claimTotalBilled: 100,
    effectiveTotals,
  });
  check("falls back to gross ($100.00), not −$10.00", bty.value === 100, bty.value);
  check("NO sub-line on the inconsistent fallback", bty.showBeforeInsurance === false, bty);
  check("value clamped ≥ $0", bty.value >= 0, bty.value);
}

// ── Case 5: zero-billed (quality-measure) line ───────────────────────────────
console.log("Case 5 — zero-billed line on a bill WITH insurer data");
{
  const claim = {
    total_billed: 100,
    total_insurance_paid: 50,
    total_insurance_adjusted: 20,
    total_patient_paid: 0,
    total_patient_responsibility: 30,
    amount_still_outstanding: 30,
  };
  const lines = [
    { billed_amount: 100, insurance_adjusted_amount: null, insurance_paid: null, patient_paid_amount: null, patient_owes: null },
    { billed_amount: 0, insurance_adjusted_amount: null, insurance_paid: null, patient_paid_amount: null, patient_owes: null },
  ];
  const effectiveTotals = resolveEffectiveClaimTotals({ claim, lineItems: lines });
  const charged = resolvePerLineBilledToYou({
    lineBilled: 100,
    lineInsuranceAdjusted: null,
    lineInsurancePaid: null,
    claimTotalBilled: 100,
    effectiveTotals,
  });
  const zero = resolvePerLineBilledToYou({
    lineBilled: 0,
    lineInsuranceAdjusted: null,
    lineInsurancePaid: null,
    claimTotalBilled: 100,
    effectiveTotals,
  });
  check("charged line: 100 − 20 − 50 = $30.00 + sub-line", charged.value === 30 && charged.showBeforeInsurance, charged);
  check("zero-billed line stays $0.00", zero.value === 0, zero.value);
  check("zero-billed line gets NO sub-line ($0.00 before insurance is noise)", zero.showBeforeInsurance === false, zero);
  check("zero-billed value is 0, not −0", !Object.is(zero.value, -0), zero.value);
}

// ── Case 5b: fully-covered line rounds to exactly $0.00 (−0 normalization) ──
console.log("Case 5b — fully-covered line ($0.00 remainder, −0 normalized)");
{
  const claim = {
    total_billed: 10,
    total_insurance_paid: 4,
    total_insurance_adjusted: 6,
    total_patient_paid: 0,
    total_patient_responsibility: 0,
    amount_still_outstanding: null,
  };
  const lines = [
    { billed_amount: 10, insurance_adjusted_amount: 6, insurance_paid: 4, patient_paid_amount: 0, patient_owes: null },
  ];
  const effectiveTotals = resolveEffectiveClaimTotals({ claim, lineItems: lines });
  const bty = resolvePerLineBilledToYou({
    lineBilled: 10,
    lineInsuranceAdjusted: 6,
    lineInsurancePaid: 4,
    claimTotalBilled: 10,
    effectiveTotals,
  });
  check("fully-covered line = exactly $0.00 (not −0)", bty.value === 0 && !Object.is(bty.value, -0), bty.value);
  check("sub-line renders — $0.00 vs $10.00 gross is real information", bty.showBeforeInsurance === true, bty);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
