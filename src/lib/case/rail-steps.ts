/**
 * rail-steps — PURE composition of the projected case timeline into the
 * extended claim rail's renderable step models (S299, timeline unification
 * phase 1a; approved mock: plans/mocks/s298-extended-rail-mock.html).
 *
 * Sits between the projector (ONE derivation of stages/clocks — agenda §1)
 * and CaseRail.tsx (thin JSX): every string, badge number, chip, and
 * countdown percentage is composed HERE so the fixture can lock the approved
 * copy + numbering without a DOM. No IO, no clock (the projector already
 * injected `now`), no React.
 *
 * Composition rules (agenda §0 + §0.9a/§0.9d; S302 phase 3):
 *  - EVERY letter composes identically — there is no primary special case.
 *    Until S302 the primary letter's send step was the prep rail's 4b, so one
 *    letter rendered with guided-step anatomy and every other letter rendered
 *    with rail anatomy (Andrew, S301 E2E: "each letter is a little different").
 *    Dropping that exclusion is what retires 4b.
 *  - Steps GROUP BY LETTER, letters in the projector's order (birth, then id).
 *    Within a letter the order is fixed and declarative: before-send guide
 *    steps → send → after-send guide steps → wait → next move. This replaced a
 *    global anchor sort that interleaved unrelated letters — on the Ballard
 *    case it wedged a third letter's send step between the collections send
 *    and the certified-mail steps belonging to it, and put the appeal's send
 *    step seven rows above the appeal's own waiting card.
 *  - Each group carries a BAND (eyebrow · title · status chip) so the grouping
 *    is legible without reading, and so a letter's state is visible at a glance.
 *  - Numbering continues from `firstNumber` (5 after the guided phone step) and
 *    runs flat across groups. a/b badges stay RESERVED for §0.9a rule 1's
 *    same-trigger sibling letters (T2 dual-grounds) — reusing them for
 *    send/response would leave the notation meaning two different things
 *    (Andrew, S302).
 *  - Affordances derive from the EXISTING stage machine (stageActions +
 *    §6.1a quiet-action contract): awaiting → "Log their response" + a quiet
 *    door; next → outcome receipt + quiet "Undo this result"; draft →
 *    "Open this letter"; resolved → receipt only; none → omitted.
 *  - Dated furniture (deadline chip + countdown + reminder foot) renders ONLY
 *    when deadlineType != null — a real engine deadline. responseDueDate's
 *    sent+30d display fallback (parity semantics) is NOT asserted as "their
 *    deadline"; an undated debt_validation wait gets the approved
 *    collection-pause chip instead.
 *  - "What happens next" renders only the two approved sets (insurance_appeal,
 *    debt_validation); expanded by default only when it's the sole active wait.
 *
 * Exercised by scripts/calibration/fixtures/case-timeline/rail-steps.ts.
 */
import {
  regulatorFilingStepId,
  regulatorSkipStepId,
  type ProjectedLetterStep,
  type ProjectedRegulatorComplaint,
} from "@/lib/case/timeline-projector";
import type { DisputeLetterType } from "@/lib/billing/types";
import {
  OUTCOME_LABELS,
  isAdverseOutcome,
  suggestNextStep,
} from "@/lib/disputes/outcome-taxonomy";
import { letterRequiresPro } from "@/lib/disputes/letter-access";
import {
  route,
  orderForums,
  fallbackForums,
  NO_FORUM_NOTICE,
  disputeKindForInsurerLetter,
  type Forum,
  type DenialBasis,
  type DisputeKind,
  type RegulatoryClassification,
} from "@/lib/disputes/forums";
import {
  formatLetterDateShort,
  daysSinceLocal,
  daysUntilLocal,
  getLetterEnclosures,
} from "@/lib/disputes/letter-type";
import {
  CASE_RAIL,
  COLLECTIONS_STEPS,
  GUIDE_4B,
  letterRailCopy,
  COMPLAINT_DOORS,
  PACK_D_STEPS,
  PACK_D_SUGGESTED_CHIP,
  PACK_D_TITLE,
  suggestDoors,
  type CollectionsStepAction,
} from "@/lib/guides/pack-registry";

/**
 * S305 — a letter this claim WARRANTS but the user has not written yet.
 *
 * The parallel-track offer. An insurer appeal and a provider billing dispute
 * are independent wrongs against independent parties, so a claim can be owed
 * two first letters at once; `deriveLetterTracks` says which parties are
 * obligated, and the caller passes through only the tracks with no letter yet.
 *
 * Deliberately NOT a `ProjectedLetterStep`: the projection describes what has
 * happened, and this has not happened. It carries no stage, no clock and no
 * outcome, because none of those exist before a letter does.
 */
export interface RailLetterOffer {
  party: "insurer" | "provider";
  letterType: DisputeLetterType;
  /**
   * Why this letter is owed. Finding-raised tracks carry the finding's OWN
   * words — the same title and description the claim-level issues list shows.
   * S309 F1-B: an insurer track raised by the cost-share ENGINE carries the
   * engine's reason instead (title null — plan math has no finding headline,
   * only the sentence built from the live totals). Null only when neither
   * exists (e.g. an engine-raised provider track, which has no approved copy).
   */
  reason: { title: string | null; detail: string | null } | null;
  /** The user's stored decline (`skippedAt`), else null. */
  declinedAt: string | null;
}

/**
 * The `claims.metadata.guideSteps` key for declining a track's offer.
 *
 * ONE definition, like `regulatorSkipStepId`: the composer stamps it into the
 * step and the caller reads the stored state back with it, so the key that is
 * written can never drift from the key that is read. Claim-scoped and keyed on
 * the PARTY — the offer belongs to a track, not to a letter (there isn't one).
 */
export function letterOfferSkipStepId(party: RailLetterOffer["party"]): string {
  return `track:skip:${party}`;
}

export interface RailWaitCard {
  disputeId: string;
  /** Slate pill — "Sent N days ago" / "Sent today". Null when unsent (never for a wait). */
  chipSentAgo: string | null;
  /** Amber pill — only with a real engine deadline (deadlineType != null). */
  chipDeadline: string | null;
  /**
   * S314 — slate pill: "Follow up after Aug 29 · 15 days away". Shown for a
   * sent letter with NO engine deadline; never called a deadline. Null when a
   * real deadline is present (that chip answers the question) or unsent.
   */
  chipFollowUp: string | null;
  /** S314 — "You asked them to reply within 30 days." Pairs with chipFollowUp. */
  followUpSub: string | null;
  /** Slate pill — undated §1692g wait ("Collection must pause…"). */
  chipPause: string | null;
  ctaLogResponse: string;
  door:
    | { kind: "something_else"; label: string }
    | { kind: "collection_resumed"; label: string; ackLabel: string };
  /** Reminder line — dated waits with the deadline still ahead; else null. */
  foot: string | null;
  whn: { heading: string; rows: Array<[string, string]>; defaultOpen: boolean } | null;
}

