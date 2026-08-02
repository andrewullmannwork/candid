/**
 * prior-contact — THE ONE prior-contact recital (S300, tracker Item N).
 *
 * A letter's contact history is one fact with one owner. Before this module it
 * had two: the Final Notice template rendered a `priorContactDates` sentence
 * from a date the BROWSER passed in, and `renderGuidedCallRecital` (S297)
 * rendered attested phone calls from a second call site near the sign-off.
 * Two renderers for "who I contacted and when" is the drift class the S298
 * letter-type consolidation killed — and Andrew's S300 ruling closes it: ONE
 * builder owns the whole block, so a letter can never receive two contact
 * histories.
 *
 * Consolidation ABSORBS the S297 call prose rather than replacing it (Andrew,
 * S300): those sentences say what was ASKED FOR on each call ("requested a
 * hold on this account"), which is materially stronger evidence than a bare
 * date. They are carried here verbatim, recipient-matching and letter-type
 * exclusions intact.
 *
 * ── What counts as a contact ────────────────────────────────────────────────
 * A server-stamped SEND that was actually mailed, and a user-attested CALL.
 * Excluded on principle, each for its own reason:
 *   - drafts                → no contact occurred
 *   - downloads             → not a contact
 *   - marked-sent-then-unsent → §0.9b: never mailed. Reciting it would put a
 *                             false statement in a letter the user signs.
 *   - our graduated follow-up letters → generated and stored, but nothing
 *                             records that the user ever MAILED one (no
 *                             mark-as-sent exists for them). Citing them would
 *                             assert a mailing we never observed. Giving them
 *                             their own send attestation is what would make
 *                             them eligible (tracker).
 *
 * Sends come from the case timeline's history (agenda §1: the ledger is
 * authoritative for HISTORY + SEQUENCE), which unions stored events with
 * events synthesized from row timestamps — so cases predating mig 221 recite
 * correctly through the same one derivation. A send that happened while
 * `case_timeline_v1` was OFF and was later superseded may be missed: the bias
 * is deliberately to UNDER-claim. Never assert a contact we cannot prove.
 *
 * Calls keep `claims.metadata.guideSteps` as their source — server-stamped and
 * complete for all time, where the ledger only holds attestations since mig
 * 221. Switching them to the ledger would silently drop older calls from
 * letters. Two facts, each read from its own authority; ONE renderer.
 *
 * ⚠ One attestation per call KIND is all the data model can hold (guideSteps is
 * a keyed object, not a list), so "I called them three times" is not
 * recordable today — tracker Item Z. The dedupe is the data shape, not a
 * policy choice.
 *
 * Dates render through the letters' shared `formatDate` (UTC, deliberately —
 * see its note). Timestamped sources therefore carry the same ±1 day exposure
 * every other date in every letter already has; consistency across one letter
 * matters more than per-field cleverness.
 *
 * PURE — no DB, no clock, no server-only imports. Exercised by
 * scripts/calibration/fixtures/dispute-grounds/prior-contact.ts.
 */

import type { LetterRecipientKind } from "@/lib/disputes";
import type { GuidedCallLogEntry } from "@/lib/guides/pack-registry";
import type {
  ProjectedHistoryEntry,
  ProjectedLetterStep,
} from "@/lib/case/timeline-projector";
import { formatDate } from "./templates";

/**
 * Letter types that never carry a contact recital. Inherited verbatim from the
 * S297 call recital (`GUIDED_RECITAL_EXCLUDED`) — an itemized-bill request, a
 * self-pay negotiation and a debt-validation letter are all opening moves, not
 * escalations; reciting prior attempts in them is noise at best.
 */
const RECITAL_EXCLUDED_TYPES: ReadonlySet<string> = new Set([
  "itemized_request",
  "negotiation",
  "debt_validation",
]);

/** Outcome details that make the OTHER track's letter "concluded" — see §other-track. */
const CONCLUDED_DENIAL: ReadonlySet<string> = new Set(["denied_fully"]);
const CONCLUDED_SILENCE: ReadonlySet<string> = new Set(["no_response"]);

