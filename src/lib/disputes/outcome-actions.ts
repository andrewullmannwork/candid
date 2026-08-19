/**
 * outcome-actions — the ONE definition of what each send/undo action posts to
 * `POST /api/disputes/outcome`.
 *
 * WHY THIS EXISTS (S301). The rail's unsend was written as
 * `{ disputeId, undoSent: true }` — a vocabulary the route has never heard of.
 * The route requires `status` and reads `clearSentAt` / `clearOutcomeDetail`, so
 * that call 400'd on every click, and the caller's own error copy ("log or undo
 * the response first") disguised the 400 as the §0.9b guard working correctly.
 * A malformed request wearing a plausible error message is the worst version of
 * the S300 acknowledge bug: it doesn't just fail silently, it lies about why.
 *
 * The fix is structural, not vigilance: every caller builds its payload here, and
 * the fixture asserts these bodies against the route's accepted keys in BOTH
 * directions, so a key that drifts on either side fails the build.
 *
 * ⚠ UNSEND CLEARS THE LOGGED OUTCOME TOO, in the SAME request — one row patch,
 * server-side (the route builds a single `patch` for `clearSentAt ||
 * clearOutcomeDetail`). That is deliberate, not convenience: if the letter was
 * never sent, a response logged against it cannot stand either. It is also what
 * makes "unsend a letter that has an outcome" safe to offer as one gesture —
 * there is no partial state to strand the user in.
 */

/** The exact request keys `POST /api/disputes/outcome` reads. */
export const OUTCOME_ROUTE_KEYS = [
  "disputeId",
  "status",
  "outcomeDetail",
  "clearSentAt",
  "clearOutcomeDetail",
  "recodedAs",
  // S320 — the enclosure-aware send record (external review etc.): the user's
  // attestation that the required documents went in the envelope, and how the
  // letter was sent. Optional; stamped to dispute metadata by the route.
  "enclosuresConfirmed",
  "sendMethod",
] as const;

export interface OutcomeActionPayload {
  disputeId: string;
  status: string;
  clearSentAt?: boolean;
  clearOutcomeDetail?: boolean;
  enclosuresConfirmed?: boolean;
  sendMethod?: string;
}

/** Mark a drafted letter as sent. S320: surfaces that ran the enclosure
 *  confirm pass the attestation + method so the record carries them. */
export function markSentPayload(
  disputeId: string,
  opts?: { enclosuresConfirmed?: boolean; sendMethod?: string },
): OutcomeActionPayload {
  return {
    disputeId,
    status: "filed",
    ...(opts?.enclosuresConfirmed ? { enclosuresConfirmed: true } : {}),
    ...(opts?.sendMethod ? { sendMethod: opts.sendMethod } : {}),
  };
}

/**
 * Unsend — "I haven't actually sent this."
 *
 * Clears the send AND any logged outcome in one atomic patch (see the header
 * note). The marked-sent snapshot is RETAINED and relabelled by the route
 * (§0.9b), never rendered as a mailed letter again.
 */
export function unsendPayload(disputeId: string): OutcomeActionPayload {
  return {
    disputeId,
    status: "dispute_letter_drafted",
    clearSentAt: true,
    clearOutcomeDetail: true,
  };
}

/** Undo a logged result, leaving the letter sent and its clock running. */
export function undoResultPayload(disputeId: string): OutcomeActionPayload {
  return { disputeId, status: "filed", clearOutcomeDetail: true };
}

// ── Unsend copy (S301, Andrew-approved verbatim) ────────────────────────────
//
// Lives HERE, not in CASE_RAIL, because both the claim rail and the letter page
// render it and this module already owns what unsend does. Splitting the words
// from the operation is how the two surfaces end up describing the same act
// differently.

export const UNSEND_COPY = {
  /** The quiet affordance, on both surfaces. */
  action: "I haven't actually sent this",
  /** Letter-page variant, which also reopens the letter for editing. */
  actionWithEdit: "I haven't actually sent this — unlock and edit",
  confirmTitle: "You logged a response on this letter",
  /**
   * Names WHAT disappears and WHY — a response to a letter that was never sent
   * cannot stand. The earlier design blocked unsend and only named the
   * prerequisite, which made a denied letter read as a dead end.
   */
  confirmBody: (outcomeLabel: string, loggedDateLabel: string | null) =>
    `You reported ${outcomeLabel}${loggedDateLabel ? ` on ${loggedDateLabel}` : ""}. ` +
    `If it was never sent, that response can't stand either — unsending clears both.`,
  /** Names the user's actual intent, not the prerequisite. */
  confirm: "Unsend and clear the response",
  /** Says what happens if they decline, rather than "Never mind". */
  cancel: "Keep it as sent",
} as const;
