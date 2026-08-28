/**
 * line-gap — S326: the synthetic gap-entry KIND decision, extracted pure.
 *
 * THE DEFECT THIS FIXES (Andrew's Riverside test bill, S326): the claim page
 * synthesized "insurer under-paid" (missing_adjustment) entries for lines the
 * insurer NEVER ADJUDICATED — a self-pay bill with no EOB and $0 insurance
 * activity grew an insurer-appeal offer and fact-panel prose asserting an EOB
 * that does not exist. The S304 class: absence read as contradiction.
 *
 * THE RULE (presence-based, the S314 presence-means-non-null discipline): a
 * synthetic entry may tell an INSURER story only when insurer adjudication is
 * actually PRESENT in the documents —
 *   - line-level: allowed_amount / insurance_paid / insurance_adjusted_amount
 *     stated (non-null; an explicit 0 is a statement, null is absence), or
 *   - header-level: the claim's own totals state insurer activity (S304 — a
 *     provider receipt states its adjudication ONCE, at the header).
 * No adjudication anywhere → NO synthetic entry (the honest state; the line's
 * plan-vs-billed story is the engine's own verdict, not an insurer finding).
 *
 * Pinned by scripts/calibration/fixtures/claims/line-gap.ts (CI) — the
 * unadjudicated case is locked by name. The prose the page builds from these
 * kinds ("Insurance paid $X…", "EOB records $0…") is true by construction
 * once the kind requires the adjudication it describes.
 */

export interface LineGapLineSignals {
  billedAmount: number | null;
  allowedAmount: number | null;
  insurancePaid: number | null;
  insuranceAdjusted: number | null;
  patientOwes: number | null;
  coverageStatus: "covered" | "not_covered" | "unknown" | null;
  /** The cost-share engine's verdict for the line, when it ran (null = not on engine). */
  costShareVerdict: string | null;
  /** Engine recovery components (0 when absent). */
  refundComponent: number;
  forgivenessComponent: number;
  /** Plan coverage resolved for the line (null = none). */
  hasPlanCoverage: boolean;
}

export interface LineGapClaimSignals {
  /** The claim header's stated insurer totals (null = the document never said). */
  totalInsurancePaid: number | null;
  totalAllowed: number | null;
  totalInsuranceAdjusted: number | null;
}

/** Insurer adjudication is PRESENT for this line (stated on the line or, per
 *  S304, once at the claim header). Explicit 0 counts; null never does. */
export function insurerAdjudicationPresent(
  line: Pick<LineGapLineSignals, "allowedAmount" | "insurancePaid" | "insuranceAdjusted">,
  claim: LineGapClaimSignals,
): boolean {
  return (
    line.allowedAmount != null ||
    line.insurancePaid != null ||
    line.insuranceAdjusted != null ||
    claim.totalInsurancePaid != null ||
    claim.totalAllowed != null ||
    claim.totalInsuranceAdjusted != null
  );
}

/**
 * The synthetic gap kind for a line with no real audit finding:
 *   "mystery"  — adjudication stated, and it recorded $0 insurer payment and
 *                $0 patient responsibility on a billed charge (the unexplained
 *                zero-zero line; requires LINE-level statement — the prose
 *                quotes the line's own zeros).
 *   "recovery" — adjudication present and the engine (or plan coverage) says
 *                money is recoverable: the insurer-under-paid story.
 *   null       — no gap entry. Includes EVERY unadjudicated line: without an
 *                insurer act there is no insurer story to tell (S326 fix).
 */
export function lineGapFindingKind(
  line: LineGapLineSignals,
  claim: LineGapClaimSignals,
): "mystery" | "recovery" | null {
  if (line.coverageStatus === "not_covered") return null;
  // S326 — the gate: no insurer adjudication anywhere → no synthetic entry.
  if (!insurerAdjudicationPresent(line, claim)) return null;

  const billed = line.billedAmount || 0;
  const onEngine = line.costShareVerdict != null;
  // "mystery" quotes the line's own zeros, so it requires the LINE to state
  // them (an explicit 0, never a coerced null).
  const isMysteryGap =
    !onEngine &&
    billed > 0 &&
    line.insurancePaid === 0 &&
    line.patientOwes === 0;
  const hasRecoveryStory = onEngine
    ? line.costShareVerdict === "recovery"
    : line.hasPlanCoverage && (line.refundComponent >= 1 || line.forgivenessComponent >= 1);
  return isMysteryGap ? "mystery" : hasRecoveryStory ? "recovery" : null;
}
