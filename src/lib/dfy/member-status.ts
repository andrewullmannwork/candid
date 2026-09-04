/**
 * member-status — THE member's view of a DFY engagement, in words (S331).
 *
 * Before this module, four places independently turned the same engagement
 * facts into member-facing text, and a fifth was about to be added:
 *
 *   1. the signing page's state chip ("we're on it" / "all signed" / …)
 *   2. the signing page's status paragraph (8 branches over status × screened
 *      × composed × payment)
 *   3. the signing page's five-step strip (its own third derivation of the
 *      same state, as a step index)
 *   4. the claim page's engagement card (3 more branches)
 *   5. (proposed) the service page's "you already asked us" notice
 *
 * They had already drifted: the step the member still owes was "choose what to
 * argue · press Dispute this charge" on the claim page, "Choose what to argue"
 * on the step strip, and "you've built and adopted your appeal in the free
 * tool" on the signing page — three dialects for one step. Worse, the OPERATOR's
 * `derivePhase` string ("Waiting on activation", "Ready — designation not yet
 * submitted") was being printed to the member as "Current phase: …", leaking
 * internal ops vocabulary onto a member screen.
 *
 * This module is the one home. It is PURE — no DB, no clock, no server-only
 * imports — so every surface (client and server) reads it and the fixture can
 * assert the whole matrix without a database, the same way `intake-gates` and
 * `state-lanes` are locked.
 *
 * `derivePhase` stays what it always was: the OPERATOR's phase, for operator
 * screens only. It must never be rendered to a member again.
 */
import { formatLetterDateShort } from "@/lib/disputes/letter-type";
import type { EngagementStatus } from "./engagement-state";

/**
 * The five-step strip the member walks. The index this module returns points at
 * the step that is CURRENT, so the strip cannot disagree with the prose beside
 * it — they are computed from one object.
 */
export const MEMBER_STEPS = [
  "Request sent",
  "Sign your documents",
  "Choose your dispute path",
  "We confirm",
  "We start",
] as const;

/** The stack is five instruments for BOTH payers (sponsor swaps one, never adds
 *  one). The approved copy says "All five documents are signed", so the count is
 *  load-bearing prose — the fixture pins it against `requiredDfyConsents`. */
export const MEMBER_INSTRUMENT_COUNT = 5;

export interface MemberStatusFacts {
  status: EngagementStatus;
  /** Every required instrument signed. */
  allSigned: boolean;
  /** The member's OWN composition proof (ground selected + letter adopted). */
  composed: boolean;
  /** The screening decision once one exists; null while unscreened. */
  screened: { eligible: boolean; declineReason?: string | null } | null;
  /**
   * True only when a fee is actually owed (the pilot runs at 0).
   *
   * OPTIONAL on purpose. The fee state needs the DFY config, which is read
   * fresh (no cache) because the operator surface prefers truth over speed —
   * so the member's claim page, a hot path, cannot afford to know it. When it
   * is `undefined` this module simply does not assert that nothing is
   * outstanding, rather than guessing that nothing is. The signing page, which
   * does know, passes it.
   */
  paymentRequired?: boolean;
  /** Only read when `paymentRequired` is true. */
  feeCents?: number;
}

export type MemberStatusTone = "info" | "success" | "warn" | "neutral";

export interface MemberStatus {
  /** Which of {@link MEMBER_STEPS} is current (0-based). */
  stepIndex: number;
  /** The short state word beside the progress count. */
  chip: string;
  /** The bold lead. */
  headline: string;
  /** The sentence under the lead. */
  detail: string;
  /** What is still the MEMBER's to do — null when nothing is. */
  nextStep: string | null;
  /** Label for a link into the member's own engagement page. */
  ctaLabel: string;
  tone: MemberStatusTone;
  /** The engagement is over; the step strip is hidden. */
  closed: boolean;
}

const CLOSED: ReadonlySet<EngagementStatus> = new Set<EngagementStatus>([
  "terminated",
  "converted",
  "completed",
]);

/** The one sentence for the step that is always the member's own. */
const CHOOSE_PATH = "choose your dispute path";

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/**
 * The member's status. Every member surface renders from this and nothing
 * re-derives it.
 */