export interface RailDoorTile {
  id: string;
  name: string;
  desc: string;
  href: string;
  /** "suggested for this case" — the FIRST (track) door only, mock-literal. */
  chip: string | null;
  /**
   * S303 — THIS letter's own filing with this agency. Null when the user has
   * not filed with it in response to this letter, even if they filed with it
   * about an earlier one (see {@link earlier}).
   */
  filedAt: string | null;
  /** Display date for the filed state ("Aug 4"); null while unfiled. */
  filedAtLabel: string | null;
  /** The confirmation number logged for THIS letter's filing. */
  note: string | null;
  /** claims.metadata.guideSteps key this tile writes for THIS letter. */
  stepId: string;
  /**
   * A filing with this agency made about a DIFFERENT letter (Andrew, S303).
   *
   * The numbers are linked, the behaviour is not: the user sees that they have
   * already been to this agency and what number it gave them, without this
   * letter's step counting itself done on the strength of it. Rendered as a
   * greyed-out green with the number read-only, plus a "File again" that opens
   * a fresh entry — so a second filing is only ever recorded when a second
   * confirmation number is actually typed.
   */
  earlier: {
    /** "Already filed Aug 4 — for your appeal". */
    label: string;
    /** That filing's confirmation number, shown read-only. */
    note: string | null;
  } | null;
  /** S325 routed pool only — the agency's phone, shown on the tile. */
  phone?: string | null;
  /**
   * S325 routed pool — true = a post-letter ACTION the member files
   * themselves (licensing boards, criminal-referral units). The filing
   * attest + confirmation-number machinery still applies; the tile just
   * renders the "you file this yourself" variant and never links a letter.
   */
  actionOnly?: boolean;
  /** S325 routed pool — the agency's own verbatim "cannot" language. */
  cannotLines?: readonly string[];
  /**
   * S325 — true for a licensing board that publishes NO billing limitation:
   * the UI renders the honest "publishes no jurisdictional limitation"
   * sentence, never synthesized text (memo 05 invariant 3).
   */
  noLimitationNote?: boolean;
}

export interface RailNextMove {
  disputeId: string;
  /** Null at resolved terminal rungs (doors-only — the ladder is exhausted). */
  letterOffer: {
    targetLetterType: DisputeLetterType;
    title: string;
    sub: string | null;
    /** letterRequiresPro — false while the S299 wall removal stands; the chip
     *  machinery stays so re-adding PRO_LETTER_TYPES re-lights it. */
    requiresPro: boolean;
    proChip: string;
    cta: string;
  } | null;
  /**
   * S303 — the regulator card. Null until this letter has a logged response
   * that isn't a win.
   *
   * The card is composed per LETTER (it belongs to the moment a response
   * lands) but every door reads and writes ONE claim-scoped record, so the
   * same filing shows wherever it is relevant and nothing can disagree with
   * itself. Placement was never the bug; storage was.
   */
  regulator: {
    title: string;
    lead: string;
    /** Every door, always — ordered with this letter's suggestion first. */
    doors: RailDoorTile[];
    /** Attest label + placeholder, from the PACK_D_STEPS row, per door. */
    filedLabel: string;
    notePlaceholder: string;
    /** "File again" — opens a fresh entry on an agency filed for another letter. */
    fileAgainLabel: string;
    /**
     * THIS letter's declination — offered only while this letter has nothing
     * filed. Per letter, so declining here cannot touch what another letter
     * recorded.
     */
    skip: { stepId: string; declined: boolean; declinedAtLabel: string | null } | null;
    foot: string;
    /**
     * S325 (`forum_menu_v1` ON) — the routed state. Null on the legacy path.
     * When present the renderer shows, in order: the screening questions
     * (screeningNeeded), the jurisdiction notice, the denial-basis question
     * (insurer letters, unanswered), then the routed door grid — fixed role
     * order, nothing featured (R14; every tile's chip is null).
     */
    routed: {
      notice: string | null;
      screeningNeeded: boolean;
      denialBasisNeeded: boolean;
      /** The claim's plan row the screening answers persist to; null = no plan (screening hidden, generic pool shown). */
      planId: string | null;
    } | null;
  } | null;
}

