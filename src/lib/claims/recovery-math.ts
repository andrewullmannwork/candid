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

import { resolveCoverageForLine, isInsurerDenied, type CoverageDecision } from "./coverage-decision";

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
  /**
   * Cost-Share v2 (S214) — optional richer service terms, carried through the
   * coverage cascade (exact → secondary → ACA) for `computeCostShareV2`.
   * Legacy/audit consumers ignore them. ACA-synthesized coverage sets
   * `deductibleApplies=false` (preventive is deductible-exempt by law).
   */
  deductibleApplies?: boolean | null;
  outCopay?: number | null;
  outCoinsurance?: number | null;
  outDeductibleApplies?: boolean | null;
  oonPaidAtInNetwork?: boolean | null;
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
  /**
   * S140 — cite-grade provenance. Populated by /api/claims/[claimId] when
   * the per-line map runs through `resolvePerLinePatientPaid`. Signals
   * whether `patientPaid` / `patientResponsibility` were cite-grade
   * per-line reads or synthesized from claim-header pro-rate. Consumers
   * without this check default to today's cite-grade-assumed behavior
   * (computeRecoveryV2 itself does NOT populate this — keeps the helper
   * pure; the route layer attaches it after).
   */
  provenance?: {
    patientPaidSource: "per_line" | "header_prorated";
    patientResponsibilitySource: "per_line" | "header_prorated";
    /** false when ANY input was synthesized — gates per-line LineDrawer
     *  recovery strip + per-line dispute letter citations. */
    isCitablePerLine: boolean;
  };
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
  /**
   * Cost-Share v2 (S214) — when provided, the refund/forgiveness split uses
   * this plan-derived shouldOwe instead of computeShouldOwe (the deductible-
   * blind path). `undefined` on every legacy / flag-OFF caller, so the
   * recovery_cost_share_v2 OFF path is byte-identical to today.
   */
  shouldOweOverride?: number;
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
  const shouldOwe =
    args.shouldOweOverride !== undefined
      ? Math.max(0, args.shouldOweOverride)
      : computeShouldOwe({
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

// ============================================================================
// Cost-Share v2 (S214) — network / deductible / OOP-phase-aware recovery engine.
//
// `computeShouldOwe` above is DEDUCTIBLE-BLIND (covered / copay / coinsurance
// only). `computeCostShareV2` derives the patient's CORRECT share from the PLAN
// TERMS, phase-aware (network → not-covered → OOP-met → copay-exempt →
// deductible → coinsurance → straddle), then checks BOTH the provider charge AND
// the insurer's adjudication against that plan-derived truth. The plan is the
// arbiter — never the insurer (Decision 3). Two non-negotiable invariants:
//   1. Conservative-when-blind: with no met-status data, shouldOwe defaults to
//      the FULL allowed (the max the patient could owe), NEVER 0. This is the
//      anti-false-positive fix (the old bug coalesced unknown coverage to 0,
//      which fabricated overpayments — e.g. the cf91a49e $221 false dispute).
//   2. No silent assumptions: every value we had to guess that is load-bearing
//      on the result is surfaced in `assumptions[]` (the editable banner +
//      flywheel calibration). A confident insurer-error is only asserted from
//      HARD met-status data, never a conservative guess (Decision 3 / Q1).
//
// Gated behind `recovery_cost_share_v2` at the route layer. OFF never calls this
// (shouldOweOverride stays undefined) → byte-identical to today.
// ============================================================================

export type NetworkTier = "in_network" | "out_of_network" | "tiered" | "unknown";
/** §5 verdict headlines: V0 confident · V1 correct · V2 recovery · V3 not_covered · V4 insufficient. */
export type CostShareVerdict =
  | "confident"
  | "correct"
  | "recovery"
  | "not_covered"
  | "insufficient";
/** tier1 = insurer member breakdown present (cross-checked vs plan); tier2 = plan-only re-derive. */
export type CostShareTier = "tier1_reconcile" | "tier2_rederive";
export type CostSharePhase =
  | "not_covered"
  | "oop_met"
  | "copay_exempt"
  | "deductible_unmet"
  | "post_deductible"
  | "straddle"
  | "conservative_unknown"
  | "no_charge";

/** Per-service plan terms (extends PlanCoverageInput with deductible-applies + OON variants). */
export interface ServiceCostShare {
  covered: boolean | null;
  /** in-network per-visit copay $. */
  copay: number | null;
  /** in-network coinsurance, decimal fraction 0-1. */
  coinsurance: number | null;
  /** does this service apply to the deductible? null → inferred (copay-only → exempt; else subject). */
  deductibleApplies: boolean | null;
  outCopay?: number | null;
  outCoinsurance?: number | null;
  outDeductibleApplies?: boolean | null;
  /** plan pays OON at in-network rates for this service → use in-network params even when OON. */
  oonPaidAtInNetwork?: boolean | null;
}

/** Plan-level phase params (from insurance_plans). Coinsurance is decimal 0-1. */
export interface PlanCostShareParams {
  inDeductibleIndividual: number | null;
  inDeductibleFamily: number | null;
  outDeductibleIndividual: number | null;
  outDeductibleFamily: number | null;
  inOopMaxIndividual: number | null;
  inOopMaxFamily: number | null;
  outOopMaxIndividual: number | null;
  outOopMaxFamily: number | null;
  inCoinsuranceDefault: number | null;
  outCoinsuranceDefault: number | null;
  deductibleCalcMethod: "embedded" | "aggregate" | null;
  combinedMedicalRxOop: boolean | null;
  coverageTier: string | null;
}

/** The relevant accumulator snapshot for this line's network / type / grain (resolved upstream). */
export interface AccumulatorSnapshot {
  deductibleApplied: number | null;
  deductibleMax: number | null;
  oopApplied: number | null;
  oopMax: number | null;
}

/** The insurer's per-line member breakdown — a CHECKED input, never the source of truth. */
export interface InsurerAdjudication {
  memberAppliedToDeductible: number | null;
  memberCoinsurance: number | null;
  memberCopay: number | null;
  deniedAmount: number | null;
  insurancePaid: number | null;
}

export interface CostShareOverrides {
  deductibleMet: boolean | null;
  deductibleMetAsOf: string | null;
  oopMet: boolean | null;
  oopMetAsOf: string | null;
  userNetworkOverride: "in_network" | "out_of_network" | null;
}

export interface CostShareAssumption {
  field:
    | "network"
    | "deductible_met"
    | "oop_met"
    | "deductible_applies"
    | "service_cost"
    | "denial"
    | "aca_preventive";
  /** the value we assumed, e.g. "not_met", "in_network", "subject". */
  assumed: string;
  /** dollar value behind it when known (e.g. the $7,050 deductible); null → banner shows "add …". */
  value: number | null;
  correctable: boolean;
  /** why we assumed (no_accumulator / no_override / no_plan_value / default / insurer_denied). */
  reason: string;
}

/** Insurer-vs-plan reconciliation (Decision 3) — only populated from HARD met-status data. */
export interface InsurerDiscrepancy {
  planDerivedShare: number;
  insurerAssignedShare: number;
  /** positive = insurer assigned the patient MORE than the plan says (insurer error). */
  delta: number;
}

export interface CostShareV2Result extends RecoveryMetrics {
  verdict: CostShareVerdict;
  tier: CostShareTier;
  phase: CostSharePhase;
  networkUsed: NetworkTier;
  insurerDiscrepancy: InsurerDiscrepancy | null;
  assumptions: CostShareAssumption[];
  /**
   * §18 incr-4 — whether `shouldOwe` rests on KNOWN facts (hard met-status data, a
   * known cost-share rate, or the insurer-$0 pure-deductible proof) vs a load-bearing
   * GUESS. This is the engine's own honesty gate (the verdict already trusts it at the
   * `!shouldOweGrounded → "insufficient"` branch). Exposed so the dispute letter can
   * OMIT the precise deductible-aware dollar when it would rest on an assumption
   * (§18.10.D / Evidence Disclosure Rule). NOT the whole gate — a `network` assumption
   * can still mask an OON line while this is true; see `isPreciseDollarAssertable`.
   */
  shouldOweGrounded: boolean;
  /** amount of `allowed` that went toward the deductible on this line (for cross-line threading). */
  deductibleConsumed: number;
  /**
   * R3 step 4 — the shared coverage decision (planStance × insurerAdjudication × derivedStatus)
   * this result was computed against, SURFACED (the engine already computed it internally) for the
   * dispute route layer + the POST-R3 classifier collapse. Additive; the card reads
   * shouldOwe/verdict/phase, not this → byte-identical.
   */
  coverageDecision: CoverageDecision;
}

export interface ComputeCostShareV2Args {
  line: {
    billed: number;
    /** plan-allowed amount. null → derived from billed − insuranceAdjusted − providerAdjusted. */
    allowed: number | null;
    insuranceAdjusted?: number;
    providerAdjusted?: number;
    patientPaid: number;
    patientResponsibility: number;
  };
  service: ServiceCostShare | null;
  insurer: InsurerAdjudication;
  plan: PlanCostShareParams;
  accumulator: AccumulatorSnapshot | null;
  overrides: CostShareOverrides;
  networkLine: NetworkTier | null;
  networkClaim: NetworkTier | null;
  /** minimum recoverable $ to assert a dispute (flag-config-backed; default 1). */
  minRecovery?: number;
  /**
   * Cost-Share v2 (W1) — per-line preventive signal, resolved INDEPENDENT of the plan's
   * is_aca_compliant flag (zero_cost_share_codes membership). Preventive care is deductible-
   * exempt; `confirmed` ACA → free $0 (federal mandate, wins over a parsed copay row);
   * `unknown` → conservative full-allowed but verdict forced `insufficient` + an `aca_preventive`
   * assumption (ask, never full-allowed-`correct` on care that's often free); `non_aca` → not
   * mandated free, falls through to the normal cost-share path.
   */
  preventive?: { isPreventive: boolean; acaStatus: "confirmed" | "unknown" | "non_aca" } | null;
  /**
   * Cost-Share v2 (W1) — true when the insurer paid $0 on the WHOLE claim
   * (`claims.total_insurance_paid === 0`). This is the claim-level "you're genuinely
   * pre-deductible" corroboration that lets a full-allowed deductible result be `correct`
   * instead of `insufficient`, used when the per-line `insurer.insurancePaid` is NULL (the
   * common header-only-EOB case — e.g. cf91a49e). A per-line insurer-$0, when present, is
   * honored directly and takes precedence.
   */
  claimInsurerPaidZero?: boolean;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const num = (n: number | null | undefined): number | null =>
  n == null || Number.isNaN(n) ? null : n;

/**
 * Patient cost-share for the allowed amount in a post-deductible / copay-exempt
 * phase. Returns {share, unknown}. unknown=true when NEITHER copay nor
 * coinsurance is known AND there is no positive 100%-coverage evidence — the
 * caller then defaults to the conservative FULL allowed, never a fabricated $0.
 * (in_coinsurance is only ~38% populated in PROD, so "covered + null/null" is
 * common and usually means "data missing", not "plan pays 100%".)
 */
function resolveServiceShare(
  allowed: number,
  copay: number | null,
  coinsurance: number | null,
  isHdhpFull: boolean,
): { share: number; unknown: boolean } {
  if (copay != null && copay > 0) return { share: round2(Math.min(copay, allowed)), unknown: false };
  if (coinsurance != null && coinsurance > 0) return { share: round2(allowed * coinsurance), unknown: false };
  if (copay === 0 || coinsurance === 0) return { share: 0, unknown: false }; // explicit $0 / 0% = positive zero
  if (isHdhpFull) return { share: 0, unknown: false }; // deductible==oop_max → no coinsurance phase, plan pays 100%
  return { share: allowed, unknown: true }; // unknown rate → conservative full allowed
}

const EMPTY_INSURER: InsurerAdjudication = {
  memberAppliedToDeductible: null,
  memberCoinsurance: null,
  memberCopay: null,
  deniedAmount: null,
  insurancePaid: null,
};

/**
 * Family-tier detection — shared by the engine's param selection AND the route's
 * accumulator-key (isIndividual) so the two never drift. Anything that isn't
 * blank / "individual" / "self" is treated as a family tier (conservative).
 */
export function isFamilyTier(coverageTier: string | null): boolean {
  const t = (coverageTier ?? "").toLowerCase();
  return t !== "" && t !== "individual" && t !== "self";
}

/**
 * The pure per-line cost-share engine. Inputs are already resolved by the route
 * (allowed/adjusted prorated, accumulator matched to this line's network/type).
 * For cross-line deductible threading within a claim, use computeClaimCostShareV2.
 */
export function computeCostShareV2(args: ComputeCostShareV2Args): CostShareV2Result {
  const minRec = args.minRecovery ?? 1;
  const service = args.service;
  const insurer = args.insurer ?? EMPTY_INSURER;
  // R2 (S242) — the ONE shared coverage decision for this line. The card reads its
  // planStance (phase/verdict) and insurer-denied projection from here instead of
  // re-deriving `service.covered` / `deniedAmount` inline; byte-identical (see
  // coverage-decision-parity.ts). planStance and insurerAdjudication stay separate.
  const coverageDecision = resolveCoverageForLine(service, insurer);
  const plan = args.plan;
  const acc = args.accumulator;
  const ov = args.overrides;
  const assumptions: CostShareAssumption[] = [];
  // W1 preventive: deductible-exempt; ACA-confirmed → free, ACA-unknown → ask (never
  // full-allowed-`correct`). `non_aca` is treated as a normal (non-preventive) service.
  const prev = args.preventive;
  const isPreventiveService = prev?.isPreventive === true && prev.acaStatus !== "non_aca";
  const prevAca = prev?.acaStatus ?? "unknown";

  // ── 1. Network resolution (user override › line › claim › default in-network) ──
  const networkAssumed = !ov.userNetworkOverride && !args.networkLine && !args.networkClaim;
  const networkUsed: NetworkTier =
    ov.userNetworkOverride ?? args.networkLine ?? args.networkClaim ?? "in_network";
  // oon-paid-at-in-network services use in-network params even when OON.
  const useOutParams =
    networkUsed === "out_of_network" && !(service?.oonPaidAtInNetwork === true);

  // ── 2. Allowed amount (line.allowed › billed − adjustments) ──
  const insuranceAdjusted = args.line.insuranceAdjusted ?? 0;
  const providerAdjusted = args.line.providerAdjusted ?? 0;
  const allowed =
    num(args.line.allowed) ??
    Math.max(0, args.line.billed - insuranceAdjusted - providerAdjusted);

  // ── No-charge guard ────────────────────────────────────────────────────────
  // A $0-billed line is not a charge: nothing can be overcharged, so there is no
  // cost-share question to answer. Resolve it trivially (confident, owe $0) so a
  // zero-charge reporting code (CPT Category II, zero-charge HCPCS) never drags
  // the bill-level verdict to `insufficient`. Keyed on the BILLED amount ONLY — a
  // real charge the insurer zero-paid (e.g. pre-deductible HDHP, cf91a49e $221)
  // is billed > 0 and flows through the phase machine unchanged.
  if (args.line.billed <= 0) {
    return {
      ...computeRecoveryV2({
        billed: args.line.billed,
        patientResponsibility: args.line.patientResponsibility,
        patientPaid: args.line.patientPaid,
        insuranceAdjusted,
        providerAdjusted,
        planCoverage: null,
        shouldOweOverride: 0,
      }),
      shouldOwe: 0,
      verdict: "confident",
      tier: "tier2_rederive",
      phase: "no_charge",
      networkUsed,
      insurerDiscrepancy: null,
      assumptions: [],
      shouldOweGrounded: true,
      deductibleConsumed: 0,
      coverageDecision,
    };
  }

  // ── 3. Param selection by network × individual/family ──
  const isFamily = isFamilyTier(plan.coverageTier);
  const pick = (indIn: number | null, famIn: number | null, indOut: number | null, famOut: number | null) => {
    const v = useOutParams ? (isFamily ? famOut : indOut) : isFamily ? famIn : indIn;
    if (v != null) return v;
    // family figure missing → fall back to the individual figure (conservative).
    return useOutParams ? indOut : indIn;
  };
  const deductibleMax = pick(
    plan.inDeductibleIndividual, plan.inDeductibleFamily,
    plan.outDeductibleIndividual, plan.outDeductibleFamily,
  );
  const oopMax = pick(
    plan.inOopMaxIndividual, plan.inOopMaxFamily,
    plan.outOopMaxIndividual, plan.outOopMaxFamily,
  );
  const copay = useOutParams ? num(service?.outCopay) ?? num(service?.copay) : num(service?.copay);
  const coinsurance = useOutParams
    ? num(service?.outCoinsurance) ?? num(service?.coinsurance) ?? num(plan.outCoinsuranceDefault)
    : num(service?.coinsurance) ?? num(plan.inCoinsuranceDefault);
  const svcDeductibleApplies = useOutParams
    ? service?.outDeductibleApplies ?? service?.deductibleApplies
    : service?.deductibleApplies;

  // ── 4. Met-status (hard data = accumulator or user override; else conservative not-met) ──
  // A plan with a $0 deductible has nothing to meet → the deductible is trivially MET
  // (KNOWN, not assumed). Without this, a $0-deductible plan with no accumulator falls to
  // the conservative "not met" path and charges the FULL allowed toward a non-existent
  // deductible (e.g. a 10%-coinsurance service billed at full allowed instead of 10%).
  // `deductibleMax` is null when unparsed (pick() returns the null individual figure), so
  // `=== 0` matches only a genuinely-zero deductible, never "unknown".
  const planDeductibleZero = deductibleMax === 0;
  const accDedKnown = num(acc?.deductibleApplied) != null && num(acc?.deductibleMax) != null;
  const accOopKnown = num(acc?.oopApplied) != null && num(acc?.oopMax) != null;
  const dedMetKnown = ov.deductibleMet != null || accDedKnown || planDeductibleZero;
  const oopMetKnown = ov.oopMet != null || accOopKnown;
  const dedMet =
    ov.deductibleMet === true || (accDedKnown && acc!.deductibleApplied! >= acc!.deductibleMax!) || planDeductibleZero;
  const oopMet = ov.oopMet === true || (accOopKnown && acc!.oopApplied! >= acc!.oopMax!);
  const remainingDeductible = accDedKnown
    ? Math.max(0, acc!.deductibleMax! - acc!.deductibleApplied!)
    : planDeductibleZero
      ? 0
      : null;
  const remainingOop = accOopKnown ? Math.max(0, acc!.oopMax! - acc!.oopApplied!) : null;

  // ── 5. Phase machine → plan-derived shouldOwe ──
  // HDHP-full = deductible == oop-max → no coinsurance phase → post-deductible is
  // genuinely $0 (positive evidence), distinct from "we don't know the rate".
  const isHdhpFull = deductibleMax != null && oopMax != null && deductibleMax === oopMax;
  let phase: CostSharePhase;
  let shouldOwe: number;
  let deductibleConsumed = 0;
  let costShareUnknown = false;
  let preventiveAcaUnknown = false;

  if (networkAssumed) {
    assumptions.push({ field: "network", assumed: "in_network", value: null, correctable: true, reason: "default" });
  }

  if (coverageDecision.planStance === "not_covered") {
    phase = "not_covered";
    shouldOwe = allowed;
  } else if (isPreventiveService) {
    // Preventive (zero_cost_share_codes member) is deductible-exempt. ACA-confirmed → free $0
    // (federal mandate; wins over a parsed copay). ACA-unknown → prefer a CONFIDENT plan
    // cost-share if we have one (plan is the source of truth, §13.1); else conservative
    // full-allowed + ask the ACA question (care that's often free is never full-allowed-`correct`).
    phase = "copay_exempt";
    if (prevAca === "confirmed") {
      shouldOwe = 0;
    } else {
      const r = resolveServiceShare(allowed, copay, coinsurance, false);
      shouldOwe = r.share;
      if (r.unknown) {
        preventiveAcaUnknown = true;
        assumptions.push({
          field: "aca_preventive",
          assumed: "unknown",
          value: null,
          correctable: true,
          reason: "aca_status_unknown",
        });
      }
    }
    if (remainingOop != null) shouldOwe = Math.min(shouldOwe, remainingOop);
  } else {
    // resolve deductible-applies (infer when the plan didn't say).
    let dedApplies = svcDeductibleApplies;
    if (dedApplies == null) {
      dedApplies = !(copay != null && copay > 0 && (coinsurance == null || coinsurance === 0));
      assumptions.push({
        field: "deductible_applies",
        assumed: dedApplies ? "subject" : "exempt",
        value: null,
        correctable: true,
        reason: "no_plan_value",
      });
    }

    if (oopMet) {
      phase = "oop_met";
      shouldOwe = 0;
    } else if (dedApplies === false) {
      // copay-exempt: copay/coinsurance regardless of the deductible (no HDHP-$0
      // shortcut — it's exempt, not post-deductible).
      phase = "copay_exempt";
      const r = resolveServiceShare(allowed, copay, coinsurance, false);
      shouldOwe = r.share;
      costShareUnknown = costShareUnknown || r.unknown;
      if (remainingOop != null) shouldOwe = Math.min(shouldOwe, remainingOop);
    } else if (!dedMet) {
      // deductible-subject, not met → toward deductible.
      if (!dedMetKnown) {
        assumptions.push({
          field: "deductible_met",
          assumed: "not_met",
          value: deductibleMax,
          correctable: true,
          reason: acc == null ? "no_accumulator" : "no_override",
        });
      }
      if (remainingDeductible != null && remainingDeductible < allowed) {
        // straddle: fill remaining deductible (100%), then coinsurance on the rest.
        phase = "straddle";
        const rest = allowed - remainingDeductible;
        let restShare: number;
        if (coinsurance != null && coinsurance > 0) restShare = coinsurance * rest;
        else if (coinsurance === 0 || isHdhpFull) restShare = 0; // explicit 0% / HDHP → post-deductible $0
        else { restShare = rest; costShareUnknown = true; } // unknown rate → conservative full
        shouldOwe = round2(remainingDeductible + restShare);
        deductibleConsumed = remainingDeductible;
        if (remainingOop != null) shouldOwe = Math.min(shouldOwe, remainingOop);
      } else {
        phase = "deductible_unmet";
        shouldOwe = remainingOop != null ? Math.min(allowed, remainingOop) : allowed;
        deductibleConsumed = shouldOwe;
      }
    } else {
      // deductible met, OOP not met → copay / coinsurance (HDHP-$0; else conservative).
      phase = "post_deductible";
      const r = resolveServiceShare(allowed, copay, coinsurance, isHdhpFull);
      shouldOwe = r.share;
      costShareUnknown = costShareUnknown || r.unknown;
      if (remainingOop != null) shouldOwe = Math.min(shouldOwe, remainingOop);
    }

    // oop-met assumption only where OOP can actually bind (deductible met / copay-exempt) and it's unknown.
    if (!oopMetKnown && (phase === "post_deductible" || phase === "straddle" || phase === "copay_exempt")) {
      assumptions.push({
        field: "oop_met",
        assumed: "not_hit",
        value: oopMax,
        correctable: true,
        reason: acc == null ? "no_accumulator" : "no_override",
      });
    }
  }

  shouldOwe = round2(Math.max(0, shouldOwe));

  // service-cost disclosure: no per-service terms, OR a phase needed a copay/
  // coinsurance rate we don't have → shouldOwe defaulted to the conservative full
  // allowed (never a fabricated $0). Drives §7b "add plan details".
  // Service-cost gap (§5 D1): we can't determine THIS service's share when there's no usable
  // rate — no copay AND no coinsurance, where `copay`/`coinsurance` are the RESOLVED values
  // (the plan-default coinsurance is already folded into `coinsurance` above, so plans that
  // carry a default don't false-fire). A row that says "covered" but carries no cost-share
  // VALUE (a low-confidence SBC parse that captured coverage but missed e.g. a deductible-
  // exempt copay) still counts as unknown — so the bill offers "Add plan details" instead of
  // silently owing the full allowed and hiding a recovery. Not-covered is a KNOWN share (owe
  // full) → excluded. Backstop only; the root cure is richer plan-doc extraction (cold-start).
  const serviceCostUnknown =
    service == null ||
    (coverageDecision.planStance !== "not_covered" && copay == null && coinsurance == null);
  if ((serviceCostUnknown || costShareUnknown) && phase !== "not_covered" && !isPreventiveService) {
    assumptions.push({ field: "service_cost", assumed: "unknown", value: null, correctable: true, reason: "no_plan_value" });
  }

  // denial: never rubber-stamped as owed (Decision 3 / Q4) — surfaced as appealable.
  const denied = isInsurerDenied(coverageDecision);
  if (denied) {
    assumptions.push({ field: "denial", assumed: "denied", value: insurer.deniedAmount, correctable: true, reason: "insurer_denied" });
  }

  // ── 6. Recovery split — reuse computeRecoveryV2 with the plan-derived shouldOwe ──
  const base = computeRecoveryV2({
    billed: args.line.billed,
    patientResponsibility: args.line.patientResponsibility,
    patientPaid: args.line.patientPaid,
    insuranceAdjusted,
    providerAdjusted,
    planCoverage: null,
    shouldOweOverride: shouldOwe,
  });

  // ── 7. Insurer reconciliation (Decision 3) — only from HARD met-status data (Q1) ──
  const hasInsurerBreakdown =
    num(insurer.memberAppliedToDeductible) != null ||
    num(insurer.memberCoinsurance) != null ||
    num(insurer.memberCopay) != null;
  const tier: CostShareTier = hasInsurerBreakdown ? "tier1_reconcile" : "tier2_rederive";
  let insurerDiscrepancy: InsurerDiscrepancy | null = null;
  if (hasInsurerBreakdown && (dedMetKnown || oopMetKnown)) {
    const insurerAssigned = round2(
      (num(insurer.memberAppliedToDeductible) ?? 0) +
        (num(insurer.memberCoinsurance) ?? 0) +
        (num(insurer.memberCopay) ?? 0),
    );
    const delta = round2(insurerAssigned - shouldOwe);
    if (Math.abs(delta) >= minRec) {
      insurerDiscrepancy = { planDerivedShare: shouldOwe, insurerAssignedShare: insurerAssigned, delta };
    }
  }

  // ── 8. Verdict — honesty gate (§13.2): never "correct" off a guessed shouldOwe ──
  // shouldOwe is GROUNDED only when it rests on known facts, not assumptions:
  //  • a copay/coinsurance phase with a KNOWN rate (costShareUnknown=false), or
  //  • oop-met $0 (accumulator-known), or
  //  • a deductible phase we KNOW you're in — HARD met-status (accumulator/override), OR the
  //    insurer paid $0 (proof you're pre-deductible) AND the charge fits entirely under the
  //    deductible (pure-deductible, no coinsurance phase to guess).
  // An ungrounded shouldOwe → `insufficient` ("we can't fully check"), NEVER `correct`. The
  // conservative dollar math is unchanged (full-allowed), so no false dispute is fabricated;
  // we only refuse to *label* a guess as correct — which invites the user to confirm and can
  // surface a hidden refund. (This subsumes the old `noDefensibleBasis` short-circuit.)
  // pre-deductible corroboration: a real per-line insurer-$0 (precise), or — when the per-line
  // signal is absent (header-only EOB, the common case) — the insurer paid $0 on the whole claim.
  const insurerPaidZero =
    num(insurer.insurancePaid) === 0 ||
    (num(insurer.insurancePaid) == null && args.claimInsurerPaidZero === true);
  let shouldOweGrounded: boolean;
  if (phase === "oop_met" || phase === "not_covered") {
    shouldOweGrounded = true;
  } else if (phase === "copay_exempt" || phase === "post_deductible") {
    shouldOweGrounded = !costShareUnknown;
  } else if (phase === "deductible_unmet" || phase === "straddle") {
    shouldOweGrounded = dedMetKnown
      ? !costShareUnknown
      : insurerPaidZero && deductibleMax != null && allowed <= deductibleMax && !costShareUnknown;
  } else {
    shouldOweGrounded = false;
  }

  // recovery wins over not-covered (Q2); denial never "correct" (Q4); preventive-ACA-unknown
  // always asks (care that's often free must not be rubber-stamped by the insurer-$0 signal).
  let verdict: CostShareVerdict;
  if (base.potentialRecovery >= minRec) verdict = "recovery";
  else if (denied) verdict = "insufficient";
  else if (coverageDecision.planStance === "not_covered") verdict = "not_covered";
  else if (preventiveAcaUnknown) verdict = "insufficient";
  else if (!shouldOweGrounded) verdict = "insufficient";
  else if (assumptions.length > 0) verdict = "correct";
  else verdict = "confident";

  return {
    ...base,
    shouldOwe,
    verdict,
    tier,
    phase,
    networkUsed,
    insurerDiscrepancy,
    assumptions,
    shouldOweGrounded,
    deductibleConsumed: round2(deductibleConsumed),
    coverageDecision,
  };
}

export interface ClaimLineInput {
  billed: number;
  allowed: number | null;
  insuranceAdjusted?: number;
  providerAdjusted?: number;
  patientPaid: number;
  patientResponsibility: number;
  service: ServiceCostShare | null;
  insurer: InsurerAdjudication;
  networkLine: NetworkTier | null;
  preventive?: { isPreventive: boolean; acaStatus: "confirmed" | "unknown" | "non_aca" } | null;
}

export interface ComputeClaimCostShareV2Args {
  lines: ClaimLineInput[];
  plan: PlanCostShareParams;
  /** the claim's PRE-claim accumulator snapshot (shared across lines; resolved upstream). */
  accumulator: AccumulatorSnapshot | null;
  overrides: CostShareOverrides;
  networkClaim: NetworkTier | null;
  minRecovery?: number;
  claimInsurerPaidZero?: boolean;
}

export interface ClaimCostShareV2Result {
  lines: CostShareV2Result[];
  verdict: CostShareVerdict;
  totalShouldOwe: number;
  totalPotentialRecovery: number;
}

/**
 * Claim-level wrapper — runs each line through the engine against the claim's
 * shared accumulator snapshot, then rolls per-line verdicts up to a bill-level
 * verdict + totals (the §5 banner is per-bill).
 *
 * v1 is CONSERVATIVE: each line is computed INDEPENDENTLY against the same
 * snapshot — NO cross-line deductible threading. Independent computation
 * over-states shouldOwe on a multi-line straddle (every line sees the full
 * remaining deductible), which under-states recovery — the false-positive-safe
 * direction. Accurate cross-line allocation only ever surfaces MORE recovery, so
 * it is a deferred refinement gated on pinning accumulator pre/post-claim
 * semantics (the engine's `deductibleConsumed` output is the hook for it).
 */
/**
 * Cost-Share v2 — bill-level verdict precedence (§5 "one banner per bill").
 * Single source of truth: both computeClaimCostShareV2 and the claims route's
 * per-line emit roll up through THIS, so the bill headline can never drift from
 * the engine. Precedence: any recovery → any insufficient → any not_covered →
 * any correct → else confident.
 */
export function rollupCostShareVerdict(
  verdicts: CostShareVerdict[],
): CostShareVerdict {
  const has = (v: CostShareVerdict) => verdicts.includes(v);
  return has("recovery")
    ? "recovery"
    : has("insufficient")
      ? "insufficient"
      : has("not_covered")
        ? "not_covered"
        : has("correct")
          ? "correct"
          : "confident";
}

export function computeClaimCostShareV2(args: ComputeClaimCostShareV2Args): ClaimCostShareV2Result {
  const results = args.lines.map((line) =>
    computeCostShareV2({
      line,
      service: line.service,
      insurer: line.insurer,
      plan: args.plan,
      accumulator: args.accumulator,
      overrides: args.overrides,
      networkLine: line.networkLine,
      networkClaim: args.networkClaim,
      minRecovery: args.minRecovery,
      preventive: line.preventive,
      claimInsurerPaidZero: args.claimInsurerPaidZero,
    }),
  );

  const verdict = rollupCostShareVerdict(results.map((r) => r.verdict));

  return {
    lines: results,
    verdict,
    totalShouldOwe: round2(results.reduce((s, r) => s + r.shouldOwe, 0)),
    totalPotentialRecovery: round2(results.reduce((s, r) => s + r.potentialRecovery, 0)),
  };
}
