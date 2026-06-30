/**
 * R2 (S242) — the shared coverage DECISION layer (charter Layer 2). A pure
 * function that BOTH the claim card (recovery-math `computeCostShareV2`) and the
 * dispute letter (evidence-resolver `buildPlanBenefitFromRow`) call, so the
 * plan-coverage stance can never drift between the two surfaces. This extends the
 * §18.9 lesson — "the letter sources from the card's engine" — from the dollar to
 * the coverage decision.
 *
 * `planStance` and `insurerAdjudication` are KEPT SEPARATE on purpose. The
 * bread-and-butter `coverage_contradiction` dispute is exactly
 * planStance="covered" AND the insurer denied/underpaid — a single collapsed
 * status field would destroy it. See [[unified_dispute_claim_engine_plan]] §0 #4.
 *
 * R2-core is a byte-identical refactor: each consumer reads this decision through a
 * legacy projection that reproduces its prior inline logic exactly (proven in
 * `coverage-decision-parity.ts`). The richer axes feed the new grounds at R3.
 */

/** Does the PLAN cover this service? Sourced from the coverage row's `covered`. */
export type PlanStance = "covered" | "not_covered" | "unknown";

/**
 * What the INSURER did with this line — a PAYMENT outcome, NOT a coverage
 * judgment. Sourced from the line's adjudicated paid/denied dollars.
 *
 * NB for R3 (`coverage_contradiction`): "none" is NOT a contradiction on its own —
 * a covered line fully applied to the deductible reads "none" by paid/denied yet is
 * legitimately owed. The contradiction detector must additionally consult member
 * responsibility (memberAppliedToDeductible/coinsurance/copay), never paid/denied
 * alone. The decision's `insurerAdjudication` may also be `null` = NOT EVALUATED
 * (no adjudication input was supplied — e.g. the letter's row-mapper, which has no
 * claim line in scope), which is distinct from "none" = evaluated, insurer paid $0
 * and denied $0.
 */
export type InsurerAdjudicationStatus = "paid" | "denied" | "partial" | "none";

/**
 * Per-service coverage rules fed into the decision. R2-core sources only `covered`;
 * the condition axes stay null until the cold-start coverage-completion lane lands
 * `requires_referral` / `visit_limit` / `annual_limit` in the dispute coverage read
 * (`prior_auth_required` is plan-display-only today, not in that read).
 */
export interface CoverageStanceInput {
  covered: boolean | null;
  priorAuthRequired?: boolean | null;
  referralRequired?: boolean | null;
  visitLimit?: number | null;
  annualLimit?: number | null;
}

/** The insurer's per-line money outcome — a subset of recovery-math's `InsurerAdjudication`. */
export interface InsurerAdjudicationInput {
  deniedAmount: number | null;
  insurancePaid: number | null;
}

export interface CoverageConditions {
  priorAuthRequired: boolean | null;
  referralRequired: boolean | null;
  visitLimit: number | null;
  annualLimit: number | null;
}

/**
 * The combined planStance × insurerAdjudication headline (R3 step 4 — the R2 carry-forward
 * deferred from R2, where the letter row-mapper had no insurer axis to merge). `contradiction` =
 * planStance "covered" AND the insurer denied/underpaid — the bread-and-butter dispute.
 * `covered_owed` is the GUARD's safe state: covered + "none" (fully applied to the deductible /
 * pending) is legitimately owed, NOT a contradiction. `unevaluated` = no insurer axis supplied
 * (the letter row-mapper, by construction); `indeterminate` = planStance unknown.
 */
export type DerivedCoverageStatus =
  | "contradiction"
  | "covered_paid"
  | "covered_owed"
  | "consistent_denial"
  | "anomalous_payment"
  | "unevaluated"
  | "indeterminate";

export interface CoverageDecision {
  planStance: PlanStance;
  /** null = not evaluated (no adjudication input); see InsurerAdjudicationStatus. */
  insurerAdjudication: InsurerAdjudicationStatus | null;
  /** the combined headline (R3 step 4); derived from the two axes above. See DerivedCoverageStatus. */
  derivedStatus: DerivedCoverageStatus;
  conditions: CoverageConditions;
  /** the raw inputs each axis was derived from (per-axis provenance). */
  provenance: {
    planStance: { covered: boolean | null };
    insurerAdjudication: { deniedAmount: number | null; insurancePaid: number | null } | null;
  };
}