export type RailStepModel =
  | {
      kind: "wait-active";
      key: string;
      badge: string;
      title: string;
      sub: string | null;
      card: RailWaitCard;
    }
  | {
      kind: "next-move";
      key: string;
      badge: string;
      title: string;
      sub: string | null;
      move: RailNextMove;
    }
  | {
      kind: "wait-receipt";
      key: string;
      badge: string;
      title: string;
      /** "«outcome» · logged «date»" (empty for legacy rows without a detail). */
      receipt: string;
      /** Stage-machine quiet action: true only at stage `next` (§6.1a). */
      undo: boolean;
      disputeId: string;
    }
  | {
      kind: "send-receipt";
      key: string;
      badge: string;
      title: string;
      receipt: string;
      disputeId: string;
      openLetterLabel: string;
      /**
       * S301 — unsend, on the CASE surface. ALWAYS offered (Andrew): blocking it
       * behind "undo the result first" made a denied letter read as a dead end,
       * and the server clears both in ONE atomic patch anyway, so there is no
       * partial state to protect against.
       *
       * When a response is logged, the card confirms first — carrying the FACTS
       * (what was logged, when) so the copy can name them. §0.9b's invariant is
       * preserved by the route, not by hiding the button: an unsend can still
       * never leave an orphaned response, because the same patch clears it.
       */
      unsend: {
        loggedOutcomeLabel: string | null;
        loggedOutcomeDateLabel: string | null;
      };
    }
  | {
      kind: "send-draft";
      key: string;
      badge: string;
      title: string;
      disputeId: string;
      openLetterLabel: string;
      /** S320 — documents this letter must be MAILED WITH (from the one
       *  letter-type declaration); empty = no band, no confirm stage. */
      enclosures: readonly string[];
      /** Projection string (legacy rows reverse-mapped) — filename use only. */
      letterType: string;
      /**
       * S312 (F2-S312.1) — the draft's demand fell to $0 (row-truth via the
       * projection; see ProjectedLetterStep.noRemainingDemand). The rail
       * renders the Dismiss/Keep banner INLINE on this step instead of the
       * bare send CTA (Andrew: avoid the extra click); the letter page shows
       * the same banner from the same strings (CASE_RAIL.zeroDemand*).
       */
      zeroDemand: boolean;
    }
  /**
   * S301 — a collections guard-rail step, relocated onto the rail.
   *
   * Every step is an ACTION (button, or input plus a confirming button); there
   * are no checkboxes. THREE states, and "skipped" is deliberately not a flavour
   * of done: these attestations feed the prior-contact recital and the flywheel,
   * so a declined step must never be readable as a performed one (S297 §3.2).
   */
  | {
      kind: "guide-step";
      key: string;
      badge: string;
      title: string;
      body: string;
      disputeId: string;
      /** claims.metadata.guideSteps key. */
      stepId: string;
      action: CollectionsStepAction;
      state: "open" | "done" | "skipped";
      /** Display date for the done state ("Aug 3") — null while open/skipped. */
      doneAt: string | null;
      skippable: boolean;
      /** Existing value for a date/text action (prefill). */
      value: string | null;
      /**
       * True for the step whose done-ness is the LETTER's send record rather
       * than its own stored boolean — un-doing it routes through unsend, so the
       * rail must not treat it as a plain un-attest.
       */
      derivedFromSend: boolean;
      /**
       * WHERE this step's done-ness comes from, which is also what Undo has to
       * reverse: an attestation (un-attest), the letter's send record (unsend),
       * or a stored date (clear the date). Explicit so the card cannot guess.
       */
      doneSource: "attestation" | "send" | "date";
    }
  /**
   * S305 — the parallel-track offer: a letter this claim is owed that has not
   * been written.
   *
   * TWO states, not three. It is never "done": the moment the letter exists the
   * offer stops being composed and that letter's own group takes its place, so
   * a stale done-state cannot survive (the structural cure S302 applied to 4b,
   * whose done-flag went green on a mere draft and stayed green through an
   * unsend). Declining is a real answer and greys it, exactly as it does on
   * every other declinable step here — never a check, because a declined step
   * must not read as a performed one (S297 §3.2).
   */
  | {
      kind: "letter-offer";
      key: string;
      badge: string;
      title: string;
      sub: string | null;
      offer: {
        party: RailLetterOffer["party"];
        /** The template the draft action must request. */
        letterType: DisputeLetterType;
        /** The finding's own words — the reason this letter is owed. */
        reasonTitle: string | null;
        reasonDetail: string | null;
        /** claims.metadata.guideSteps key this step writes. */
        stepId: string;
        declined: boolean;
        /** Display date for the declined state ("Aug 5"); null while open. */
        declinedAtLabel: string | null;
      };
    };

/**
 * One letter's contiguous block of rail steps, with the band that heads it.
 *
 * S302 — replaces the flat `RailStepModel[]`. The S300 deep-link anchor is the
 * group's `disputeId`: every step inside belongs to this letter by
 * construction, so the anchor can no longer be derived per-step (and
 * `railStepDisputeId`, which existed only to reach it through `card`/`move`,
 * is gone).
 */
export interface RailLetterGroup {
  /** React identity + the group's stable handle. Never null — an offer group
   *  has no dispute yet, and `disputeId` is not a place to keep a stand-in. */
  key: string;
  /** Null on an OFFER group: the letter does not exist, so there is no id and
   *  no deep-link anchor to give its steps (S305). */
  disputeId: string | null;
  /** "Letter 2 of 3". */
  eyebrow: string;
  /** "Debt validation — Cascade Recovery". */
  title: string;
  /** Draft / waiting / answered, at a glance. Null when a closed letter has no
   *  logged outcome to name (legacy rows) — an absent chip, never a guess. */
  status: { tone: "slate" | "amber" | "green"; label: string } | null;
  steps: RailStepModel[];
}

export interface RailForumMenuInput {
  /** The member's plan-level screening answers (null = unanswered). */
  classification: RegulatoryClassification | null;
  /** profiles.state (null fail-soft → generic pool). */
  userState: string | null;
  /** Per-dispute denial-basis answers (claim-scoped guide-step notes). */
  denialBasisByDispute: Record<string, DenialBasis | undefined>;
  /** The claim's plan row id — where screening answers persist. */
  planId: string | null;
}

/**
 * S325 — the routed door pool for one letter, PURE (fixture-tested). Routing
 * consumes only member-supplied facts; the pool renders in the fixed role
 * order with nothing featured (R14). Provider-track letters route to the
 * billing-conduct pool; `negotiation` (self-pay) routes to the affordability
 * pool (HCAI / WA charity care); insurer letters narrow by the member's own
 * denial-basis answer, with the complaint track shown while it is unanswered
 * (the complaint door is valid regardless — the basis only adds/removes the
 * IMR/external-review doors).
 */
export function routedPoolForLetter(
  fm: RailForumMenuInput,
  letter: { recipientKind: string; letterType: string; disputeId: string },
): {
  doors: Forum[];
  notice: string | null;
  screeningNeeded: boolean;
  denialBasisNeeded: boolean;
} {
  if (fm.userState !== "CA" && fm.userState !== "WA") {
    return { doors: fallbackForums(), notice: null, screeningNeeded: false, denialBasisNeeded: false };
  }
  if (!fm.classification) {
    // No answers yet: the screening panel renders; the generic pool stays
    // available behind the "skip" affordance (renderer-local), so a member
    // who declines the questions still gets the directory.
    return { doors: fallbackForums(), notice: null, screeningNeeded: true, denialBasisNeeded: false };
  }
  const isInsurer = letter.recipientKind === "insurer";
  const basis = fm.denialBasisByDispute[letter.disputeId];
  const dispute: DisputeKind = isInsurer
    ? disputeKindForInsurerLetter(basis ?? "other")
    : letter.letterType === "balance_billing"
      ? "balance_bill"
      : letter.letterType === "negotiation"
        ? "hospital_bill_affordability"
        : "provider_billing_conduct";
  const result = route({
    state: fm.userState,
    coverage: fm.classification.coverageType,
    dispute,
    caRegulator: fm.classification.caRegulator,
    waSelfFundedOptedIn: fm.classification.waBbpaOptedIn,
  });
  const doors = orderForums(result.forums);
  const notice =
    result.notice ?? (doors.length === 0 ? NO_FORUM_NOTICE : null);
  return {
    doors,
    notice,
    screeningNeeded: false,
    denialBasisNeeded: isInsurer && basis == null,
  };
}

