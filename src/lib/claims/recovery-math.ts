/**
 * Billing math + dispute recovery derivation (T2.8).
 *
 * Single source of truth for the four user-facing numbers on every claim line:
 *   - Billed (provider charge)
 *   - Already Paid (billed − still outstanding; the money already resolved)
 *   - You Should Owe (per plan coverage)
 *   - Potential Recovery (billed − should owe; dispute value)
 *
 * The schema (migration 044) adds `amount_still_outstanding` + `amount_resolved`
 * columns; until the Session 36 reconciler populates them, `resolveStillOutstanding`
 * falls back to legacy fields + pro-rate by billed share.
 */

export interface PlanCoverageInput {
  covered: boolean | null;
  copay: number | null;
  coinsurance: number | null;
}

export interface RecoveryMetrics {
  billed: number;
  alreadyPaid: number;
  stillOutstanding: number;
  shouldOwe: number;
  potentialRecovery: number;
  /** Refund component: what's already been paid above the plan's true copay */
  refundComponent: number;
  /** Forgiveness component: what's still demanded above the plan's true copay */
  forgivenessComponent: number;
}

/**
 * Resolve the per-line still-outstanding amount with a cascading fallback:
 *   1. `amount_still_outstanding` column (populated by the reconciler or Haiku
 *      when it allocates per line).
 *   2. Legacy `patient_owes` when non-zero.
 *   3. Pro-rate `claim.amount_still_outstanding` (or `total_patient_responsibility`)
 *      by this line's billed share — handles the common case where Haiku dumps
 *      the EOB header total without per-line allocation.
 *   4. Zero, when we truly have nothing.
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
    return Math.round((args.lineBilled / args.claimTotalBilled) * args.claimStillOutstanding);
  }
  return 0;
}

/**
 * Translate plan coverage into a dollar amount the user should owe for a given
 * billed charge. Defaults to 0 ("user isn't on the hook") when coverage is
 * unknown — conservative framing that aligns with the dispute-recovery message.
 */
export function computeShouldOwe(billed: number, planCoverage: PlanCoverageInput | null): number {
  if (!planCoverage) return 0;
  if (planCoverage.covered === false) return billed;
  if (planCoverage.copay != null) return Math.min(planCoverage.copay, billed);
  if (planCoverage.coinsurance != null && planCoverage.coinsurance > 0) {
    return Math.round(billed * planCoverage.coinsurance);
  }
  return 0;
}

export function computeRecovery(
  billed: number,
  stillOutstanding: number,
  planCoverage: PlanCoverageInput | null,
): RecoveryMetrics {
  const alreadyPaid = Math.max(0, billed - stillOutstanding);
  const shouldOwe = computeShouldOwe(billed, planCoverage);
  const potentialRecovery = Math.max(0, billed - shouldOwe);
  const refundComponent = Math.max(0, alreadyPaid - shouldOwe);
  const forgivenessComponent = Math.max(0, stillOutstanding - shouldOwe);
  return {
    billed,
    alreadyPaid,
    stillOutstanding,
    shouldOwe,
    potentialRecovery,
    refundComponent,
    forgivenessComponent,
  };
}
