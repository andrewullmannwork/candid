/**
 * dfy-act-undo — S331. Locks undoing an operator act.
 *
 * The gap: a stray click had no remedy — none of the eleven operator acts could
 * be taken back.
 *
 * The danger in the fix is rewriting history, or appending an undo event while
 * leaving the act's OTHER writes standing — a lie in the shape of a fix. So:
 *
 *   1. EVERY operator act is undoable — a stray click always has a remedy
 *   2. undo is COMPENSATION: its own appended kind, refs-only payload; the act
 *      it corrects is never deleted
 *   3. the four acts that wrote beyond their event each declare that footprint,
 *      and each carries a confirmation saying what else will be reversed
 *   4. the seven event-only acts declare no footprint and need no confirmation
 *   5. an act cannot be undone twice, and an act with no id cannot be undone
 *   6. the copy never claims to recall something already sent
 *
 * Run: npx tsx scripts/calibration/fixtures/legal/dfy-act-undo.ts
 */
import {
  ACT_UNDO,
  ACT_UNDONE_KIND,
  canUndoAct,
  isUndoableAct,
  undoneEventIds,
  UNDO_COPY,
} from "../../../../src/lib/dfy/act-undo";
import { OPERATOR_ACT_KINDS } from "../../../../src/lib/dfy/operator-action";
import { CASE_EVENT_KINDS } from "../../../../src/lib/case/case-events";

let pass = 0, fail = 0;
function check(name: string, cond: boolean) { if (cond) pass++; else { fail++; console.error(`  ✗ ${name}`); } }

// 1 — every act has a remedy
check("every operator act is undoable",
  OPERATOR_ACT_KINDS.every((k) => isUndoableAct(k)));
check("the undo table covers exactly the operator acts",
  Object.keys(ACT_UNDO).length === OPERATOR_ACT_KINDS.length);
check("nothing else is undoable",
  !isUndoableAct("letter_sent") && !isUndoableAct("dfy_engagement_signed") && !isUndoableAct(ACT_UNDONE_KIND));

// 2 — compensation, not deletion
check("the correction has its own kind", ACT_UNDONE_KIND === "dfy_act_undone");
check("the correction kind is in the spine vocabulary",
  (CASE_EVENT_KINDS as readonly string[]).includes(ACT_UNDONE_KIND));
check("the correction kind is shape-legal for mig 221 (lowercase, ≤48)",
  /^[a-z0-9_]+$/.test(ACT_UNDONE_KIND) && ACT_UNDONE_KIND.length <= 48);
check("an undo of an undo is not offered", !isUndoableAct(ACT_UNDONE_KIND));

// 3 — the four that reached beyond their event
const FOOTPRINTED = {
  dfy_offer_relayed: "dispute_metadata",
  dfy_determination_recorded: "dispute_outcome",
  dfy_packet_prepared: "member_document",
  dfy_channel_observed: "insurer_proposal",
} as const;
for (const [kind, fp] of Object.entries(FOOTPRINTED)) {
  const spec = ACT_UNDO[kind as keyof typeof ACT_UNDO];
  check(`${kind} declares the ${fp} footprint`, spec.footprint === fp);
  check(`${kind} warns what else is reversed`, typeof spec.confirm === "string" && spec.confirm.trim().length > 0);
}
check("the packet confirm promises the document SURVIVES (archive, never delete)",
  /stays in the member's documents/.test(ACT_UNDO.dfy_packet_prepared.confirm ?? ""));
check("the packet confirm says withdrawn",
  /withdrawn/i.test(ACT_UNDO.dfy_packet_prepared.confirm ?? ""));
check("the proposal confirm says superseded — the word that table already uses",
  /superseded/i.test(ACT_UNDO.dfy_channel_observed.confirm ?? ""));
check("the determination confirm says the case reads open again",
  /open again/i.test(ACT_UNDO.dfy_determination_recorded.confirm ?? ""));

// 4 — the seven that wrote nothing but their event
const eventOnly = OPERATOR_ACT_KINDS.filter((k) => ACT_UNDO[k].footprint === "event_only");
check("exactly seven acts are event-only", eventOnly.length === 7);
check("event-only acts need no extra confirmation",
  eventOnly.every((k) => ACT_UNDO[k].confirm === null));
check("every act is either event-only or footprinted, never both",
  OPERATOR_ACT_KINDS.every((k) =>
    (ACT_UNDO[k].footprint === "event_only") === (ACT_UNDO[k].confirm === null)));

// 5 — spend-once, and only with a handle
const events = [
  { id: "e1", kind: "dfy_designation_submitted", payload: {} },
  { id: "e2", kind: "dfy_status_called", payload: {} },
  { id: "u1", kind: ACT_UNDONE_KIND, payload: { undoneEventId: "e1", undoneKind: "dfy_designation_submitted" } },
];
const undone = undoneEventIds(events);
check("the undone set reads the correction's ref", undone.has("e1") && undone.size === 1);
check("an undone act cannot be undone again",
  canUndoAct({ id: "e1", kind: "dfy_designation_submitted" }, undone) === false);
check("an untouched act can be undone",
  canUndoAct({ id: "e2", kind: "dfy_status_called" }, undone) === true);
check("an act with no id cannot be undone",
  canUndoAct({ id: null, kind: "dfy_status_called" }, undone) === false);
check("a non-act event cannot be undone",
  canUndoAct({ id: "x", kind: "letter_sent" }, undone) === false);
check("a malformed correction ref is ignored",
  undoneEventIds([{ kind: ACT_UNDONE_KIND, payload: { undoneEventId: 7 } }]).size === 0);
check("a correction with no payload is ignored",
  undoneEventIds([{ kind: ACT_UNDONE_KIND, payload: null }]).size === 0);

// 6 — the honesty constraint
check("the caution says it corrects the record",
  /corrects our record/i.test(UNDO_COPY.caution));
check("the caution admits it cannot recall a send",
  /doesn't recall it/i.test(UNDO_COPY.caution));
check("no copy claims to unsend, retract or cancel a delivered thing",
  ![UNDO_COPY.control, UNDO_COPY.caution, ...Object.values(ACT_UNDO).map((a) => a.confirm ?? "")]
    .some((t) => /\b(unsend|retract|recall it back|cancel the fax)\b/i.test(t)));
check("every refusal has copy",
  [UNDO_COPY.notHolder, UNDO_COPY.alreadyUndone, UNDO_COPY.notUndoable, UNDO_COPY.notOnMatter]
    .every((t) => typeof t === "string" && t.trim().length > 0));
check("the confirm title names the step",
  UNDO_COPY.confirmTitle("Packet prepared") === 'Undo "Packet prepared"?');

console.log(`dfy-act-undo: ${pass}/${pass + fail} checks passed`);
if (fail > 0) process.exit(1);