export interface ComposeRailInput {
  letters: ProjectedLetterStep[];
  /**
   * S325 — the forum-menu state. REQUIRED `| null` for the same S301/S303
   * reason `regulator` is required: an optional field is what lets a call
   * site forget it. `null` = legacy path (flag off / not loaded) — an
   * explicit decision, not an accident.
   */
  forumMenu: RailForumMenuInput | null;
  /**
   * S303 — the case's regulator complaint. REQUIRED, not optional: the S301
   * lesson was that an optional field is exactly what lets a call site forget
   * to pass state, and every collections step then sat permanently open while
   * the writes landed perfectly. A required prop cannot be dropped silently.
   */
  regulator: ProjectedRegulatorComplaint;
  /**
   * S305 — letters this claim is owed but has not written, one per obligated
   * party with no letter yet. Ordered by the caller (insurer first, whose
   * deadline is the one that expires); rendered AFTER every letter that does
   * exist, because a letter in flight outranks one not yet started.
   */
  offers: RailLetterOffer[];
  /** First extension badge number (5 after the guided phone step). */
  firstNumber: number;
  /** Per-letter insurer display names (pinned plan), route-supplied. */
  insurerNameByDispute: Record<string, string>;
  providerName: string | null;
  /**
   * The CLIENT clock — calendars are the user's timezone (letter-type.ts
   * rule). Injected so the fixture is deterministic; the projector's
   * server-side output deliberately carries no day-counts (S299 lesson).
   */
  now: Date;
}

/**
 * "Sep 29" — the shared letter-date rule (letter-type.ts, S299): timestamps
 * land on the user's LOCAL calendar; date-only strings pin to local midnight.
 * Re-exported under the rail's name so consumers keep one import site.
 */
export const fmtRailDate = formatLetterDateShort;

/**
 * A letter is ON the rail unless it was withdrawn. `none` is
 * computeCaseStage's cancelled verdict — no send step, no wait, and (S302) no
 * collections guidance either: a withdrawn letter has no track to guard.
 */
function contributesSteps(l: ProjectedLetterStep): boolean {
  return l.stage !== "none";
}

/** Every sent, non-cancelled letter renders a wait step (active or receipt). */
function contributesWaitStep(l: ProjectedLetterStep): boolean {
  return contributesSteps(l) && l.latestSendAt != null;
}

/**
 * True when the rail extends past the prep steps — i.e. when the RAIL owns the
 * letter step and the prep rail's create step (4b, and the flag-OFF "Recover
 * the money") must stand down. Same predicate the composer uses, so the two can
 * never disagree.
 *
 * S302: a letter that exists takes its send step onto the rail.
 * S305: so does a letter the claim is OWED. An offer is a rung the user can
 * act on, and it renders with the rail's anatomy, so leaving 4b up beside it
 * would put two doors on the same act — the duplication the S302 collapse
 * removed. ClaimDetail reads this at THREE places (4b's gate, the phone step's
 * 4-vs-4a badge, the flag-OFF recover gate); a second hand-rolled condition at
 * any of them is exactly how 4b's stale done-state survived.
 */
export function railHasExtension(input: {
  letters: ProjectedLetterStep[];
  offers: RailLetterOffer[];
}): boolean {
  return input.letters.some(contributesSteps) || input.offers.length > 0;
}

/** The resolved-case summary (agenda §2.2 / mock Panel D). */
export interface RailCaseResolution {
  /**
   * The closing letter's outcome label, VERBATIM ("Resolved — they approved it
   * / paid in full"). Deliberately not re-phrased into per-outcome prose: that
   * would be nine new strings saying what the approved labels already say, and
   * the rail's receipts already speak in exactly this voice.
   */
  headline: string;
  /** "Blue Cross · Oct 8 · 3 letters · $163.27 recovered" — omits what it doesn't know. */
  meta: string;
  expandLabel: string;
  /**
   * S303 — how many steps still ask something of the user. The fold does NOT
   * gate on this (see CASE_RAIL.foldOpenSteps for why); it NAMES it, so a
   * collapsed case can never silently hide outstanding work.
   */
  openStepCount: number;
}

/**
 * Does this step still ask something of the user?
 *
 * ONE definition, read by the fold's summary — derived from the composed step
 * the rail actually renders, never re-derived from the projection, so the
 * count and the badges can never disagree about the same step.
 */
export function railStepIsOpen(s: RailStepModel): boolean {
  switch (s.kind) {
    case "guide-step":
      // "skipped" is a resolution, not a completion — the user answered by
      // declining, which is exactly the distinction S297 §3.2 protects.
      return s.state === "open";
    case "next-move": {
      const reg = s.move.regulator;
      if (!reg) return false; // offer-only: the escalation is optional, never a chore
      return !reg.doors.some((d) => d.filedAt != null) && !(reg.skip?.declined ?? false);
    }
    case "letter-offer":
      // Declining is an ANSWER, so a declined offer stops asking — the same
      // rule "skipped" gets above. An open offer is genuinely outstanding work
      // and the fold must name it rather than collapse over it (S303).
      return !s.offer.declined;
    case "send-draft":
      return true;
    case "wait-active":
      // Belt and braces: an active wait means the letter is at `awaiting`, so
      // the case cannot be resolved anyway. Counted honestly rather than
      // assumed unreachable.
      return true;
    case "send-receipt":
    case "wait-receipt":
      return false;
    default: {
      const _exhaustive: never = s;
      return _exhaustive;
    }
  }
}

/**
 * The whole case is finished — every letter reached a terminal outcome with no
 * next rung offered, and at least one actually resolved (a case of nothing but
 * cancelled letters is not a resolution).
 *
 * Derived, never stored: "all letters are done" is answerable from the
 * projection, so the fold needs no new column, no event, and no migration.
 * Deliberately NOT the same thing as "the user closed the case" — closing an
 * UNfinished case is real server state (`case_closed` is still a RESERVED
 * event kind) and is its own unit.
 */
function railCaseResolution(
  // Narrowed to what it actually reads — the summary has no badges and no
  // clock, so demanding the full ComposeRailInput would have meant callers
  // passing a dummy `firstNumber` and a `now` nothing looks at.
  input: Pick<ComposeRailInput, "letters" | "insurerNameByDispute" | "providerName">,
  openStepCount: number,
): RailCaseResolution | null {
  const onRail = input.letters.filter(contributesSteps);
  if (onRail.length === 0) return null;
  if (!onRail.every((l) => l.stage === "resolved")) return null;
  // The letter that ENDED it — latest logged outcome, else the last on the rail.
  const withOutcome = onRail.filter((l) => l.outcome != null);
  if (withOutcome.length === 0) return null;
  const closer =
    withOutcome
      .slice()
      .sort((a, b) => (a.outcome!.loggedAt ?? "").localeCompare(b.outcome!.loggedAt ?? ""))
      .at(-1) ?? withOutcome[0];

  const recovered = onRail.reduce<number | null>(
    (sum, l) => (l.amountRecovered == null ? sum : (sum ?? 0) + l.amountRecovered),
    null,
  );
  const parts = [
    counterpartyFor(closer, input),
    closer.outcome!.loggedAt ? fmtRailDate(closer.outcome!.loggedAt) : null,
    CASE_RAIL.foldLetterCount(onRail.length),
    recovered != null && recovered > 0 ? CASE_RAIL.foldRecovered(recovered) : null,
    openStepCount > 0 ? CASE_RAIL.foldOpenSteps(openStepCount) : null,
  ].filter((x): x is string => x != null);

  return {
    headline: OUTCOME_LABELS[closer.outcome!.detail],
    meta: parts.join(" · "),
    expandLabel: CASE_RAIL.foldExpand,
    openStepCount,
  };
}

