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
  isOutcomeDetail,
  mapOutcomeToStatus,
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

console.log(`\noutcome-taxonomy fixture: ${pass} passed, ${fails.length} failed`);
if (fails.length) {
  console.log(fails.join("\n"));
  console.log("FAILED ✗");
  process.exit(1);
}
console.log("ALL GREEN ✓");
