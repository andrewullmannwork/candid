/**
 * outcome-taxonomy — dispute-letters v2 Zone-3 (S266) unit fixture.
 *
 * Locks the nested outcome taxonomy → coarse-status mapping + the advisory
 * next-step ladder on deterministic inputs (no DB, no clock). Guards the
 * refinement that the terminal outcomes (resolved_win / denied_partial /
 * denied_some_covered / denied_fully) MUST land in persist.ts RESOLVED_STATUSES
 * so follow-up cancellation + accuracy/outlier scoring keep firing, while the
 * open outcomes stay in_progress so follow-ups continue.
 *
 * Run:  npx tsx scripts/calibration/fixtures/dispute-grounds/outcome-taxonomy.ts
 */
import {
  OUTCOME_DETAILS,
  isAdverseOutcome,
  isOutcomeDetail,
  mapOutcomeToStatus,
  nextRungStillOpen,
  suggestNextStep,
  type OutcomeDetail,
} from "../../../../src/lib/disputes/outcome-taxonomy";

let pass = 0;
const fails: string[] = [];
function check(name: string, cond: boolean, got?: unknown) {
  if (cond) pass++;
  else fails.push(`✗ ${name}${got !== undefined ? `  (${String(got)})` : ""}`);
}

// persist.ts RESOLVED_STATUSES (terminal — cancels follow-ups + scores accuracy).
const RESOLVED = new Set(["won", "lost", "settled", "withdrawn"]);

// ── isOutcomeDetail guard ────────────────────────────────────────────────────
check("guard · accepts every union member", OUTCOME_DETAILS.every((d) => isOutcomeDetail(d)));
check("guard · rejects legacy 'won'", !isOutcomeDetail("won"));
check("guard · rejects empty", !isOutcomeDetail(""));
check("guard · rejects null", !isOutcomeDetail(null));
check("guard · rejects number", !isOutcomeDetail(3));
check("union · has 9 members", OUTCOME_DETAILS.length === 9, OUTCOME_DETAILS.length);

// ── mapOutcomeToStatus: exact coarse status per outcome ──────────────────────
const STATUS_EXPECT: Record<OutcomeDetail, string> = {
  resolved_win: "won",
  denied_partial: "settled",
  denied_some_covered: "settled",
  denied_counteroffer: "in_progress",
  denied_fully: "lost",
  needs_info: "in_progress",
  no_response: "in_progress",
  new_problem: "in_progress",
  collections: "in_progress",
};
for (const d of OUTCOME_DETAILS) {
  check(`map · ${d} → ${STATUS_EXPECT[d]}`, mapOutcomeToStatus(d) === STATUS_EXPECT[d], mapOutcomeToStatus(d));
}

// ── terminal vs open partition (the consumer-preservation guarantee) ─────────
const TERMINAL: OutcomeDetail[] = ["resolved_win", "denied_partial", "denied_some_covered", "denied_fully"];
const OPEN: OutcomeDetail[] = ["denied_counteroffer", "needs_info", "no_response", "new_problem", "collections"];
check("terminal · all in RESOLVED_STATUSES", TERMINAL.every((d) => RESOLVED.has(mapOutcomeToStatus(d))));
check("open · none in RESOLVED_STATUSES", OPEN.every((d) => !RESOLVED.has(mapOutcomeToStatus(d))));
check("open · all in_progress", OPEN.every((d) => mapOutcomeToStatus(d) === "in_progress"));

// ── suggestNextStep: INSURER track (I1 → I2) ─────────────────────────────────
check("insurer · denied_fully → external_review", suggestNextStep("insurance_appeal", "denied_fully")?.nextLetterType === "external_review");
check("insurer · denied_partial → external_review", suggestNextStep("insurance_appeal", "denied_partial")?.nextLetterType === "external_review");
check("insurer · denied_counteroffer → external_review", suggestNextStep("insurance_appeal", "denied_counteroffer")?.nextLetterType === "external_review");
check("insurer · denied_some_covered → external_review", suggestNextStep("insurance_appeal", "denied_some_covered")?.nextLetterType === "external_review");
check("insurer · external_review exhausted → null", suggestNextStep("external_review", "denied_fully") === null);
check("insurer · external_review note = exhaustion gate", suggestNextStep("insurance_appeal", "denied_fully")?.note?.includes("final internal denial") === true);