/**
 * Mirrors recovery-math's `(num(x) ?? 0)` coercion exactly: a finite number passes
 * through, null/undefined/NaN collapse to 0. Keeps `isInsurerDenied` below
 * byte-identical to the card's prior `(num(insurer.deniedAmount) ?? 0) > 0`.
 */
const fin = (n: number | null | undefined): number => (n == null || Number.isNaN(n) ? 0 : n);

/**
 * Combine the two axes into the headline (R3 step 4). Null insurer axis → "unevaluated" (the
 * letter row-mapper). The GUARD lives here: covered + "none" → "covered_owed" (deductible /
 * pending, legitimately owed), NEVER "contradiction" — only an actual denial (denied/partial) on
 * a covered line is a contradiction. Never reads paid/denied alone (see the type doc above).
 */
function deriveStatus(
  planStance: PlanStance,
  insurerAdjudication: InsurerAdjudicationStatus | null,
): DerivedCoverageStatus {
  if (insurerAdjudication === null) return "unevaluated";
  if (planStance === "unknown") return "indeterminate";
  if (planStance === "covered") {
    if (insurerAdjudication === "denied" || insurerAdjudication === "partial") return "contradiction";
    return insurerAdjudication === "paid" ? "covered_paid" : "covered_owed"; // none → owed (the guard)
  }
  // not_covered
  return insurerAdjudication === "paid" ? "anomalous_payment" : "consistent_denial"; // denied/partial/none
}

/**
 * The pure shared coverage decision. R2-core signature is 2-arg; the per-`line`
 * context (charge date for the time-of-charge plan at D3; usage accumulators at the
 * visit/annual grounds) joins in a later increment.
 *
 * Byte-identity contracts (proven in `coverage-decision-parity.ts`):
 *  - card phase/verdict `service?.covered === false` ⟺ planStance === "not_covered"
 *  - card `denied = (num(deniedAmount) ?? 0) > 0`     ⟺ isInsurerDenied(decision)
 *  - letter `row.covered !== false`                   ⟺ planStance !== "not_covered"
 */
export function resolveCoverageForLine(
  coverage: CoverageStanceInput | null,
  insurer: InsurerAdjudicationInput | null,
): CoverageDecision {
  const covered = coverage?.covered ?? null;
  const planStance: PlanStance =
    covered === false ? "not_covered" : covered === true ? "covered" : "unknown";

  let insurerAdjudication: InsurerAdjudicationStatus | null;
  if (insurer == null) {
    insurerAdjudication = null;
  } else {
    const denied = fin(insurer.deniedAmount);
    const paid = fin(insurer.insurancePaid);
    insurerAdjudication =
      denied > 0 ? (paid > 0 ? "partial" : "denied") : paid > 0 ? "paid" : "none";
  }

  return {
    planStance,
    insurerAdjudication,
    derivedStatus: deriveStatus(planStance, insurerAdjudication),
    conditions: {
      priorAuthRequired: coverage?.priorAuthRequired ?? null,
      referralRequired: coverage?.referralRequired ?? null,
      visitLimit: coverage?.visitLimit ?? null,
      annualLimit: coverage?.annualLimit ?? null,
    },
    provenance: {
      planStance: { covered },
      insurerAdjudication:
        insurer == null
          ? null
          : {
              deniedAmount: insurer.deniedAmount ?? null,
              insurancePaid: insurer.insurancePaid ?? null,
            },
    },
  };
}

/**
 * The card's legacy `denied` projection — byte-identical to the prior inline
 * `(num(insurer.deniedAmount) ?? 0) > 0`: true exactly when the insurer denied any
 * dollars (status "denied" OR "partial"). A null (not-evaluated) axis → false.
 */
export function isInsurerDenied(decision: CoverageDecision): boolean {
  return decision.insurerAdjudication === "denied" || decision.insurerAdjudication === "partial";
}

/**
 * The bread-and-butter dispute: the plan COVERS the service AND the insurer denied/underpaid it.
 * Equivalent to `derivedStatus === "contradiction"`. The "none" guard is STRUCTURAL — a covered
 * line fully applied to the deductible reads "none" (legitimately owed) and is never flagged.
 * Net-new in R3 step 4; the live consumer is the POST-R3 classifier collapse (none today).
 */
export function detectCoverageContradiction(decision: CoverageDecision): boolean {
  return decision.derivedStatus === "contradiction";
}
