/**
 * case-stage — dispute-letters v2 Zone-3 (S266).
 *
 * The escalation ladder as a small state machine driving the dynamic action bar at
 * the bottom of "The case" timeline (CaseSummary). Given (status, isSent, whether a
 * next rung is available), it returns the current STAGE + the ordered action keys to
 * render — so the user always sees exactly the action(s) for where they are:
 * draft → Mark as sent → Report the result → escalate to the next rung.
 *
 * KEY RULE: `next` outranks `resolved`. denied_fully→lost and denied_partial/
 * some_covered→settled are coarse-TERMINAL statuses that still offer an escalate
 * rung (external_review / final_notice); the action bar must surface it even though
 * the coarse status is terminal (the timeline shows THIS letter closed; the action
 * starts the NEXT letter).
 *
 * Pure (no DB/clock/React) — CaseSummary and the fixture both import it. Exercised by
 * scripts/calibration/fixtures/dispute-grounds/case-stage.ts.
 */

export type CaseStage = "draft" | "awaiting" | "next" | "resolved" | "none";

export type CaseActionKey = "mark_sent" | "report_result" | "collections" | "escalate_next";

/** Coarse statuses that mean the dispute is closed (persist.ts RESOLVED_STATUSES). */
const TERMINAL_STATUSES = new Set([
  "won",
  "lost",
  "settled",
  "withdrawn",
  "won_on_escalation",
  "settled_on_escalation",
]);

export function computeCaseStage(input: {
  status: string | null;
  isSent: boolean;
  hasNextStep: boolean;
}): CaseStage {
  const { status, isSent, hasNextStep } = input;
  if (status === "cancelled") return "none"; // withdrawn-by-user; no ladder action
  const terminal = TERMINAL_STATUSES.has(status ?? "");
  if (!isSent) return terminal ? "resolved" : "draft";
  // isSent below.
  if (hasNextStep) return "next"; // escalate CTA wins even when coarse-terminal
  if (terminal) return "resolved";
  return "awaiting";
}

/**
 * Ordered action keys for a stage — first is the PRIMARY (filled) button, the rest
 * are secondary. CaseSummary maps keys → buttons wired to the page's handlers.
 */
export function stageActions(stage: CaseStage): CaseActionKey[] {
  switch (stage) {
    case "draft":
      return ["mark_sent"];
    case "awaiting":
      return ["report_result", "collections"];
    case "next":
      return ["escalate_next", "report_result", "collections"];
    case "resolved":
    case "none":
      return [];
    default: {
      const _exhaustive: never = stage;
      return _exhaustive;
    }
  }
}
