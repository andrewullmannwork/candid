/**
 * dfy-execution-lock — S331. Locks the NARROWNESS of the member hold.
 *
 * The gap it closes: nothing stopped a member marking their appeal sent, or
 * redrafting it, while an operator was submitting the same letter as their
 * authorized representative — two submissions from one person.
 *
 * The danger in the fix is the opposite one: a hold that is too WIDE deadlocks
 * the lane. So most of this fixture is about what must stay OPEN.
 *
 *   1. the hold is keyed on exactly the statuses that grant an operator
 *      authority to act — one list, so member-hold and operator-grant can
 *      never drift apart
 *   2. it holds ONLY while a matter is actively being executed: a signed or
 *      pending matter is not being executed, and a closed one is over
 *   3. no engagement at all → nothing is ever held (the common case)
 *   4. only `send` and `redraft` are held actions — composition and the
 *      state-level filing are NOT, because the lane blocks on the first and
 *      the service shape requires the second
 *   5. the hold is NOT a readiness blocker (nothing is "missing") and NOT a
 *      letter-access reason (that gate also runs at generate time, which would
 *      block composition)
 *   6. every held action has member-facing copy, and the copy never tells the
 *      member to go and fix something
 *
 * Run: npx tsx scripts/calibration/fixtures/legal/dfy-execution-lock.ts
 */
import {
  dfyExecutionHeld,
  dfyExecutionHoldResponse,
  DFY_EXECUTION_HOLD_CODE,
  DFY_EXECUTION_HOLD_MESSAGE,
  DFY_EXECUTION_HOLD_PANEL,
  type HeldMemberAction,
} from "../../../../src/lib/dfy/execution-lock";
import {
  ACTIONABLE_STATUSES,
  ENGAGEMENT_STATUSES,
  TERMINAL_STATUSES,
} from "../../../../src/lib/dfy/engagement-state";
import { GATE_LABELS } from "../../../../src/lib/dfy/intake-gates";

let pass = 0, fail = 0;
function check(name: string, cond: boolean) { if (cond) pass++; else { fail++; console.error(`  ✗ ${name}`); } }

// 1 — one list for the member's hold and the operator's grant
check("held exactly over the operator-actionable statuses",
  ENGAGEMENT_STATUSES.every((st) => dfyExecutionHeld(st) === ACTIONABLE_STATUSES.includes(st)));
check("the actionable set is exactly ['active']",
  JSON.stringify([...ACTIONABLE_STATUSES]) === JSON.stringify(["active"]));

// 2 — only while actually executing
check("an ACTIVE matter holds the member", dfyExecutionHeld("active") === true);
check("a SIGNED matter does NOT hold — nothing is being executed yet",
  dfyExecutionHeld("signed") === false);
check("a PENDING matter does NOT hold", dfyExecutionHeld("eligibility_pending") === false);
for (const st of ENGAGEMENT_STATUSES.filter((x) => TERMINAL_STATUSES.has(x))) {
  check(`a ${st} matter does NOT hold — it is over`, dfyExecutionHeld(st) === false);
}

// 3 — the common case: no engagement, nothing held
check("no engagement → not held (null)", dfyExecutionHeld(null) === false);
check("no engagement → not held (undefined)", dfyExecutionHeld(undefined) === false);

// 4 — the hold is NARROW: what stays open is the point
const HELD: HeldMemberAction[] = ["send", "redraft"];
check("exactly two actions are held", Object.keys(DFY_EXECUTION_HOLD_MESSAGE).length === 2);
check("send is held", HELD.includes("send") && typeof DFY_EXECUTION_HOLD_MESSAGE.send === "string");
check("redraft is held", HELD.includes("redraft") && typeof DFY_EXECUTION_HOLD_MESSAGE.redraft === "string");
for (const open of ["compose", "adopt", "escalate", "file_state_level", "log_outcome", "undo_outcome"]) {
  check(`${open} is NOT a held action`, !(open in DFY_EXECUTION_HOLD_MESSAGE));
}
// The two that would deadlock the lane, named against the gates that require them.
check("Gate 0 (execution-only) exists — composition is the member's, so it cannot be held",
  typeof GATE_LABELS["0"] === "string" && GATE_LABELS["0"].length > 0);
check("Gate 4 (member-files split) exists — state-level filing is the member's, so it cannot be held",
  typeof GATE_LABELS["4"] === "string" && GATE_LABELS["4"].includes("member-files"));

// 5 — it is its own axis, not smuggled into a neighbouring gate
check("the hold code is its own code", DFY_EXECUTION_HOLD_CODE === "dfy_execution_hold");
check("the hold code is not a readiness blocker name",
  !["backed_claim", "recipient_address", "patient_identity"].includes(DFY_EXECUTION_HOLD_CODE));
check("the hold code is not a letter-access reason",
  !["litigation_hold", "geo_unavailable", "subscription_required"].includes(DFY_EXECUTION_HOLD_CODE));

// 6 — the response shape and the copy
for (const a of HELD) {
  const r = dfyExecutionHoldResponse(a);
  check(`${a} responds with the hold code`, r.error === DFY_EXECUTION_HOLD_CODE);
  check(`${a} responds with its own reason`, r.reason === DFY_EXECUTION_HOLD_MESSAGE[a]);
  check(`${a} copy names Candid as the one handling it`, /Candid is handling this letter/.test(r.reason));
  // A hold is not a to-do: it must never read like the send gate's "go fix this".
  check(`${a} copy does not ask the member to fix anything`,
    !/still missing|add it|not ready|you need to/i.test(r.reason));
}
check("the two reasons differ (send ≠ redraft)",
  DFY_EXECUTION_HOLD_MESSAGE.send !== DFY_EXECUTION_HOLD_MESSAGE.redraft);
check("the panel names the representative relationship",
  /authorized representative/.test(DFY_EXECUTION_HOLD_PANEL.body));
check("the panel promises the timeline",
  /timeline/.test(DFY_EXECUTION_HOLD_PANEL.body));
check("the panel has a title and a body",
  DFY_EXECUTION_HOLD_PANEL.title.trim().length > 0 && DFY_EXECUTION_HOLD_PANEL.body.trim().length > 0);

console.log(`dfy-execution-lock: ${pass}/${pass + fail} checks passed`);
if (fail > 0) process.exit(1);
