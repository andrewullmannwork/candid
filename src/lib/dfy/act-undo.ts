/**
 * act-undo — undoing an operator act (S331).
 *
 * A stray click had no remedy: none of the eleven operator acts could be taken
 * back. This module is the ONE description of what undoing each one means.
 *
 * THE MODEL IS COMPENSATION, NEVER DELETION. `claim_case_events` is the case's
 * history authority (mig 221); history is not rewritten because someone
 * mis-clicked. Undo APPENDS a `dfy_act_undone` event referring to the act it
 * corrects, exactly as the member's own `letter_unsent` and `outcome_undone`
 * corrections do. The member's timeline therefore shows both the step and its
 * correction, which is the honest record.
 *
 * NO MIGRATION: `claim_case_events.kind` is shape-checked, not enumerated (mig
 * 221 says so in as many words) — the vocabulary lives in `case-events.ts`.
 *
 * THE FOOTPRINTS DIFFER, and that is the whole difficulty. Seven acts wrote
 * nothing but their event and compensate cleanly. Four reached further, and an
 * undo that appended an event while leaving those writes standing would be a
 * lie in the shape of a fix:
 *
 *   · the relayed offer sits on the dispute row's metadata
 *   · the determination is now a real OUTCOME (status + outcomeDetail +
 *     provenance + quieted follow-ups) — undone through the member's OWN undo
 *     path, never a second writer
 *   · the prepared packet is a PDF in the member's own documents — WITHDRAWN,
 *     never deleted (their document, and archive-before-delete)
 *   · the channel observation queued an insurer proposal — SUPERSEDED, which is
 *     already a status that table understands
 *
 * HONESTY CONSTRAINT: undo corrects OUR RECORD. It cannot recall a fax that has
 * already gone. Every string below says so, and none of them may imply
 * otherwise.
 */
import type { OperatorActKind } from "./operator-action";

/** What an undo has to reverse beyond appending its own event. */
export type UndoFootprint =
  | "event_only"
  | "dispute_metadata"
  | "dispute_outcome"
  | "member_document"
  | "insurer_proposal";

export interface ActUndoSpec {
  footprint: UndoFootprint;
  /**
   * The extra sentence shown before undoing, for acts that reversed more than
   * a record. Null where the act wrote nothing but its own event.
   */
  confirm: string | null;
}

export const ACT_UNDO: Readonly<Record<OperatorActKind, ActUndoSpec>> = {
  dfy_designation_submitted: { footprint: "event_only", confirm: null },
  dfy_designation_acknowledged: { footprint: "event_only", confirm: null },
  dfy_document_requested: { footprint: "event_only", confirm: null },
  dfy_appeal_transmitted: { footprint: "event_only", confirm: null },
  dfy_status_called: { footprint: "event_only", confirm: null },
  dfy_response_recorded: { footprint: "event_only", confirm: null },
  dfy_audit_logged: { footprint: "event_only", confirm: null },
  dfy_offer_relayed: {
    footprint: "dispute_metadata",
    confirm: "The offer we recorded on this letter will be removed.",
  },
  dfy_determination_recorded: {
    footprint: "dispute_outcome",
    confirm:
      "The result on the member's claim will be cleared and the case will read as open again.",
  },
  dfy_packet_prepared: {
    footprint: "member_document",
    confirm:
      "The packet stays in the member's documents, marked withdrawn. Their timeline will show this step was undone.",
  },
  dfy_channel_observed: {
    footprint: "insurer_proposal",
    confirm: "The change we proposed for this insurer will be marked superseded.",
  },
};

/** Every operator act can be undone — a stray click always has a remedy. */
export function isUndoableAct(kind: string): kind is OperatorActKind {
  return kind in ACT_UNDO;
}

/** The compensating event's kind. One kind, refs in the payload. */
export const ACT_UNDONE_KIND = "dfy_act_undone" as const;

export const UNDO_COPY = {
  /** The control on a logged step. */
  control: "Undo this step",
  /** Always shown beside it — undo corrects the record, it does not recall a send. */
  caution: "Corrects our record. If we already sent something, this doesn't recall it.",
  /** Heading for the confirm, e.g. Undo "Packet prepared"? */
  confirmTitle: (label: string): string => `Undo "${label}"?`,
  notHolder: "Only the operator holding this matter can undo its steps.",
  alreadyUndone: "That step has already been undone.",
  notUndoable: "That isn't a step this matter can undo.",
  notOnMatter: "That step is not on this matter.",
} as const;

/**
 * Which act events have already been undone, from the event list alone — PURE,
 * so the operator screen and the server agree without a second query.
 *
 * An undo event carries `payload.undoneEventId`; anything it names is spent.
 */
export function undoneEventIds(
  events: ReadonlyArray<{ kind: string; payload?: Record<string, unknown> | null }>,
): ReadonlySet<string> {
  const out = new Set<string>();
  for (const e of events) {
    if (e.kind !== ACT_UNDONE_KIND) continue;
    const ref = (e.payload ?? {}).undoneEventId;
    if (typeof ref === "string" && ref.length > 0) out.add(ref);
  }
  return out;
}

/** Can this specific logged act be undone right now? PURE. */
export function canUndoAct(
  event: { id?: string | null; kind: string },
  undone: ReadonlySet<string>,
): boolean {
  if (!event.id) return false;
  if (!isUndoableAct(event.kind)) return false;
  return !undone.has(event.id);
}
