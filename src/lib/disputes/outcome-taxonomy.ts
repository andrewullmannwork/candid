/**
 * outcome-taxonomy — dispute-letters v2 Zone-3 (S266).
 *
 * The S260 escalation redesign replaced the ~4 flat outcomes
 * (won/lost/settled/won_on_escalation) with a nested, response-driven taxonomy:
 * the user reports WHAT HAPPENED when they heard back, and we (a) map it onto
 * the existing coarse `dispute_outcomes.status` column so every downstream
 * consumer (metrics, accuracy, follow-up cancellation, CaseSummary rendering)
 * keeps working, and (b) suggest the next rung — USER-TRIGGERED, never
 * auto-advanced (the auto-advance state machine is post-launch, tracker M).
 *
 * PURE MODULE — no DB, no clock, no server-only imports (only erased `import
 * type`s), so BOTH the client modal (OutcomeReportingModal) and the server
 * route (/api/disputes/outcome) import it as the single source of truth for the
 * mapping. Exercised by scripts/calibration/fixtures/dispute-grounds/outcome-taxonomy.ts.
 */
import type { DisputeStatus } from "./persist";
import type { DisputeLetterType } from "@/lib/billing/types";

/**
 * What the user reports after they hear back (or don't). Persisted verbatim to
 * `dispute_outcomes.metadata.outcomeDetail` (JSONB — Rule #9 store-first). The
 * coarse `status` column is DERIVED from this via {@link mapOutcomeToStatus}.
 * `collections` is captured through the dedicated "Sent to collections" entry
 * (→ debt_validation / C1), not the outcome modal, but is included here so the
 * union + next-step map stay exhaustive.
 */
export type OutcomeDetail =
  | "resolved_win" // approved / paid in full → terminal win
  | "denied_partial" // partial payment (< billed) → terminal settle
  | "denied_some_covered" // some services covered, others denied → terminal settle
  | "denied_counteroffer" // they proposed a lower figure → open negotiation
  | "denied_fully" // fully denied, no payment → terminal loss (this round)
  | "needs_info" // they asked for more information → open
  | "no_response" // nothing back yet → open (Zone-2 follow-up plan drives it)
  | "new_problem" // a new issue surfaced → open
  | "collections"; // sent to collections → interrupt to debt_validation (C1)

export const OUTCOME_DETAILS: readonly OutcomeDetail[] = [
  "resolved_win",
  "denied_partial",
  "denied_some_covered",
  "denied_counteroffer",
  "denied_fully",
  "needs_info",
  "no_response",
  "new_problem",
  "collections",
] as const;

export function isOutcomeDetail(v: unknown): v is OutcomeDetail {
  return typeof v === "string" && (OUTCOME_DETAILS as readonly string[]).includes(v);
}

/**
 * Coarse status for the existing `dispute_outcomes.status` column.
 *
 * TERMINAL (won/lost/settled — in persist.ts RESOLVED_STATUSES → cancels pending
 * follow-ups + runs outlier/accuracy scoring): resolved_win, denied_partial,
 * denied_some_covered, denied_fully. OPEN (in_progress — follow-ups continue):
 * denied_counteroffer, needs_info, no_response, new_problem, collections.
 *
 * NOTE: `resolved_win` maps to `won`; the route promotes it to
 * `won_on_escalation` when the user supplies the alternative code the insurer
 * reprocessed under (preserves the S74.6 D5 recoding/peer-vote path).
 */
export function mapOutcomeToStatus(detail: OutcomeDetail): DisputeStatus {
  switch (detail) {
    case "resolved_win":
      return "won";
    case "denied_partial":
    case "denied_some_covered":
      return "settled";
    case "denied_fully":
      return "lost";
    case "denied_counteroffer":
    case "needs_info":
    case "no_response":
    case "new_problem":
    case "collections":
      return "in_progress";
    default: {
      // Exhaustiveness guard — a new OutcomeDetail must declare its status here.
      const _exhaustive: never = detail;
      return _exhaustive;
    }
  }
}

/** Advisory next-rung suggestion — the user chooses whether to act on it. */
export interface NextStepSuggestion {
  nextLetterType: DisputeLetterType;
  ctaLabel: string;
  /** Optional gate/caveat surfaced with the CTA (e.g. exhaustion requirement). */
  note?: string;
}

const PROVIDER_LETTER_TYPES: readonly DisputeLetterType[] = [
  "overcharge",
  "duplicate_charge",
  "balance_billing",
  "itemized_request",
  "negotiation",
  "final_notice",
];
const INSURER_LETTER_TYPES: readonly DisputeLetterType[] = [
  "insurance_appeal",
  "external_review",
];

/**
 * The next USER-TRIGGERED rung for a given (current letter, outcome). Advisory
 * only — no write, no auto-create (scope fence: no auto-advance state machine).
 * Returns null when there's no further letter (terminal win, record-only
 * outcomes, no-response [Zone-2 follow-up plan owns it], or a track already
 * exhausted → the lawyer marketplace / complaint checklist takes over).
 *
 * Ladder (map §2): INSURER I1(insurance_appeal) → I2(external_review); PROVIDER
 * R0..R2 → R3(final_notice); collections interrupts any track → C1(debt_validation).
 */
export function suggestNextStep(
  currentLetterType: DisputeLetterType,
  detail: OutcomeDetail,
): NextStepSuggestion | null {
  if (detail === "collections") {
    return {
      nextLetterType: "debt_validation",
      ctaLabel: "Send a debt-validation letter",
      note: "FDCPA §1692g — strongest within 30 days of first contact.",
    };
  }
  // Terminal win + record-only + no-response → no escalation letter.
  if (
    detail === "resolved_win" ||
    detail === "needs_info" ||
    detail === "new_problem" ||
    detail === "no_response"
  ) {
    return null;
  }
  // denied_* → escalate on the current track (user-triggered).
  if (INSURER_LETTER_TYPES.includes(currentLetterType)) {
    if (currentLetterType === "external_review") return null; // insurer track exhausted
    return {
      nextLetterType: "external_review",
      ctaLabel: "Request an external review",
      note: "Requires a final internal denial.",
    };
  }
  if (PROVIDER_LETTER_TYPES.includes(currentLetterType)) {
    if (currentLetterType === "final_notice") return null; // provider track exhausted
    return {
      nextLetterType: "final_notice",
      ctaLabel: "Send a final escalation notice",
    };
  }
  return null;
}
