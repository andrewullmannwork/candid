/**
 * ID-Block PR3b cluster-action fixture (Ship Gate G4).
 *
 * Locks the pure action×state matrix the admin POST depends on
 * (decideClusterActionEffect): confirm | clear | hold over a LIVE (shadow|held) row →
 * { newState, needsReApply, armsReEval }.
 *
 *   - confirm/clear on HELD  → re-apply the withheld promotion (needsReApply=true)
 *   - confirm/clear on SHADOW→ disposition only (needsReApply=false; already promoted)
 *   - hold (either state)    → keep current state, arm re-eval (armsReEval=true), no re-apply
 *
 * Run:
 *   cd /Users/andrewullmann/Desktop/candid
 *   npx tsx scripts/calibration/fixtures/id-block/cluster-action.fixture.ts
 *
 * Pass criteria: all cases PASS. Exit 0 on PASS, 1 on any failure.
 */

import {
  decideClusterActionEffect,
  type AdminAction,
  type QuarantineState,
} from "../../../../src/lib/parser/id-block/cluster-action";

interface Case {
  name: string;
  action: AdminAction;
  state: QuarantineState;
  expect: { newState: QuarantineState; needsReApply: boolean; armsReEval: boolean };
}

const cases: Case[] = [
  {
    name: "confirm × shadow → promoted, NO re-apply (already promoted), no re-eval",
    action: "confirm",
    state: "shadow",
    expect: { newState: "promoted", needsReApply: false, armsReEval: false },
  },
  {
    name: "confirm × held → promoted, RE-APPLY the withheld promotion, no re-eval",
    action: "confirm",
    state: "held",
    expect: { newState: "promoted", needsReApply: true, armsReEval: false },
  },
  {
    name: "clear × shadow → cleared, NO re-apply, no re-eval",
    action: "clear",
    state: "shadow",
    expect: { newState: "cleared", needsReApply: false, armsReEval: false },
  },
  {
    name: "clear × held → cleared, RE-APPLY (clear-as-benign releases the promotion), no re-eval",
    action: "clear",
    state: "held",
    expect: { newState: "cleared", needsReApply: true, armsReEval: false },
  },
  {
    name: "hold × shadow → stays shadow (no fake withholding), arms re-eval, no re-apply",
    action: "hold",
    state: "shadow",
    expect: { newState: "shadow", needsReApply: false, armsReEval: true },
  },
  {
    name: "hold × held → stays held, arms re-eval, no re-apply",
    action: "hold",
    state: "held",
    expect: { newState: "held", needsReApply: false, armsReEval: true },
  },
];

let failed = 0;
for (const c of cases) {
  let ok = false;
  let err = "";
  let got = "";
  try {
    const e = decideClusterActionEffect(c.action, c.state);
    got = JSON.stringify(e);
    ok =
      e.newState === c.expect.newState &&
      e.needsReApply === c.expect.needsReApply &&
      e.armsReEval === c.expect.armsReEval;
  } catch (e) {
    err = e instanceof Error ? e.message : String(e);
  }
  const extra = !ok && got ? `  [got ${got}]` : "";
  console.log(`${ok ? "PASS" : "FAIL"}  ${c.name}${extra}${err ? `  (threw: ${err})` : ""}`);
  if (!ok) failed++;
}
console.log(`\n${cases.length - failed}/${cases.length} passed`);
process.exit(failed === 0 ? 0 : 1);