/** ONE counterparty resolution — wait titles + next-move subs share it. */
/** Just the display names — everything that resolves a counterparty needs
 *  these two and nothing else (badges and clocks are not counterparties). */
type CounterpartyNames = Pick<ComposeRailInput, "insurerNameByDispute" | "providerName">;

function counterpartyFor(l: ProjectedLetterStep, input: CounterpartyNames): string {
  if (l.recipientKind === "provider") return input.providerName ?? "the provider";
  if (l.recipientKind === "collector") return l.counterpartyName ?? "the collector";
  return input.insurerNameByDispute[l.disputeId] ?? "your plan";
}

function waitTitle(l: ProjectedLetterStep, input: ComposeRailInput): string {
  if (l.letterType === "insurance_appeal") {
    return CASE_RAIL.waitTitleAppeal(input.insurerNameByDispute[l.disputeId] ?? null);
  }
  if (l.letterType === "debt_validation") {
    return CASE_RAIL.waitTitleCollector(l.counterpartyName);
  }
  // Noun from the SAME copy table the send step and the band use — the old
  // private `letterNoun` lowercased LETTER_TYPE_LABELS, which produced "your
  // appeal to insurer letter" for the type it was most likely to hit.
  return CASE_RAIL.waitTitleGeneric(
    counterpartyFor(l, input),
    letterRailCopy(l.letterType).receiptNoun.toLowerCase(),
  );
}

function waitSub(l: ProjectedLetterStep): string | null {
  if (l.letterType === "insurance_appeal" && l.deadlineType === "plan_response") {
    return CASE_RAIL.waitSubAppeal;
  }
  if (l.letterType === "debt_validation") return CASE_RAIL.waitSubValidation;
  return null;
}

function buildWaitCard(
  l: ProjectedLetterStep,
  activeWaitCount: number,
  now: Date,
): RailWaitCard {
  const daysSinceSent = l.latestSendAt != null ? daysSinceLocal(l.latestSendAt, now) : null;
  // S314 — `engineDueDate` IS the guarded field now (null unless the engine
  // established a deadline), so the guard no longer has to be re-stated here.
  const daysRemaining =
    l.engineDueDate != null ? daysUntilLocal(l.engineDueDate, now) : null;
  const dated = daysRemaining != null;
  const dateLabel = dated ? fmtRailDate(l.engineDueDate!) : null;
  const overdue = dated && daysRemaining < 0;
  // S314 (Andrew) — the follow-up prompt, for sent letters with NO engine
  // deadline. Previously the rail showed no dated furniture at all in this
  // case (correctly refusing to call an estimate a deadline) — which meant the
  // genuinely useful signal, "when should I chase this", went with it. It is
  // shown as what it is: the date the letter asked them to reply by.
  const followUpDays =
    !dated && l.followUpDate != null ? daysUntilLocal(l.followUpDate, now) : null;
  // S302 (Andrew) — the elapsed-% BAR is GONE, in every state. The number in
  // the chip is the whole signal.
  //
  // The chip STAYS AMBER at every distance, including overdue. A red urgency
  // tone shipped briefly this session and Andrew removed it: "caution amber,
  // NEVER red" is a deliberate style fence (CaseSummary.tsx:7), and the override
  // is reverted rather than left as an exception nobody remembers agreeing to.
  const whnRows =
    l.letterType === "insurance_appeal"
      ? CASE_RAIL.whnAppeal(dated && !overdue ? dateLabel : null)
      : l.letterType === "debt_validation"
        ? CASE_RAIL.whnValidation()
        : null;
  return {
    disputeId: l.disputeId,
    chipSentAgo: daysSinceSent != null ? CASE_RAIL.chipSentAgo(daysSinceSent) : null,
    chipDeadline: dated ? CASE_RAIL.chipDeadline(dateLabel!, daysRemaining) : null,
    chipFollowUp:
      followUpDays != null
        ? CASE_RAIL.chipFollowUp(fmtRailDate(l.followUpDate!), followUpDays)
        : null,
    followUpSub: followUpDays != null ? CASE_RAIL.followUpSub : null,
    chipPause:
      !dated && l.letterType === "debt_validation" ? CASE_RAIL.chipCollectionPause : null,
    ctaLogResponse: CASE_RAIL.ctaLogResponse,
    door:
      l.letterType === "debt_validation"
        ? {
            kind: "collection_resumed",
            label: CASE_RAIL.doorCollectionResumed,
            ackLabel: CASE_RAIL.doorCollectionResumedAck,
          }
        : { kind: "something_else", label: CASE_RAIL.doorSomethingElse },
    foot: dated && !overdue ? CASE_RAIL.remindFoot(dateLabel!) : null,
    whn: whnRows
      ? {
          heading: CASE_RAIL.whnHeading,
          rows: whnRows,
          defaultOpen: activeWaitCount === 1,
        }
      : null,
  };
}

/**
 * The four net-new collections steps for a debt_validation letter, split by
 * where they belong in the chronology.
 *
 * Only FOUR, because two of the six the user sees already exist on the rail:
 * "Your debt validation letter is ready" is this letter's own send step, and
 * "What did the collector do?" is its waiting card — which is already
 * collections-specific (the undated §1692g wait, the "Collection must pause"
 * chip, the approved what-happens-next rows). Rebuilding either would put two
 * doors on the same act, which is the duplication this relocation removes.
 */