export function memberStatus(f: MemberStatusFacts): MemberStatus {
  const closed = CLOSED.has(f.status);

  if (closed) {
    const complete = f.status === "completed";
    return {
      stepIndex: MEMBER_STEPS.length - 1,
      chip: complete ? "complete" : "ended",
      headline: complete ? "This engagement is complete." : "This engagement has ended.",
      detail: complete
        ? "Everything we did stays on your claim timeline."
        : "Your appeal and every free Candid tool stay yours.",
      nextStep: null,
      ctaLabel: "See your engagement",
      tone: "neutral",
      closed: true,
    };
  }

  // A decline is the loudest thing on the page whatever the status says.
  if (f.screened && !f.screened.eligible) {
    return {
      stepIndex: 3,
      chip: "not taken on",
      headline: "We can't take this one on.",
      detail: f.screened.declineReason?.trim()
        ? f.screened.declineReason.trim()
        : "This isn't one we can take on right now.",
      nextStep: null,
      ctaLabel: "See your engagement",
      tone: "warn",
      closed: false,
    };
  }

  if (f.status === "active") {
    return {
      stepIndex: 4,
      chip: "we're on it",
      headline: "We're handling this appeal.",
      detail:
        'We act as your authorized representative. Every step we take shows on your claim timeline as "Done by Candid", and any decision stays yours.',
      nextStep: null,
      ctaLabel: "See your engagement",
      tone: "success",
      closed: false,
    };
  }

  // Signed: the paper is done. What is left is either the member's own
  // composition, the fee, or nothing at all but our review.
  if (f.status === "signed" || f.allSigned) {
    if (!f.composed) {
      return {
        stepIndex: 2,
        chip: "all signed",
        headline: `All ${numberWord(MEMBER_INSTRUMENT_COUNT)} documents are signed.`,
        detail: `One step is still yours: ${CHOOSE_PATH}. We're reviewing your appeal now and will email you as soon as the review is done.`,
        nextStep: `Choose your dispute path`,
        ctaLabel: "See your engagement",
        tone: "info",
        closed: false,
      };
    }
    if (f.paymentRequired) {
      return {
        stepIndex: 3,
        chip: "all signed",
        headline: `All ${numberWord(MEMBER_INSTRUMENT_COUNT)} documents are signed.`,
        detail: `One step left: the ${money(f.feeCents ?? 0)} fee.`,
        nextStep: "Pay the fee",
        ctaLabel: "See your engagement",
        tone: "info",
        closed: false,
      };
    }
    return {
      stepIndex: 3,
      chip: "all signed",
      headline: `All ${numberWord(MEMBER_INSTRUMENT_COUNT)} documents are signed.`,
      detail:
        f.paymentRequired === false
          ? "We're reviewing your appeal now and will email you as soon as it's done. Nothing else is needed from you."
          : "We're reviewing your appeal now and will email you as soon as it's done.",
      nextStep: null,
      ctaLabel: "See your engagement",
      tone: "success",
      closed: false,
    };
  }

  // eligibility_pending with paper outstanding.
  if (f.screened?.eligible) {
    return {
      stepIndex: 1,
      chip: "in progress",
      headline: "You're approved.",
      detail: "Sign the remaining documents and we start.",
      nextStep: "Sign your documents",
      ctaLabel: "Review and sign",
      tone: "info",
      closed: false,
    };
  }
  return {
    stepIndex: 1,
    chip: "ready to sign",
    headline: "Candid can handle the paperwork for this appeal.",
    detail:
      "Sign the documents on your own page now — nothing happens until you do. We're confirming we can take this one on and will start the moment it clears.",
    nextStep: "Sign your documents",
    ctaLabel: "Review and sign",
    tone: "info",
    closed: false,
  };
}

/**
 * The compact face for a member who asks for the service AGAIN on a claim that
 * already has a live engagement — the service page's "you already asked us"
 * notice. Same vocabulary as {@link memberStatus}, shorter, and it names the day
 * they asked so the answer is a status rather than a refusal.
 *
 * `requestedAt` is the engagement's creation time (ISO); null when unknown, in
 * which case the date clause is simply omitted rather than guessed.
 */
export function memberRevisitNotice(
  f: Pick<MemberStatusFacts, "status" | "allSigned" | "composed" | "screened">,
  requestedAt: string | null,
): { headline: string; detail: string; ctaLabel: string; tone: MemberStatusTone } {
  const on = requestedAt ? formatLetterDateShort(requestedAt) : null;

  if (f.status === "active") {
    return {
      headline: "We're handling this appeal.",
      detail: `${on ? `Started ${on}. ` : ""}Follow it on your claim page.`,
      ctaLabel: "See your engagement",
      tone: "success",
    };
  }

  if (f.status === "signed" || f.allSigned) {
    const rest = f.composed
      ? "We're reviewing it now and will email you when the review is done."
      : `One step is still yours: ${CHOOSE_PATH}.`;
    return {
      headline: "You already asked us to handle this appeal.",
      detail: `${on ? `Requested ${on} · ` : ""}everything signed. ${rest}`,
      ctaLabel: "See your engagement",
      tone: "info",
    };
  }

  return {
    headline: "You already asked us to handle this appeal.",
    detail: `${on ? `Requested ${on}. ` : ""}Your documents still need signing — finish them and we'll take it from there.`,
    ctaLabel: "Finish signing",
    tone: "info",
  };
}

/** Small-number words, so the approved copy reads "All five documents". */
function numberWord(n: number): string {
  return ["zero", "one", "two", "three", "four", "five", "six", "seven"][n] ?? String(n);
}

/**
 * Is a member-paid fee still outstanding on this engagement?
 *
 * Extracted from the engagement GET route, where it was an inline predicate, so
 * the signing page and any future surface read ONE rule. Pure: row fields plus
 * the configured fee.
 */
export function dfyFeeOutstanding(
  e: { status: EngagementStatus; payer: string; metadata?: unknown },
  feeCents: number,
): boolean {
  if (e.status !== "signed" || e.payer !== "member_paid" || feeCents <= 0) return false;
  const paid = (e.metadata as { payment?: { status?: string } } | null | undefined)?.payment?.status;
  return paid !== "succeeded";
}
