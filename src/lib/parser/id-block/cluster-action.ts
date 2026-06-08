/**
 * ID-Block PR3b — pure per-cluster admin-action effect (Ship Gate G4).
 *
 * Maps an admin verdict (confirm | clear | hold) over a quarantine row's CURRENT
 * state to the resulting state + whether the WITHHELD doc-type promotion must be
 * RE-APPLIED. Pure + fixture-locked so the load-bearing "what does Confirm do to a
 * held vs a shadow row" matrix is testable, not buried in route glue.
 *
 * Semantics (SoT §4.3 + S175 design pass):
 *   - A 'shadow' row was NEVER withheld — the canonical already has the value — so
 *     Confirm/Clear are a DISPOSITION only (record the verdict; NO re-apply).
 *   - A 'held' row had its doc-type promotion WITHHELD (active mode). Confirm AND
 *     Clear RELEASE it (re-apply the promotion via the proper CF-40 mechanism); they
 *     differ only in the recorded verdict — Confirm = admin vetted the cluster real;
 *     Clear = the flag was deemed benign/false-positive — both mean "let it promote"
 *     (the two verdicts are distinct calibration signals for the threshold).
 *   - Hold keeps the CURRENT state (shadow stays shadow; held stays held), records
 *     the verdict, and arms re-eval (next_eval_at → the PR3c cron). It NEVER fakes a
 *     withholding by escalating a shadow row to held.
 *
 * There is deliberately NO reject/delete action: a confirmed-fraud cluster simply
 * stays 'held' (the promotion never applies; the user keeps their own data —
 * Pattern 1 #13). Disposed rows ('promoted' | 'cleared') are terminal; the route
 * treats a repeat action on a disposed row as an idempotent no-op (IO layer).
 *
 * SoT: plans/id-block-corroboration-source-independence.md §4.3.
 */

export type AdminAction = "confirm" | "clear" | "hold";
export type QuarantineState = "shadow" | "held" | "cleared" | "promoted";

export interface ClusterActionEffect {
  /** the state to write to the quarantine row. */
  newState: QuarantineState;
  /**
   * re-apply the WITHHELD doc-type promotion via the CF-40 promote mechanism
   * (apply-confirmed-promotion.ts). Only true for a held row released by
   * confirm/clear — a shadow row was already promoted, so there is nothing to apply.
   */
  needsReApply: boolean;
  /** set next_eval_at so the PR3c re-eval cron re-checks the row (Hold only). */
  armsReEval: boolean;
}

/**
 * Decide the effect of an admin action on a LIVE (shadow|held) quarantine row. Pure.
 * The caller guarantees `currentState` is a live state (disposed rows short-circuit
 * to an idempotent no-op upstream).
 */
export function decideClusterActionEffect(
  action: AdminAction,
  currentState: QuarantineState,
): ClusterActionEffect {
  const held = currentState === "held";
  switch (action) {
    case "confirm":
      // real → promote. Held: release the withheld promotion. Shadow: disposition only.
      return { newState: "promoted", needsReApply: held, armsReEval: false };
    case "clear":
      // flag benign → also promote (the gate was the only thing blocking it). Held:
      // release. Shadow: disposition only.
      return { newState: "cleared", needsReApply: held, armsReEval: false };
    case "hold":
      // not yet — keep the current live state (never escalate shadow→held), arm re-eval.
      return { newState: currentState, needsReApply: false, armsReEval: true };
  }
}
