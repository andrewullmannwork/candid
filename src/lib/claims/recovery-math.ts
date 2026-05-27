/**
 * Billing math + dispute recovery derivation.
 *
 * Single source of truth for the four user-facing numbers on every claim line:
 *   - Billed (provider charge)
 *   - Patient already paid (out of pocket — from `patient_paid_amount` column,
 *     mig 092; distinct from `insurance_paid` which is the insurer's payment)
 *   - You should owe (per plan coverage — copay / coinsurance / deductible)
 *   - Potential recovery (refund + forgiveness; what the user can dispute)
 *
 * Formula (re-derived Session 85 after the parser bug + patient_paid column landed):
 *
 *   user_burden        = patient_responsibility        // total share assigned by insurer
 *   remaining_balance  = max(0, patient_responsibility − patient_paid)
 *   potentialRecovery  = max(0, user_burden − should_owe)
 *   refundComponent    = max(0, patient_paid − should_owe)
 *                          // user paid more than plan says they should
 *   forgivenessComp    = potentialRecovery − refundComponent
 *                          // remaining outstanding above plan share
 *
 * Sum invariant: refundComponent + forgivenessComponent === potentialRecovery.
 *
 * Why this shape:
 *   - For Andrew's Bill 1 (Nicole paid $292.41 OOP, plan copay $20):
 *       refund=$272.41, forgiveness=$0, recovery=$272.41 — dispute = refund request
 *   - For a hypothetical unpaid version of the same bill:
 *       refund=$0, forgiveness=$272.41, recovery=$272.41 — dispute = forgive outstanding
 *   - Mixed cases naturally split between the two buckets.
 *
 * The old `alreadyPaid` field (= billed − stillOutstanding) is RETAINED for
 * back-compat on UI surfaces that still surface "Already Paid" as an
 * informational number, but it conflates insurance + patient + adjustments
 * and should NOT be used in recovery math. Use patient_paid instead.
 */

export interface PlanCoverageInput {
  covered: boolean | null;
  /** Per-visit fixed dollar amount the patient owes. Caps at allowed amount. */
  copay: number | null;
  /**
   * Patient's coinsurance share as a DECIMAL FRACTION (0-1). E.g., 0.30 for
   * "30% coinsurance" per SBC convention.
   *
   * UNIT CONTRACT: Storage layer (`plan_covered_services.in_coinsurance`)
   * holds INTEGER PERCENT (0-100). Every boundary that constructs a
   * PlanCoverageInput from DB rows MUST divide by 100 before passing.
   * Mismatching the unit produces 100× inflation in computeShouldOwe.
   */
  coinsurance: number | null;
}

export interface RecoveryMetrics {
  billed: number;
  /** Patient out-of-pocket payments — from claim_line_items.patient_paid_amount (mig 092). */
  patientPaid: number;
  /** Total user share assigned by the insurer (= patient_owes / patient_responsibility). */
  patientResponsibility: number;
  /** Remaining balance the bill still claims the user owes. */
  remainingBalance: number;
  /** What the plan says the user should owe (copay/coinsurance/etc). */
  shouldOwe: number;
  /** Total disputable amount (refund + forgiveness). */
  potentialRecovery: number;
  /** Component already paid OOP above plan share — request refund from provider/insurer. */
  refundComponent: number;
  /** Component still outstanding above plan share — request forgiveness. */
  forgivenessComponent: number;
  /**
   * @deprecated Conflates insurer + patient payments + adjustments. Retained
   * for legacy UI that surfaces "Already Paid" as an informational number.
   * Equivalent to billed − stillOutstanding.
   */
  alreadyPaid: number;
  /** @deprecated Use remainingBalance. */
  stillOutstanding: number;
}

/**
 * Resolve the per-line still-outstanding amount with a cascading fallback.
 * Retained for legacy callers; new code should prefer patient_paid + patient_owes
 * directly via computeRecovery's `patientPaid` arg.
 */
export function resolveStillOutstanding(args: {
  lineBilled: number;
  lineStillOutstanding: number | null;
  linePatientOwes: number | null;
  claimTotalBilled: number;
  claimStillOutstanding: number | null;
}): number {
  if (args.lineStillOutstanding != null) {
    return Math.max(0, args.lineStillOutstanding);
  }
  if (args.linePatientOwes != null && args.linePatientOwes > 0) {
    return args.linePatientOwes;
  }
  if (args.claimStillOutstanding != null && args.claimStillOutstanding > 0 && args.claimTotalBilled > 0) {
    // Round to nearest CENT, not nearest dollar, so the prorated value lines
    // up with patient_paid_amount (which is stored to the cent). Rounding to
    // whole dollars produced a phantom $0.04 forgive on Bill 2 line 99395
    // ($43.97 → $44 vs patient_paid $43.96 → $44 − $43.96 = $0.04).
    return Math.round((args.lineBilled / args.claimTotalBilled) * args.claimStillOutstanding * 100) / 100;
  }
  return 0;
}