/**
 * Where the block lands, which also decides WHAT IT CONTAINS (Andrew, S300
 * Position B):
 *
 *  - `opening`  — the Final Notice only. The full contact history: calls +
 *    every genuine send + the concluded other-track clause. A Final Notice's
 *    argument IS the pattern of ignored attempts, so it has to precede the
 *    escalation rather than trail it.
 *  - `signoff`  — every other letter type. CALLS ONLY, unframed — byte-identical
 *    to the S297 recital it replaces. Widening these templates to recite sends
 *    would be new copy inside counsel-resolved letters, which is a separate
 *    decision nobody has taken. The consolidation is structural here, not
 *    user-visible.
 */
export type PriorContactVariant = "opening" | "signoff";

/** The letter types whose recital renders in the body opening (and gets the full history). */
export const RECITAL_IN_OPENING: ReadonlySet<string> = new Set(["final_notice"]);

export interface PriorContactInput {
  /** Placement + content scope. */
  variant: PriorContactVariant;
  /** Projected history (stored ∪ synthesized). Null when the timeline is unavailable. */
  history: ProjectedHistoryEntry[] | null | undefined;
  /** Projected letter steps — supplies each send's recipient + logged outcome. */
  letters: ProjectedLetterStep[] | null | undefined;
  /** Attested calls from claims.metadata.guideSteps (unchanged source). */
  callLog: GuidedCallLogEntry[] | null | undefined;
  /** Who THIS letter is addressed to. */
  recipientKind: LetterRecipientKind;
  /** The letter type being composed. */
  letterType: string;
  /** The dispute being composed — its own (not-yet-sent) letter is never recited. */
  excludeDisputeId?: string | null;
  /**
   * Whether to append the concluded other-track clause. Andrew, S300: include
   * the insurer track ONLY when it has concluded — a pending appeal mentioned
   * in a Final Notice hands the provider "let's wait for your appeal", in the
   * one letter whose whole point is that the user is done waiting.
   */
  includeOtherTrack?: boolean;
}

/** Render one attested call, verbatim from the S297 recital (Andrew copy pass). */
function callSentence(
  entry: GuidedCallLogEntry,
  recipient: LetterRecipientKind,
): string | null {
  const on = formatDate(entry.calledAt);
  if (recipient === "insurer") {
    if (entry.kind === "insurer_call") {
      return `On ${on}, I called your member services line about this claim and asked that it be reviewed and reprocessed.`;
    }
    return null;
  }
  if (entry.kind === "billing_hold_call") {
    return `On ${on}, I called your billing office and requested a hold on this account — no further billing or collection activity — while this claim is reviewed.`;
  }
  if (entry.kind === "itemized_request_call") {
    return `On ${on}, I requested a fully itemized bill for this account by phone.`;
  }
  if (entry.kind === "flagged_charges_call") {
    return `On ${on}, I called your billing office and disputed specific charges on this account.`;
  }
  return null;
}

/** Oxford-comma join — this is a letter, not a data field. */
function joinDates(dates: string[]): string {
  if (dates.length === 1) return dates[0];
  if (dates.length === 2) return `${dates[0]} and ${dates[1]}`;
  return `${dates.slice(0, -1).join(", ")}, and ${dates[dates.length - 1]}`;
}

interface GenuineSend {
  disputeId: string;
  occurredAt: string;
  recipientKind: LetterRecipientKind;
}

/**
 * Walk the history per dispute, netting unsends against the sends they retract
 * (§0.9b). `letter_unsent` retracts the most recent outstanding `letter_sent`,
 * which is exactly the stack the sent-versions metadata models — same rule,
 * read from the sequence authority.
 */
function genuineSends(
  history: ProjectedHistoryEntry[],
  letters: ProjectedLetterStep[],
): GenuineSend[] {
  const recipientByDispute = new Map<string, LetterRecipientKind>();
  for (const l of letters) recipientByDispute.set(l.disputeId, l.recipientKind);

  const openByDispute = new Map<string, string[]>();
  const ordered = [...history].sort(
    (a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt),
  );
  for (const e of ordered) {
    const id = e.disputeId;
    if (!id) continue;
    if (e.kind === "letter_sent") {
      const stack = openByDispute.get(id) ?? [];
      stack.push(e.occurredAt);
      openByDispute.set(id, stack);
    } else if (e.kind === "letter_unsent") {
      openByDispute.get(id)?.pop();
    }
  }

  const out: GenuineSend[] = [];
  for (const [disputeId, stamps] of openByDispute) {
    const recipientKind = recipientByDispute.get(disputeId);
    if (!recipientKind) continue; // unknown letter → unknown recipient → not recitable
    for (const occurredAt of stamps) out.push({ disputeId, occurredAt, recipientKind });
  }
  return out.sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt));
}