// ── suggestNextStep: PROVIDER track (R0..R2 → R3) ────────────────────────────
check("provider · overcharge denied_fully → final_notice", suggestNextStep("overcharge", "denied_fully")?.nextLetterType === "final_notice");
check("provider · balance_billing denied_partial → final_notice", suggestNextStep("balance_billing", "denied_partial")?.nextLetterType === "final_notice");
check("provider · final_notice exhausted → null", suggestNextStep("final_notice", "denied_fully") === null);

// ── suggestNextStep: collections interrupts any track → C1 ───────────────────
check("collections · from insurer → debt_validation", suggestNextStep("insurance_appeal", "collections")?.nextLetterType === "debt_validation");
check("collections · from provider → debt_validation", suggestNextStep("overcharge", "collections")?.nextLetterType === "debt_validation");

// ── suggestNextStep: terminal / record-only / no-response → null ─────────────
check("null · resolved_win", suggestNextStep("insurance_appeal", "resolved_win") === null);
check("null · needs_info", suggestNextStep("overcharge", "needs_info") === null);
check("null · new_problem", suggestNextStep("overcharge", "new_problem") === null);
check("null · no_response (Zone-2 follow-up plan owns it)", suggestNextStep("insurance_appeal", "no_response") === null);

// ── isAdverseOutcome: when a regulator door is a real option (S303) ──────────
// This replaced a LADDER-shaped proxy on the rail (stage `next`, or a resolved
// terminal rung) which was wrong at both ends — it hid the doors on a
// partially-paid escalated letter, and showed them after a WON external
// review. Being a fact about the ANSWER, it is also immune to stage changes.
check("adverse · denied_fully", isAdverseOutcome("denied_fully") === true);
check("adverse · denied_partial (the case the ladder rule HID)", isAdverseOutcome("denied_partial") === true);
check("adverse · denied_some_covered", isAdverseOutcome("denied_some_covered") === true);
check("adverse · denied_counteroffer", isAdverseOutcome("denied_counteroffer") === true);
check("adverse · collections", isAdverseOutcome("collections") === true);
check("adverse · resolved_win is NOT (the case the ladder rule SHOWED)", isAdverseOutcome("resolved_win") === false);
check("adverse · needs_info is NOT — nothing has been refused yet", isAdverseOutcome("needs_info") === false);
check("adverse · no_response is NOT — the follow-up plan owns it", isAdverseOutcome("no_response") === false);
check("adverse · new_problem is NOT — a change of subject, not a refusal", isAdverseOutcome("new_problem") === false);
// Every outcome must have an answer: the exhaustive switch is the guarantee,
// this is the proof that no member was skipped.
check(
  "adverse · exhaustive over OUTCOME_DETAILS",
  OUTCOME_DETAILS.every((d) => typeof isAdverseOutcome(d) === "boolean"),
);
// The rail shows the card at stage `next` OR on an adverse outcome. Anything
// that opens a next rung MUST also be adverse, or the two halves of that
// condition would disagree about the same letter.
check(
  "adverse · every outcome that opens a next rung is adverse",
  OUTCOME_DETAILS.filter((d) => suggestNextStep("insurance_appeal", d) != null).every(
    isAdverseOutcome,
  ),
);

