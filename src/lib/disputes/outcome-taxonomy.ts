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
 * Display labels — ONE source for every surface (S299). The outcome modal's
 * options and the case rail's logged-response receipts both import from here;
 * a second copy in the rail would be the same drift class the S298
 * letter-type consolidation killed. `collections` is included so receipts on
 * a collections-outcome row render (the modal itself never offers it — it
 * routes through the dedicated "Sent to collections" entry).
 */
export const OUTCOME_LABELS: Record<OutcomeDetail, string> = {
  resolved_win: "Resolved — they approved it / paid in full",
  denied_partial: "Partially paid — less than the billed amount",
  denied_some_covered: "Covered some services, denied others",
  denied_counteroffer: "They made a counteroffer",
  denied_fully: "Fully denied — no payment",
  needs_info: "They asked for more information",
  no_response: "No response yet",
  new_problem: "A new problem came up",
  collections: "Sent to collections",
};

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

/**
 * Is this an ADVERSE answer — one where a regulator door is a real option?
 *
 * S303. The rail used to decide this from the LADDER (stage `next`, or a
 * resolved terminal rung), which is a proxy and wrong at both ends: it HID the
 * doors on a partially-paid letter the user had escalated, and it SHOWED them
 * after a WON external review — telling someone who had just won to go
 * complain about it. Whether a door is relevant is a fact about the ANSWER,
 * not about where the letter sits in its ladder.
 *
 * Adverse = they gave you a bad answer, or sent you to collections. `needs_info`
 * and `no_response` are deliberately NOT adverse: nothing has been refused yet,
 * and the deadline/follow-up machinery owns those. `new_problem` is a change of
 * subject, not a refusal.
 *
 * Exhaustive by construction — a new OutcomeDetail must declare itself here,
 * the same discipline {@link mapOutcomeToStatus} enforces.
 */
export function isAdverseOutcome(detail: OutcomeDetail): boolean {
  switch (detail) {
    case "denied_fully":
    case "denied_partial":
    case "denied_some_covered":
    case "denied_counteroffer":
    case "collections":
      return true;
    case "resolved_win":
    case "needs_info":
    case "no_response":
    case "new_problem":
      return false;
    default: {
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
/** One letter on the case, as the open-rung test needs to see it. */
export interface CaseLetterRef {
  disputeId: string;
  /** Render letter type (resolveLetterTypeFromDispute), not the raw column. */
  letterType: string;
  /** Coarse status — only `cancelled` means the rung was NOT taken. */
  status: string | null;
}

/**
 * Is there a next rung STILL TO TAKE — the one question three surfaces ask.
 *
 * {@link suggestNextStep} answers *"does the ladder have a rung above this
 * one"*. That is not the same question, and treating it as one is the S303
 * defect: on a case escalated to the end, the appeal kept offering an external
 * review that already existed, so it never reached `resolved` and the case
 * could never fold.
 *
 * ⚠ It is not only cosmetic. `persistDisputeLetter`'s dedupe deliberately
 * excludes resolved statuses ("the user may legitimately open a fresh fight
 * after a prior one closed"), so acting on the stale offer INSERTS a second
 * letter of a rung already taken — corrupting exactly the per-case aggregates
 * the flywheel reads. Hence one implementation, three callers: the projector
 * (so stages are honest), the letter page (ungated, so the offer disappears in
 * production without waiting on a flag), and the escalate gate (so a stale
 * client cannot create the row at all).
 *
 * Self-exclusion by `disputeId` is load-bearing for one real case: a
 * `debt_validation` letter whose outcome is `collections` suggests its own type.
 */
export function nextRungStillOpen(input: {
  disputeId: string;
  letterType: string;
  outcomeDetail: OutcomeDetail | null;
  /** Every letter on the CLAIM, including this one. */
  caseLetters: CaseLetterRef[];
}): NextStepSuggestion | null {
  const { disputeId, letterType, outcomeDetail, caseLetters } = input;
  if (!outcomeDetail) return null;
  const raw = suggestNextStep(letterType as DisputeLetterType, outcomeDetail);
  if (!raw) return null;
  // A withdrawn letter is not a rung taken; anything else is — including a
  // DRAFT, because starting the next letter is what moves the work there, and
  // offering it again would simply produce a second draft.
  const taken = caseLetters.some(
    (x) =>
      x.disputeId !== disputeId &&
      x.letterType === raw.nextLetterType &&
      x.status !== "cancelled",
  );
  return taken ? null : raw;
}

export function suggestNextStep(
  currentLetterType: DisputeLetterType,
  detail: OutcomeDetail,
): NextStepSuggestion | null {
  if (detail === "collections") {
    return {
      nextLetterType: "debt_validation",
      // Unified case timeline — CTA copy signals a NEW letter is created
      // (Andrew-approved strings, 2026-07-18).
      ctaLabel: "Start the next letter — debt validation",
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
      ctaLabel: "Start the next letter — external review",
      note: "Requires a final internal denial.",
    };
  }
  if (PROVIDER_LETTER_TYPES.includes(currentLetterType)) {
    if (currentLetterType === "final_notice") return null; // provider track exhausted
    return {
      nextLetterType: "final_notice",
      ctaLabel: "Start the next letter — final notice",
    };
  }
  return null;
}