function buildCollectionsSteps(
  l: ProjectedLetterStep,
): { before: RailStepModel[]; after: RailStepModel[] } {
  // Both inputs ride the PROJECTION (l.collectionsSteps / l.collectorFirstContactDate)
  // rather than arriving as separate rail props — the rail has one input, and a
  // prop that does not exist cannot be forgotten on the way through.
  const steps = l.collectionsSteps;
  const before: RailStepModel[] = [];
  const after: RailStepModel[] = [];

  for (const step of COLLECTIONS_STEPS) {
    const stored = steps[step.id] ?? {};

    // TWO of the four steps are DATA-derived: their done-ness is the fact
    // itself, not a separate attestation.
    //
    //   packC:mailed        → the letter's own send record. Mark-as-sent IS the
    //                         attestation, which is what stops the rail asking
    //                         the user to re-assert a send they already reported.
    //   packC:first-contact → the stored §1692g anchor date.
    //
    // The first cut keyed first-contact on `checkedAt`, which NOTHING writes —
    // the date saves through the deadline-inputs route — so the step showed the
    // date and stayed blue forever, and pressing Save appeared to do nothing
    // (Andrew, S301 E2E round 2). A step whose answer is visible in its own
    // field must never need a second, invisible flag to look answered.
    const doneSource = step.doneFrom;
    const dataValue =
      doneSource === "send"
        ? (l.latestSendAt ?? null)
        : doneSource === "date"
          ? l.collectorFirstContactDate
          : null;
    const derivedFromSend = doneSource === "send";
    const doneIso = doneSource === "attestation" ? (stored.checkedAt ?? null) : dataValue;
    const skipped = doneSource === "attestation" && stored.skippedAt != null;
    const state: "open" | "done" | "skipped" = doneIso
      ? "done"
      : skipped
        ? "skipped"
        : "open";

    const value =
      doneSource === "date"
        ? l.collectorFirstContactDate
        : step.action.kind === "text"
          ? (stored.note ?? null)
          : null;

    const model: RailStepModel = {
      kind: "guide-step",
      key: `guide:${l.disputeId}:${step.id}`,
      badge: "",
      title: step.title,
      body: step.body,
      disputeId: l.disputeId,
      stepId: step.id,
      action: step.action,
      state,
      doneAt: doneIso ? fmtRailDate(doneIso) : null,
      skippable: step.skippable,
      value,
      derivedFromSend,
      doneSource,
    };

    if (step.phase === "before-send") before.push(model);
    else after.push(model);
  }

  return { before, after };
}

/**
 * The band above a letter's steps (S302, approved mock option B). Status keys
 * off the STAGE, not off a proxy: a letter with no send is a draft, a sent
 * letter with no outcome is a wait, and anything with a logged outcome names
 * that outcome. A closed letter whose outcome was never logged (legacy rows)
 * gets no chip rather than an invented one.
 */
function buildBand(
  l: ProjectedLetterStep,
  input: ComposeRailInput,
  position: number,
  total: number,
): Omit<RailLetterGroup, "steps" | "disputeId" | "key"> {
  const copy = letterRailCopy(l.letterType);
  const counterparty = counterpartyFor(l, input);
  let status: RailLetterGroup["status"] = null;
  if (l.outcome) {
    status = {
      tone: "green",
      label: CASE_RAIL.bandStatusAnswered(
        OUTCOME_LABELS[l.outcome.detail],
        l.outcome.loggedAt ? fmtRailDate(l.outcome.loggedAt) : null,
      ),
    };
  } else if (l.latestSendAt == null) {
    status = { tone: "slate", label: CASE_RAIL.bandStatusDraft };
  } else if (l.stage === "awaiting") {
    status = {
      tone: "amber",
      // Same dated rule the wait card's chip uses: only a REAL engine deadline
      // is ever called a deadline. responseDueDate's sent+30d display fallback
      // is not one, so an undated wait says "Waiting on their response".
      label: CASE_RAIL.bandStatusWaiting(
        l.deadlineType != null && l.responseDueDate != null
          ? fmtRailDate(l.responseDueDate)
          : null,
      ),
    };
  }
  return {
    eyebrow: CASE_RAIL.bandEyebrow(position, total),
    title: CASE_RAIL.bandTitle(copy.band, counterparty),
    status,
  };
}