// ── nextRungStillOpen: offered vs still-to-take (S303) ──────────────────────
// suggestNextStep answers "does the ladder have a rung above this one".
// That is NOT "is there one still to take", and treating them as the same
// question is the S303 defect: an escalated case never resolved, and acting on
// the stale offer INSERTED a duplicate letter (persistDisputeLetter's dedupe
// excludes resolved rows by design).
{
  const A = { disputeId: "a", letterType: "insurance_appeal", status: "lost" };
  const REVIEW_SENT = { disputeId: "b", letterType: "external_review", status: "lost" };
  const REVIEW_DRAFT = { disputeId: "b", letterType: "external_review", status: "dispute_letter_drafted" };
  const REVIEW_CANCELLED = { disputeId: "b", letterType: "external_review", status: "cancelled" };
  const open = (caseLetters: typeof A[]) =>
    nextRungStillOpen({
      disputeId: "a",
      letterType: "insurance_appeal",
      outcomeDetail: "denied_fully",
      caseLetters,
    });

  check("open · alone on the case → the rung is open", open([A])?.nextLetterType === "external_review");
  check("open · the rung already SENT → not open", open([A, REVIEW_SENT]) === null);
  check("open · the rung merely STARTED → not open (a second draft is not an escalation)", open([A, REVIEW_DRAFT]) === null);
  check("open · a WITHDRAWN letter is not a rung taken → open again", open([A, REVIEW_CANCELLED])?.nextLetterType === "external_review");
  check(
    "open · no outcome logged → nothing offered, whatever the ladder says",
    nextRungStillOpen({ disputeId: "a", letterType: "insurance_appeal", outcomeDetail: null, caseLetters: [A] }) === null,
  );
  check(
    "open · a win offers nothing even with an empty case",
    nextRungStillOpen({ disputeId: "a", letterType: "insurance_appeal", outcomeDetail: "resolved_win", caseLetters: [A] }) === null,
  );
  // Self-exclusion is load-bearing for exactly one case: collections suggests
  // debt_validation, and a debt_validation letter must not suppress itself.
  check(
    "open · a letter never suppresses its own suggestion",
    nextRungStillOpen({
      disputeId: "c",
      letterType: "debt_validation",
      outcomeDetail: "collections",
      caseLetters: [{ disputeId: "c", letterType: "debt_validation", status: "in_progress" }],
    })?.nextLetterType === "debt_validation",
  );
  // …but ANOTHER letter's debt_validation does suppress it.
  check(
    "open · a sibling of the suggested type does suppress it",
    nextRungStillOpen({
      disputeId: "c",
      letterType: "overcharge",
      outcomeDetail: "collections",
      caseLetters: [
        { disputeId: "c", letterType: "overcharge", status: "lost" },
        { disputeId: "d", letterType: "debt_validation", status: "filed" },
      ],
    }) === null,
  );
  // The invariant that keeps this a SUPPRESSION and not a second ladder: over
  // every letter type × every outcome, an empty case reproduces
  // suggestNextStep exactly, and a populated case only ever narrows it to null.
  // It can never invent a rung the taxonomy did not offer.
  const ALL_TYPES = [
    "insurance_appeal", "external_review", "overcharge", "duplicate_charge",
    "balance_billing", "itemized_request", "negotiation", "final_notice",
    "debt_validation",
  ] as const;
  check(
    "open · an empty case reproduces suggestNextStep exactly, every type × outcome",
    ALL_TYPES.every((t) =>
      OUTCOME_DETAILS.every(
        (detail) =>
          (nextRungStillOpen({ disputeId: "a", letterType: t, outcomeDetail: detail, caseLetters: [] })
            ?.nextLetterType ?? null) === (suggestNextStep(t, detail)?.nextLetterType ?? null),
      ),
    ),
  );
  check(
    "open · a populated case only ever NARROWS to null — never invents a rung",
    ALL_TYPES.every((t) =>
      OUTCOME_DETAILS.every((detail) => {
        const raw = suggestNextStep(t, detail);
        const got = nextRungStillOpen({
          disputeId: "a",
          letterType: t,
          outcomeDetail: detail,
          caseLetters: [
            { disputeId: "a", letterType: t, status: "lost" },
            { disputeId: "z", letterType: "external_review", status: "filed" },
            { disputeId: "y", letterType: "final_notice", status: "filed" },
            { disputeId: "w", letterType: "debt_validation", status: "filed" },
          ],
        });
        return got === null || got.nextLetterType === raw?.nextLetterType;
      }),
    ),
  );
}

console.log(`\noutcome-taxonomy fixture: ${pass} passed, ${fails.length} failed`);
if (fails.length) {
  console.log(fails.join("\n"));
  console.log("FAILED ✗");
  process.exit(1);
}
console.log("ALL GREEN ✓");
