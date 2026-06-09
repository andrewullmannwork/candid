/**
 * ID-Block PR3c re-eval-action fixture (Ship Gate G4).
 *
 * Locks the pure disposition matrix the daily re-eval cron depends on
 * (decideReEvalAction): given (clusterGone, wouldFlag, applyReason) → { newState,
 * reschedule, slackRelease, machineReason, writeFailed }.
 *
 * The ONLY transition to 'promoted' is (gate cleared AND the real promote mechanism
 * applied it for the SAME tuple). Every other branch stays held + reschedules — never
 * auto-rejects (delayed-not-denied, Pattern 1 #13).
 *
 * Run:
 *   cd /Users/andrewullmann/Desktop/candid
 *   npx tsx scripts/calibration/fixtures/id-block/reeval-action.fixture.ts
 *
 * Pass criteria: all cases PASS. Exit 0 on PASS, 1 on any failure.
 */

import {
  decideReEvalAction,
  type ReEvalActionInput,
  type ReEvalAction,
} from "../../../../src/lib/parser/id-block/reeval-decision";

interface Case {
  name: string;
  input: ReEvalActionInput;
  expect: ReEvalAction;
}

const held = (machineReason: string, writeFailed = false): ReEvalAction => ({
  newState: "held",
  reschedule: true,
  slackRelease: false,
  machineReason,
  writeFailed,
});

const cases: Case[] = [
  {
    name: "cluster gone (gate returned null) → stay held, reschedule",
    input: { clusterGone: true, wouldFlag: false },
    expect: held("cluster_gone"),
  },
  {
    name: "still flagged (wouldFlag) → stay held, reschedule (no apply attempted)",
    input: { clusterGone: false, wouldFlag: true },
    expect: held("still_flagged"),
  },
  {
    name: "cleared + applied → RELEASE (promoted, no reschedule, slack, re_eval_cleared)",
    input: { clusterGone: false, wouldFlag: false, applyReason: "promoted" },
    expect: {
      newState: "promoted",
      reschedule: false,
      slackRelease: true,
      machineReason: "re_eval_cleared",
      writeFailed: false,
    },
  },
  {
    name: "cleared but verify-the-write failed → stay held, writeFailed (log loud)",
    input: { clusterGone: false, wouldFlag: false, applyReason: "write_failed" },
    expect: held("write_failed", true),
  },
  {
    name: "cleared but Layer-4 active → stay held (defer), reschedule",
    input: { clusterGone: false, wouldFlag: false, applyReason: "deferred_layer4" },
    expect: held("deferred_layer4"),
  },
  {
    name: "cleared but consensus drifted → stay held (never promote an un-gated value)",
    input: { clusterGone: false, wouldFlag: false, applyReason: "tuple_drifted" },
    expect: held("tuple_drifted"),
  },
  {
    name: "cleared but Layer-3 no longer promotes → stay held, reschedule",
    input: { clusterGone: false, wouldFlag: false, applyReason: "criteria_not_met" },
    expect: held("criteria_not_met"),
  },
  {
    name: "cleared but no user-side uploads (cluster gone @ Layer-3) → stay held",
    input: { clusterGone: false, wouldFlag: false, applyReason: "no_inputs" },
    expect: held("no_inputs"),
  },
  {
    name: "cleared but doc-type invalid → stay held",
    input: { clusterGone: false, wouldFlag: false, applyReason: "invalid_doc_type" },
    expect: held("invalid_doc_type"),
  },
  {
    name: "defensive: gate cleared but applyReason missing → stay held (never release without an apply)",
    input: { clusterGone: false, wouldFlag: false },
    expect: held("missing_apply_reason"),
  },
];

let failed = 0;
for (const c of cases) {
  let ok = false;
  let err = "";
  let got = "";
  try {
    const a = decideReEvalAction(c.input);
    got = JSON.stringify(a);
    ok =
      a.newState === c.expect.newState &&
      a.reschedule === c.expect.reschedule &&
      a.slackRelease === c.expect.slackRelease &&
      a.machineReason === c.expect.machineReason &&
      a.writeFailed === c.expect.writeFailed;
  } catch (e) {
    err = e instanceof Error ? e.message : String(e);
  }
  const extra = !ok && got ? `  [got ${got}]` : "";
  console.log(`${ok ? "PASS" : "FAIL"}  ${c.name}${extra}${err ? `  (threw: ${err})` : ""}`);
  if (!ok) failed++;
}
console.log(`\n${cases.length - failed}/${cases.length} passed`);
process.exit(failed === 0 ? 0 : 1);
