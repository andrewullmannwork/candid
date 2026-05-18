// S94 B4 — Per-line arithmetic plausibility check.
//
// Pure function. Reports whether a parsed line item violates basic
// arithmetic plausibility (insurance paid more than billed by 10x, patient
// owes more than billed by 20x, $0 billed but $5k+ allocated, etc.). Used
// to drop hallucinated lines after Haiku extraction.
//
// Motivating incident (S94 B1 Stage 4 testing 2026-05-15): on an SBC
// uploaded as bill, Haiku produced lines like:
//   - billed=$0, patient_owes=$91,410 (from "Maria pays" coverage example)
//   - billed=$10,348, insurance_paid=$91,410 (insurer paid 8.8x billed)
//   - billed=$0, patient_owes=$509 (from HHS office address "Room 509F")
//
// Conservative thresholds intentionally — the goal is to catch obviously
// non-physical extractions without false-positive on real bills with
// unusual patterns (capitated visits with $0 billed + small copay,
// secondary payer overpayments, interest line items, etc.).

import type { BillLineItem } from "./types";

export interface PlausibilityCheck {
  dropped: boolean;
  reason?: string;
}

const ZERO_BILLED_LARGE_ALLOCATION_THRESHOLD = 5000;
// Insurance paid > 5x billed is genuinely unusual on real bills.
// Secondary-payer, interest, penalty all top out around 1.5–3x in practice.
// Tightened from initial 10x after S94 B4 verification surfaced an 8.8x
// hallucinated line (claim 52c1f432 line 3: billed=$10,348 / paid=$91,410)
// that escaped the looser threshold.
const INSURANCE_PAID_MULTIPLE = 5;
// Patient owed > 20x billed is non-physical even for high-copay-on-low-allowed
// edge cases. Kept conservative since real bills exhibit more variation here
// than on the paid side.
const PATIENT_OWED_MULTIPLE = 20;

export function lineIsImplausible(item: BillLineItem): PlausibilityCheck {
  const billed = item.billedAmount;
  const paid = item.insurancePaid ?? 0;
  const owed = item.patientResponsibility ?? 0;

  // Pattern 1: $0 billed but large allocations. Real bills CAN have $0
  // billed with small copay (capitated visits), but $0 billed with $5k+
  // allocated is non-physical.
  if (billed === 0 && (paid > ZERO_BILLED_LARGE_ALLOCATION_THRESHOLD || owed > ZERO_BILLED_LARGE_ALLOCATION_THRESHOLD)) {
    const big = Math.max(paid, owed);
    return { dropped: true, reason: `zero billed but $${big.toFixed(2)} allocated` };
  }

  // Pattern 2: insurance paid grossly more than billed. Real bills
  // sometimes show paid > billed (secondary payer, interest); 10x is the
  // safety threshold.
  if (billed > 0 && paid > billed * INSURANCE_PAID_MULTIPLE) {
    return { dropped: true, reason: `insurance_paid ($${paid.toFixed(2)}) > ${INSURANCE_PAID_MULTIPLE}x billed ($${billed.toFixed(2)})` };
  }

  // Pattern 3: patient owes grossly more than billed. Allows for
  // copay-with-zero-allowed edge cases up to 20x.
  if (billed > 0 && owed > billed * PATIENT_OWED_MULTIPLE) {
    return { dropped: true, reason: `patient_responsibility ($${owed.toFixed(2)}) > ${PATIENT_OWED_MULTIPLE}x billed ($${billed.toFixed(2)})` };
  }

  return { dropped: false };
}