/** One letter's steps, in their fixed intra-letter order. */
function buildLetterSteps(
  l: ProjectedLetterStep,
  input: ComposeRailInput,
  activeWaitCount: number,
): RailStepModel[] {
  const { letters, now, regulator } = input;
  const steps: RailStepModel[] = [];
  const copy = letterRailCopy(l.letterType);

  // S301 — collections guard-rail steps BRACKET this letter's send step:
  // "don't pay" + "when did they contact you" belong to the moment collections
  // started; the certified-mail pair belongs to the send itself. `phase` on the
  // registry row declares which side, so the composer never matches step ids.
  const collections = l.letterType === "debt_validation" ? buildCollectionsSteps(l) : null;
  if (collections) steps.push(...collections.before);

  if (l.latestSendAt == null) {
    steps.push({
      kind: "send-draft",
      key: `send:${l.disputeId}`,
      badge: "",
      title: copy.sendTitle,
      disputeId: l.disputeId,
      // The DRAFT variant names the act; the sent one below stays a plain
      // "Open this letter" because there is nothing left to send.
      openLetterLabel: CASE_RAIL.ctaOpenLetterToSend,
      // S320 — enclosure requirements resolved at compose time from the ONE
      // letter-type declaration; the renderer just paints what's here.
      enclosures: getLetterEnclosures(l.letterType),
      letterType: l.letterType,
      // S312 (F2-S312.1) — straight from the projection (row-truth); the rail
      // swaps the send CTA for the Dismiss/Keep banner when the demand died.
      zeroDemand: l.noRemainingDemand,
    });
  } else {
    steps.push({
      kind: "send-receipt",
      key: `send:${l.disputeId}`,
      badge: "",
      title: copy.sendTitle,
      receipt: CASE_RAIL.sendReceipt(
        copy.receiptNoun,
        counterpartyFor(l, input),
        fmtRailDate(l.latestSendAt),
        l.mailedCertified,
      ),
      disputeId: l.disputeId,
      openLetterLabel: CASE_RAIL.ctaOpenLetter,
      unsend: {
        loggedOutcomeLabel: l.outcome ? OUTCOME_LABELS[l.outcome.detail] : null,
        loggedOutcomeDateLabel: l.outcome?.loggedAt ? fmtRailDate(l.outcome.loggedAt) : null,
      },
    });
  }

  if (collections) steps.push(...collections.after);

  if (contributesWaitStep(l)) {
    if (l.stage === "awaiting") {
      steps.push({
        kind: "wait-active",
        key: `wait:${l.disputeId}`,
        badge: "",
        title: waitTitle(l, input),
        sub: waitSub(l),
        card: buildWaitCard(l, activeWaitCount, now),
      });
    } else {
      steps.push({
        kind: "wait-receipt",
        key: `wait:${l.disputeId}`,
        badge: "",
        title: waitTitle(l, input),
        receipt: l.outcome
          ? CASE_RAIL.outcomeReceipt(
              OUTCOME_LABELS[l.outcome.detail],
              l.outcome.loggedAt ? fmtRailDate(l.outcome.loggedAt) : null,
            )
          : "",
        // S303 — keyed on the FACT (a result was logged), not on the stage.
        // Stage was a proxy that merely correlated: it meant "you can still
        // escalate", so a letter at the END of its ladder had a logged result
        // and no way to take it back from the rail. On the Ballard case two of
        // three logged results were already uncorrectable here, and the fold
        // would have made it three. Safe with no route change — the S302 send
        // gate fires only on a genuine mark-sent (`sent_at == null`), and an
        // undo runs on a letter that IS sent.
        undo: l.outcome != null,
        disputeId: l.disputeId,
      });
    }
  }
  // Stage-8 "Your next move" (phase 1b) — the letter's escalation offer, and
  // (S303) the regulator card once this letter has been answered.
  //
  // The regulator trigger is the ANSWER (isAdverseOutcome), not the ladder
  // position. The old rule — stage `next`, or a resolved terminal rung — was a
  // proxy wrong at both ends: it HID the card on a partially-paid letter the
  // user had escalated, and it SHOWED it after a WON external review. Keying
  // on the outcome also makes the card immune to stage changes, which is what
  // lets the resolved fold move stages without moving cards.
  //
  // ⚠ NOT simply "any outcome but a win": needs_info and no_response leave the
  // letter at stage `awaiting`, so that reading would render an active waiting
  // card and "take it to a regulator" side by side on the same letter.
  {
    const answered = l.outcome != null && isAdverseOutcome(l.outcome.detail);
    if (l.stage === "next" || answered) {
      // S303 — the composer no longer decides whether the rung is open; it
      // only fetches the CTA copy for a decision already made. `stage ===
      // "next"` is now a true statement (the projector applies
      // nextRungStillOpen), so this cannot disagree with it — where the
      // composer's own copy of the suppression ran AFTER the stage it should
      // have set, leaving the button right and the status wrong.
      const sns =
        l.stage === "next" && l.outcome
          ? suggestNextStep(l.letterType as DisputeLetterType, l.outcome.detail)
          : null;
      const counterparty = counterpartyFor(l, input);
      const subRaw =
        l.outcome?.detail === "denied_fully"
          ? CASE_RAIL.nextMoveSubSaidNo(counterparty)
          : l.outcome?.detail === "denied_partial" ||
              l.outcome?.detail === "denied_some_covered"
            ? CASE_RAIL.nextMoveSubPaidPart(counterparty)
            : l.outcome?.detail === "denied_counteroffer"
              ? CASE_RAIL.nextMoveSubCounteroffer(counterparty)
              : null;
      const sub = sns ? subRaw : null;
      // EVERY door, always (Andrew, S303) — ordered with this letter's
      // suggestion first. suggestDoors keeps its job of naming what fits this
      // letter; it no longer decides what the user is allowed to see. We
      // cannot detect surprise-billing situations at all today (nsa_applicable
      // is always UNKNOWN — tracker Item U), so filtering doors on our own
      // signal would hide a legitimate regulator behind a detection we know is
      // blind. The descriptions do the filtering; the chip does the steering.
      // S325 (`forum_menu_v1`) — the routed pool replaces the generic doors
      // when the flag-ON input is present: member-fact routing, fixed role
      // order, nothing featured (R14). Legacy path (forumMenu null) is
      // byte-identical to pre-S325 behavior, suggestDoors ordering included.
      const routedState = input.forumMenu
        ? routedPoolForLetter(input.forumMenu, {
            recipientKind: l.recipientKind,
            letterType: l.letterType,
            disputeId: l.disputeId,
          })
        : null;
      const suggested = routedState
        ? []
        : suggestDoors({
            track: l.recipientKind === "insurer" ? "insurer" : "provider",
            hasCollections: letters.some(
              (x) => x.letterType === "debt_validation" && x.stage !== "none",
            ),
            grounds: l.letterType === "balance_billing" ? ["balance_billing"] : [],
          });
      // ONE tile pipeline for both paths: the routed pool projects into the
      // same (id, name, desc, href) shape the generic doors use, plus the
      // routed-only fields — so the filing-record machinery below cannot
      // fork between paths.
      const doorSource: Array<{
        id: string;
        name: string;
        desc: string;
        href: string;
        phone?: string | null;
        actionOnly?: boolean;
        cannotLines?: readonly string[];
        noLimitationNote?: boolean;
      }> = routedState
        ? routedState.doors.map((f) => ({
            id: f.id,
            name: f.menuLabel,
            desc: f.menuHint,
            href: f.url,
            phone: f.phone ?? null,
            actionOnly: f.actionOnly,
            cannotLines: f.cannot,
            noLimitationNote: f.role === "licensing_discipline" && f.cannot.length === 0,
          }))
        : [
            ...suggested,
            ...COMPLAINT_DOORS.map((d) => d.id).filter((id) => !suggested.includes(id)),
          ].flatMap((id) => {
            const d = COMPLAINT_DOORS.find((x) => x.id === id);
            return d ? [{ id: d.id, name: d.name, desc: d.desc, href: d.href }] : [];
          });
      const filedStep = PACK_D_STEPS.find((s) => s.id === "packD:filed");
      steps.push({
        kind: "next-move",
        key: `next:${l.disputeId}`,
        badge: "",
        title: CASE_RAIL.nextMoveTitle,
        sub,
        move: {
          disputeId: l.disputeId,
          letterOffer: sns
            ? {
                targetLetterType: sns.nextLetterType,
                title: sns.ctaLabel,
                sub:
                  sns.nextLetterType === "external_review"
                    ? CASE_RAIL.startLetterSubExternalReview(
                        l.outcome?.loggedAt ? fmtRailDate(l.outcome.loggedAt) : null,
                      )
                    : (sns.note ?? null),
                requiresPro: letterRequiresPro(sns.nextLetterType),
                proChip: CASE_RAIL.proChip,
                cta: CASE_RAIL.startLetterCta,
              }
            : null,
          regulator: answered
            ? {
                title: PACK_D_TITLE,
                lead: CASE_RAIL.regulatorLead,
                doors: doorSource.map((d, i) => {
                  const mine =
                    regulator.filings.find(
                      (f) => f.doorId === d.id && f.disputeId === l.disputeId,
                    ) ?? null;
                  // The most recent filing with this agency about a DIFFERENT
                  // letter. filings arrive ascending, so the last match is it.
                  const other = mine
                    ? null
                    : (regulator.filings
                        .filter((f) => f.doorId === d.id && f.disputeId !== l.disputeId)
                        .at(-1) ?? null);
                  return {
                      id: d.id,
                      name: d.name,
                      desc: d.desc,
                      href: d.href,
                      // R14: the routed pool features nothing — chip only on
                      // the legacy path's track door.
                      chip: !routedState && i === 0 ? PACK_D_SUGGESTED_CHIP : null,
                      phone: d.phone ?? null,
                      actionOnly: d.actionOnly ?? false,
                      cannotLines: d.cannotLines ?? [],
                      noLimitationNote: d.noLimitationNote ?? false,
                      filedAt: mine?.filedAt ?? null,
                      filedAtLabel: mine ? fmtRailDate(mine.filedAt) : null,
                      note: mine?.note ?? null,
                      stepId: regulatorFilingStepId(l.disputeId, d.id),
                      earlier: other
                        ? {
                            label: CASE_RAIL.regulatorFiledEarlier(
                              fmtRailDate(other.filedAt),
                              // The letter it was filed about, by its own band
                              // noun — the same table the group headers use, so
                              // the two can never name a letter differently.
                              letterRailCopy(
                                letters.find((x) => x.disputeId === other.disputeId)
                                  ?.letterType ?? "",
                              ).band,
                            ),
                            note: other.note,
                          }
                        : null,
                    };
                }),
                filedLabel: filedStep?.checkboxLabel ?? "Complaint filed",
                notePlaceholder: CASE_RAIL.filedNotePlaceholder,
                fileAgainLabel: CASE_RAIL.regulatorFileAgainLabel,
                // Offered only while THIS letter has nothing filed — "I'm not
                // filing about this letter" and "I filed about this letter"
                // must never both be true. Per letter, so a declination here
                // leaves every other letter's answer untouched.
                skip: regulator.filings.some((f) => f.disputeId === l.disputeId)
                  ? null
                  : {
                      stepId: regulatorSkipStepId(l.disputeId),
                      declined: regulator.declinedByDispute[l.disputeId] != null,
                      declinedAtLabel: regulator.declinedByDispute[l.disputeId]
                        ? fmtRailDate(regulator.declinedByDispute[l.disputeId])
                        : null,
                    },
                foot: CASE_RAIL.regulatorFoot,
                routed: routedState
                  ? {
                      notice: routedState.notice,
                      screeningNeeded: routedState.screeningNeeded,
                      denialBasisNeeded: routedState.denialBasisNeeded,
                      planId: input.forumMenu?.planId ?? null,
                    }
                  : null,
              }
            : null,
        },
      });
    }
  }

  return steps;
}

