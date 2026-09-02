/**
 * dfy-outcome-commit — S331. Locks the ONE home for a dispute's outcome.
 *
 * The defect this guards against: the DFY operator's "Record determination"
 * used to write a private `dispute_outcomes.metadata.dfy_determination` key in
 * its own `approved | denied | partial` vocabulary. Nothing read it — no rail
 * step, no status change, no follow-up quieting, no accuracy scoring, no
 * escalation door — so an operator-recorded determination was invisible to the
 * member AND to the flywheel. The operator now commits the SAME outcome, in the
 * SAME vocabulary, to the SAME home as the member's own report.
 *
 *   1. the operator's list is a SUBSET of the member's taxonomy — never a
 *      parallel vocabulary, and the private 3-value one is gone
 *   2. the excluded values are excluded on purpose (no_response / new_problem /
 *      collections) and every included value carries a member-facing label
 *   3. every operator determination maps to a real coarse status, and the
 *      terminal ones land on terminal statuses
 *   4. the history event is honest: `response_logged` (or the collections one),
 *      actor `operator` for the operator and `user` for the member, and the
 *      operator's event carries its engagement reference
 *   5. provenance is always written, and the undo list deletes exactly the keys
 *      the writer owns — so an undone outcome cannot strand a stale reporter
 *   6. an adverse operator determination still trips `isAdverseOutcome`, which
 *      is what opens the member's next-step (escalation) door
 *
 * Run: npx tsx scripts/calibration/fixtures/legal/dfy-outcome-commit.ts
 */
import {
  OPERATOR_DETERMINATIONS,
  isOperatorDetermination,
  OUTCOME_DETAILS,
  OUTCOME_LABELS,
  mapOutcomeToStatus,
  isAdverseOutcome,
  type OutcomeDetail,
} from "../../../../src/lib/disputes/outcome-taxonomy";
import {
  outcomeCaseEvent,
  OUTCOME_METADATA_KEYS,
} from "../../../../src/lib/disputes/commit-outcome";

let pass = 0, fail = 0;
function check(name: string, cond: boolean) { if (cond) pass++; else { fail++; console.error(`  ✗ ${name}`); } }

// 1 — a subset, not a parallel vocabulary
check("every operator determination is a member OutcomeDetail",
  OPERATOR_DETERMINATIONS.every((d) => (OUTCOME_DETAILS as readonly string[]).includes(d)));
check("the operator list has no duplicates",
  new Set(OPERATOR_DETERMINATIONS).size === OPERATOR_DETERMINATIONS.length);
check("the retired private vocabulary is rejected",
  !isOperatorDetermination("approved") && !isOperatorDetermination("denied") && !isOperatorDetermination("partial"));
check("isOperatorDetermination accepts every listed value",
  OPERATOR_DETERMINATIONS.every((d) => isOperatorDetermination(d)));
check("isOperatorDetermination refuses junk",
  !isOperatorDetermination(null) && !isOperatorDetermination(7) && !isOperatorDetermination("") && !isOperatorDetermination("resolved"));

// 2 — the exclusions are deliberate, and every option is presentable
for (const excluded of ["no_response", "new_problem", "collections"] as const) {
  check(`${excluded} is NOT an operator determination`, !isOperatorDetermination(excluded));
  check(`${excluded} is still a member outcome`, (OUTCOME_DETAILS as readonly string[]).includes(excluded));
}
check("every operator determination has a member-facing label",
  OPERATOR_DETERMINATIONS.every((d) => typeof OUTCOME_LABELS[d] === "string" && OUTCOME_LABELS[d].length > 0));

// 3 — the coarse status
const STATUSES = OPERATOR_DETERMINATIONS.map((d) => mapOutcomeToStatus(d));
check("every operator determination maps to a status", STATUSES.every((s) => typeof s === "string" && s.length > 0));
check("resolved_win → won", mapOutcomeToStatus("resolved_win") === "won");
check("denied_fully → lost", mapOutcomeToStatus("denied_fully") === "lost");
check("denied_partial → settled", mapOutcomeToStatus("denied_partial") === "settled");
check("denied_some_covered → settled", mapOutcomeToStatus("denied_some_covered") === "settled");
check("needs_info stays open (in_progress)", mapOutcomeToStatus("needs_info") === "in_progress");
check("denied_counteroffer stays open (in_progress)", mapOutcomeToStatus("denied_counteroffer") === "in_progress");

// 4 — the history event
const base = { claimId: "claim-1", disputeId: "dispute-1", status: "lost" as const };
const opEvent = outcomeCaseEvent({
  ...base,
  outcomeDetail: "denied_fully",
  reportedBy: { actor: "operator", engagementId: "eng-1", operatorUserId: "op-1" },
});
const memberEvent = outcomeCaseEvent({
  ...base,
  outcomeDetail: "denied_fully",
  reportedBy: { actor: "user" },
});
check("operator outcome event is response_logged", opEvent?.kind === "response_logged");
check("operator outcome event is actor=operator", opEvent?.actor === "operator");
check("operator outcome event carries the engagement ref", opEvent?.payload?.engagementId === "eng-1");
check("member outcome event is actor=user", memberEvent?.actor === "user");
check("member outcome event carries NO engagement ref", memberEvent?.payload?.engagementId === undefined);
check("both carry the detail and the status",
  opEvent?.payload?.outcomeDetail === "denied_fully" && opEvent?.payload?.status === "lost" &&
  memberEvent?.payload?.outcomeDetail === "denied_fully");
check("collections takes the collections kind",
  outcomeCaseEvent({ ...base, outcomeDetail: "collections", reportedBy: { actor: "user" } })?.kind === "collections_reported");
check("no claim → no event (legacy rows)",
  outcomeCaseEvent({ ...base, claimId: null, outcomeDetail: "denied_fully", reportedBy: { actor: "user" } }) === null);
check("the event references only — no prose, no amounts",
  Object.keys(opEvent?.payload ?? {}).every((k) => ["outcomeDetail", "status", "engagementId"].includes(k)));

// 5 — provenance + the undo contract
check("the writer owns exactly three metadata keys", OUTCOME_METADATA_KEYS.length === 3);
check("outcomeDetail is one of them", (OUTCOME_METADATA_KEYS as readonly string[]).includes("outcomeDetail"));
check("outcomeReportedAt is one of them", (OUTCOME_METADATA_KEYS as readonly string[]).includes("outcomeReportedAt"));
check("outcomeReportedBy is one of them — undo cannot strand a stale reporter",
  (OUTCOME_METADATA_KEYS as readonly string[]).includes("outcomeReportedBy"));

// 6 — the member's next step still opens
const adverse: OutcomeDetail[] = ["denied_fully", "denied_partial", "denied_some_covered", "denied_counteroffer"];
check("every adverse operator determination trips isAdverseOutcome",
  adverse.every((d) => isOperatorDetermination(d) && isAdverseOutcome(d)));
check("a win does not trip the escalation door", isAdverseOutcome("resolved_win") === false);
check("at least one operator determination is adverse (the door can open)",
  OPERATOR_DETERMINATIONS.some((d) => isAdverseOutcome(d)));

console.log(`dfy-outcome-commit: ${pass}/${pass + fail} checks passed`);
if (fail > 0) process.exit(1);
