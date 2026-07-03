/**
 * case-stage — dispute-letters v2 Zone-3 (S266) unit fixture.
 *
 * Locks the case-timeline action-bar state machine. Guards the key rule that `next`
 * outranks `resolved` (a coarse-terminal denial still surfaces the escalate CTA) and
 * that a cancelled dispute shows no action.
 *
 * Run:  npx tsx scripts/calibration/fixtures/dispute-grounds/case-stage.ts
 */
import { computeCaseStage, stageActions } from "../../../../src/lib/disputes/case-stage";

let pass = 0;
const fails: string[] = [];
function check(name: string, cond: boolean, got?: unknown) {
  if (cond) pass++;
  else fails.push(`✗ ${name}${got !== undefined ? `  (${String(got)})` : ""}`);
}
const eq = (a: unknown[], b: unknown[]) => JSON.stringify(a) === JSON.stringify(b);

// ── stage: draft (not sent) ──────────────────────────────────────────────────
check("draft · drafted, not sent", computeCaseStage({ status: "dispute_letter_drafted", isSent: false, hasNextStep: false }) === "draft");
check("draft · null status, not sent", computeCaseStage({ status: null, isSent: false, hasNextStep: false }) === "draft");

// ── stage: cancelled → none ──────────────────────────────────────────────────
check("none · cancelled (not sent)", computeCaseStage({ status: "cancelled", isSent: false, hasNextStep: false }) === "none");
check("none · cancelled (sent)", computeCaseStage({ status: "cancelled", isSent: true, hasNextStep: false }) === "none");
check("none · cancelled ignores hasNextStep", computeCaseStage({ status: "cancelled", isSent: true, hasNextStep: true }) === "none");

// ── stage: awaiting (sent, no outcome yet) ───────────────────────────────────
check("awaiting · sent, filed, no next", computeCaseStage({ status: "filed", isSent: true, hasNextStep: false }) === "awaiting");
check("awaiting · sent, in_progress, no next", computeCaseStage({ status: "in_progress", isSent: true, hasNextStep: false }) === "awaiting");

// ── stage: next (escalate CTA) — outranks resolved ───────────────────────────
check("next · denied_fully → lost BUT hasNextStep → next (not resolved)", computeCaseStage({ status: "lost", isSent: true, hasNextStep: true }) === "next");
check("next · denied_partial → settled BUT hasNextStep → next", computeCaseStage({ status: "settled", isSent: true, hasNextStep: true }) === "next");
check("next · awaiting-status with a next step → next", computeCaseStage({ status: "in_progress", isSent: true, hasNextStep: true }) === "next");

// ── stage: resolved (terminal, no next) ──────────────────────────────────────
check("resolved · won, no next", computeCaseStage({ status: "won", isSent: true, hasNextStep: false }) === "resolved");
check("resolved · won_on_escalation, no next", computeCaseStage({ status: "won_on_escalation", isSent: true, hasNextStep: false }) === "resolved");
check("resolved · lost, track exhausted (no next)", computeCaseStage({ status: "lost", isSent: true, hasNextStep: false }) === "resolved");
check("resolved · terminal even if somehow not sent", computeCaseStage({ status: "settled", isSent: false, hasNextStep: false }) === "resolved");

// ── stageActions mapping ─────────────────────────────────────────────────────
check("actions · draft = [mark_sent]", eq(stageActions("draft"), ["mark_sent"]));
check("actions · awaiting = [report_result, collections]", eq(stageActions("awaiting"), ["report_result", "collections"]));
check("actions · next = [escalate_next, report_result, collections]", eq(stageActions("next"), ["escalate_next", "report_result", "collections"]));
check("actions · next primary is escalate_next", stageActions("next")[0] === "escalate_next");
check("actions · resolved = []", eq(stageActions("resolved"), []));
check("actions · none = []", eq(stageActions("none"), []));

console.log(`\ncase-stage fixture: ${pass} passed, ${fails.length} failed`);
if (fails.length) {
  console.log(fails.join("\n"));
  console.log("FAILED ✗");
  process.exit(1);
}
console.log("ALL GREEN ✓");