/**
 * Compose the extension rail: one group per letter, flat badge numbering
 * across them.
 *
 * Letters arrive from the projector already ordered (birth, then id), and
 * every step inside a letter has a fixed position, so the ordering needs no
 * timestamps at all — the anchor/sort machinery this replaced existed only to
 * re-derive an order the data already had.
 */
function composeRailGroups(input: ComposeRailInput): RailLetterGroup[] {
  const { letters, offers, firstNumber } = input;
  const activeWaitCount = letters.filter((l) => l.stage === "awaiting").length;
  const onRail = letters.filter(contributesSteps);
  // Written and unwritten letters share ONE count (Andrew, S305): the point of
  // the parallel track is that the claim is owed two letters, and "Letter 1 of
  // 1" beside a second band would deny it.
  const total = onRail.length + offers.length;

  let n = firstNumber;
  const groups: RailLetterGroup[] = onRail.map((l, i) => ({
    key: l.disputeId,
    disputeId: l.disputeId,
    ...buildBand(l, input, i + 1, total),
    steps: buildLetterSteps(l, input, activeWaitCount).map((s) => ({
      ...s,
      badge: String(n++),
    })),
  }));

  // Offers come LAST, and the numbering simply continues — flat, no a/b. Those
  // badges stay reserved for §0.9a rule 1's same-trigger sibling letters; an
  // appeal and a provider dispute answer DIFFERENT triggers against different
  // parties, so they are not siblings under that rule (Andrew, S304).
  for (const o of offers) {
    const copy = letterRailCopy(o.letterType);
    groups.push({
      key: `offer:${o.party}`,
      disputeId: null,
      eyebrow: CASE_RAIL.bandEyebrow(groups.length + 1, total),
      title: CASE_RAIL.bandTitle(copy.band, offerCounterparty(o, input)),
      // No chip. The status vocabulary describes a letter's progress, and this
      // letter has none — an absent chip, never a guess (the rule the band
      // already applies to a closed letter with no logged outcome).
      status: null,
      steps: [
        {
          kind: "letter-offer",
          key: `offer:${o.party}`,
          badge: String(n++),
          title: copy.sendTitle,
          sub: GUIDE_4B.sub,
          offer: {
            party: o.party,
            letterType: o.letterType,
            reasonTitle: o.reason?.title ?? null,
            reasonDetail: o.reason?.detail ?? null,
            stepId: letterOfferSkipStepId(o.party),
            declined: o.declinedAt != null,
            declinedAtLabel: o.declinedAt ? fmtRailDate(o.declinedAt) : null,
          },
        },
      ],
    });
  }

  return groups;
}

/**
 * The counterparty an offered letter would be addressed to.
 *
 * The insurer branch deliberately has no lookup: `insurerNameByDispute` is
 * resolved from each LETTER's own pinned plan, and mid-year plan changes mean
 * two letters on one claim can pin different plans — so borrowing another
 * letter's insurer for a letter that does not exist would be a guess. "your
 * plan" is the shipped fallback for exactly that, and it is never wrong.
 */
function offerCounterparty(o: RailLetterOffer, input: CounterpartyNames): string {
  return o.party === "provider" ? (input.providerName ?? "the provider") : "your plan";
}

/**
 * THE rail composition — groups and the resolved-case summary, from one pass.
 *
 * S303: these were two calls on two different components (ClaimDetail computed
 * the resolution, CaseRail composed the groups), so the same rail was composed
 * TWICE per render from the same inputs. That duplication is also why the fold
 * could collapse a case with work outstanding: the resolution only ever saw
 * `letters`, never the steps, so it could not know what the rail was still
 * asking. Composing once makes the summary read the very steps it is folding —
 * the count and the badges derive from one object, so they cannot disagree.
 */
export function composeRail(input: ComposeRailInput): {
  groups: RailLetterGroup[];
  resolution: RailCaseResolution | null;
} {
  const groups = composeRailGroups(input);
  const openStepCount = groups.reduce(
    (n, g) => n + g.steps.filter(railStepIsOpen).length,
    0,
  );
  return { groups, resolution: railCaseResolution(input, openStepCount) };
}