/**
 * The concluded other-track clause. Only two shapes are attested:
 * the user LOGGED a full denial, or the user LOGGED that nothing came back.
 * Absence of a logged outcome is NOT evidence of silence — it means the user
 * never told us, and a letter must never turn our missing data into their
 * factual assertion.
 */
function otherTrackClause(
  letters: ProjectedLetterStep[],
  sends: GenuineSend[],
  thisRecipient: LetterRecipientKind,
): string | null {
  if (thisRecipient !== "provider") return null; // only the insurer track reads as "other"
  const insurerSends = sends.filter((s) => s.recipientKind === "insurer");
  if (insurerSends.length === 0) return null;
  const first = insurerSends[0];
  const step = letters.find((l) => l.disputeId === first.disputeId);
  const detail = step?.outcome?.detail;
  if (!detail) return null;

  const sentOn = formatDate(first.occurredAt);
  if (CONCLUDED_DENIAL.has(detail)) {
    const loggedAt = step?.outcome?.loggedAt;
    return loggedAt
      ? `I also appealed to my insurer on ${sentOn}, and that appeal was denied on ${formatDate(loggedAt)}.`
      : `I also appealed to my insurer on ${sentOn}, and that appeal was denied.`;
  }
  if (CONCLUDED_SILENCE.has(detail)) {
    return `I also appealed to my insurer on ${sentOn} and received no response.`;
  }
  return null;
}

/**
 * Build the block. Returns "" when there is nothing attested to say — the
 * caller's `renderGated` behavior (omit the sentence entirely) is preserved by
 * construction, so no combination of inputs can produce a hole or a bracketed
 * placeholder.
 */
export function buildPriorContactRecital(input: PriorContactInput): string {
  const { recipientKind, letterType } = input;
  // Collector letters carry no recital (inherited from the S297 policy) — it
  // also sidesteps conflating two collection agencies on one case.
  if (recipientKind === "collector") return "";
  if (RECITAL_EXCLUDED_TYPES.has(letterType)) return "";

  const letters = input.letters ?? [];
  const history = input.history ?? [];

  const callLines = (input.callLog ?? [])
    .map((e) => callSentence(e, recipientKind))
    .filter((s): s is string => s !== null);

  // Sign-off variant = the S297 recital, unchanged: calls only, no framing.
  if (input.variant === "signoff") {
    return callLines.join(" ");
  }

  const sends = genuineSends(history, letters);
  const mine = sends.filter(
    (s) => s.recipientKind === recipientKind && s.disputeId !== input.excludeDisputeId,
  );
  // One line per calendar day — two sends stamped the same day read as one contact.
  const sendDates: string[] = [];
  for (const s of mine) {
    const d = formatDate(s.occurredAt);
    if (!sendDates.includes(d)) sendDates.push(d);
  }

  const contactCount = callLines.length + sendDates.length;
  if (contactCount === 0) return "";

  const sendLine = sendDates.length > 0 ? `I wrote to you on ${joinDates(sendDates)}.` : null;
  const otherTrack = input.includeOtherTrack
    ? otherTrackClause(letters, sends, recipientKind)
    : null;

  if (contactCount === 1) {
    // No opener (it would restate the single date) and a singular closer.
    if (sendLine) {
      const single = `I wrote to you on ${sendDates[0]} and have not received a resolution.`;
      return otherTrack ? `${single} ${otherTrack}` : single;
    }
    const single = `${callLines[0]} That call has not produced a resolution.`;
    return otherTrack ? `${single} ${otherTrack}` : single;
  }

  const earliest = [
    ...(input.callLog ?? []).map((e) => e.calledAt),
    ...mine.map((s) => s.occurredAt),
  ]
    .filter((iso) => !Number.isNaN(Date.parse(iso)))
    .sort((a, b) => Date.parse(a) - Date.parse(b))[0];

  return [
    earliest ? `I have been working to resolve these charges since ${formatDate(earliest)}.` : null,
    ...callLines,
    sendLine,
    otherTrack,
    "None of these attempts has produced a resolution.",
  ]
    .filter((s): s is string => typeof s === "string" && s.length > 0)
    .join(" ");
}