export interface ComputeShouldOweArgs {
  /** Per-line gross billed amount (provider's charge before adjustments). */
  billed: number;
  /** Per-line contractual writeoff the insurer applies. Defaults to 0. */
  insuranceAdjusted?: number;
  /** Per-line provider courtesy adjustment (separate from insurer writeoff). Defaults to 0. */
  providerAdjusted?: number;
  planCoverage: PlanCoverageInput | null;
}

/**
 * Translate plan coverage into a dollar amount the user should owe for a given
 * billed charge. Defaults to 0 ("user isn't on the hook") when coverage is
 * unknown — conservative framing that aligns with the dispute-recovery message.
 *
 * Math (per Andrew direction, S120):
 *   adjusted = max(0, billed − insuranceAdjusted − providerAdjusted)
 *   - covered === false → patient owes the full adjusted amount
 *   - copay set → min(copay, adjusted)  (per-visit fixed; caps at allowed)
 *   - coinsurance > 0 → adjusted × coinsurance  (patient's share)
 *   - otherwise → 0
 *
 * Coinsurance must be DECIMAL FRACTION (0-1). See PlanCoverageInput.coinsurance
 * unit contract.
 */
export function computeShouldOwe(args: ComputeShouldOweArgs): number {
  const adjusted = Math.max(
    0,
    args.billed - (args.insuranceAdjusted ?? 0) - (args.providerAdjusted ?? 0),
  );
  const planCoverage = args.planCoverage;
  if (!planCoverage) return 0;
  if (planCoverage.covered === false) return adjusted;
  if (planCoverage.copay != null) return Math.min(planCoverage.copay, adjusted);
  if (planCoverage.coinsurance != null && planCoverage.coinsurance > 0) {
    return Math.round(adjusted * planCoverage.coinsurance);
  }
  return 0;
}

export interface ComputeRecoveryArgs {
  billed: number;
  /** Total user share assigned by insurer (from patient_owes column). */
  patientResponsibility: number;
  /** Patient out-of-pocket payments (from patient_paid_amount column, mig 092). Default 0. */
  patientPaid?: number;
  /**
   * Per-line contractual writeoff by the insurer (from `insurance_adjusted_amount`).
   * Subtracted from billed before applying coinsurance/copay. Defaults to 0.
   */
  insuranceAdjusted?: number;
  /** Per-line provider courtesy adjustment. Defaults to 0. */
  providerAdjusted?: number;
  planCoverage: PlanCoverageInput | null;
}

/**
 * Primary entry point. Pass per-line billed + patient_responsibility +
 * patient_paid + planCoverage and get the full RecoveryMetrics back.
 */
export function computeRecoveryV2(args: ComputeRecoveryArgs): RecoveryMetrics {
  const billed = args.billed;
  const patientResponsibility = Math.max(0, args.patientResponsibility);
  const patientPaid = Math.max(0, args.patientPaid ?? 0);
  const insuranceAdjusted = args.insuranceAdjusted ?? 0;
  const shouldOwe = computeShouldOwe({
    billed,
    insuranceAdjusted,
    providerAdjusted: args.providerAdjusted ?? 0,
    planCoverage: args.planCoverage,
  });

  const remainingBalance = Math.max(0, patientResponsibility - patientPaid);
  // Session 85 math fix — user_burden = max(paid, assigned-share). When the
  // user has OVERPAID (e.g., Bill 2 lines where prorated patient_responsibility
  // is less than the proportional patient_paid backfill), the burden is still
  // the larger of the two. Without this, potentialRecovery silently drops
  // below refundComponent and forgive clamps to 0 even when paid > should_owe.
  const effectiveBurden = Math.max(patientPaid, patientResponsibility);
  const potentialRecovery = Math.max(0, effectiveBurden - shouldOwe);
  const refundComponent = Math.max(0, patientPaid - shouldOwe);
  // Invariant: refundComponent ≤ potentialRecovery.
  // forgivenessComponent is the "Insured" amount in the UI — what the insurer
  // should have paid the provider that they didn't (reduces outstanding balance).
  const forgivenessComponent = Math.max(0, potentialRecovery - refundComponent);

  // Legacy fields — kept for surfaces that still read them.
  const stillOutstanding = remainingBalance;
  const alreadyPaid = Math.max(0, billed - stillOutstanding);

  return {
    billed,
    patientPaid,
    patientResponsibility,
    remainingBalance,
    shouldOwe,
    potentialRecovery,
    refundComponent,
    forgivenessComponent,
    alreadyPaid,
    stillOutstanding,
  };
}

/**
 * Legacy signature wrapper. New callers should use computeRecoveryV2 with
 * explicit patientPaid + patientResponsibility. This wrapper assumes
 * patientPaid=0 (the conservative case) and derives patientResponsibility
 * from the legacy stillOutstanding heuristic.
 *
 * @deprecated Use computeRecoveryV2 — pass patient_paid_amount explicitly.
 */
export function computeRecovery(
  billed: number,
  stillOutstanding: number,
  planCoverage: PlanCoverageInput | null,
): RecoveryMetrics {
  // The legacy contract treated stillOutstanding as patient_responsibility.
  // Keep that semantic for back-compat; patientPaid defaults to 0.
  return computeRecoveryV2({
    billed,
    patientResponsibility: stillOutstanding,
    patientPaid: 0,
    planCoverage,
  });
}
