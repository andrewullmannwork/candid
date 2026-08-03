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
import type { ProjectedLetterStep } from "@/lib/case/timeline-projector";
import type { DisputeLetterType } from "@/lib/billing/types";
import { OUTCOME_LABELS, suggestNextStep } from "@/lib/disputes/outcome-taxonomy";
import { letterRequiresPro } from "@/lib/disputes/letter-access";
import {
  formatLetterDateShort,
  daysSinceLocal,
  daysUntilLocal,
} from "@/lib/disputes/letter-type";
import {
  CASE_RAIL,
  COLLECTIONS_STEPS,
  letterRailCopy,
  COMPLAINT_DOORS,
  PACK_D_STEPS,
  PACK_D_SUGGESTED_CHIP,
  PACK_D_TITLE,
  isTerminalRung,
  suggestDoors,
  type CollectionsStepAction,
} from "@/lib/guides/pack-registry";

export interface RailWaitCard {
  disputeId: string;
  /** Slate pill — "Sent N days ago" / "Sent today". Null when unsent (never for a wait). */
  chipSentAgo: string | null;
  /** Amber pill — only with a real engine deadline (deadlineType != null). */
  chipDeadline: string | null;
  /** Slate pill — undated §1692g wait ("Collection must pause…"). */
  chipPause: string | null;
  /** 2–100 elapsed % of the send→deadline window; null = no bar (undated). */
  countdownPct: number | null;
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
  regulator: {
    title: string;
    lead: string;
    doors: RailDoorTile[];
    /** The PACK_D_STEPS "packD:filed" row verbatim + the dispute's current
     *  state — persistence is the EXISTING checklist POST (one state, shared
     *  with the dispute-side Pack D until phase 3 retires that mount). */
    attest: {
      key: string;
      title: string;
      checkboxLabel: string;
      notePlaceholder: string;
      filed: boolean;
      note: string | null;
    };
    foot: string;
  };
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
  disputeId: string;
  /** "Letter 2 of 3". */
  eyebrow: string;
  /** "Debt validation — Cascade Recovery". */
  title: string;
  /** Draft / waiting / answered, at a glance. Null when a closed letter has no
   *  logged outcome to name (legacy rows) — an absent chip, never a guess. */
  status: { tone: "slate" | "amber" | "green"; label: string } | null;
  steps: RailStepModel[];
}

export interface ComposeRailInput {
  letters: ProjectedLetterStep[];
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
 * True when the rail extends past the prep steps — ClaimDetail uses this to
 * decide whether the prep rail still owns the first letter's send step
 * (S302: it does not, once any letter exists). Same predicate the composer
 * uses, so the two can never disagree.
 */
export function railHasExtension(letters: ProjectedLetterStep[]): boolean {
  return letters.some(contributesSteps);
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
export function railCaseResolution(
  // Narrowed to what it actually reads — the summary has no badges and no
  // clock, so demanding the full ComposeRailInput would have meant callers
  // passing a dummy `firstNumber` and a `now` nothing looks at.
  input: Pick<ComposeRailInput, "letters" | "insurerNameByDispute" | "providerName">,
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
  ].filter((x): x is string => x != null);

  return {
    headline: OUTCOME_LABELS[closer.outcome!.detail],
    meta: parts.join(" · "),
    expandLabel: CASE_RAIL.foldExpand,
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
  const daysRemaining =
    l.deadlineType != null && l.responseDueDate != null
      ? daysUntilLocal(l.responseDueDate, now)
      : null;
  const dated = daysRemaining != null;
  const dateLabel = dated ? fmtRailDate(l.responseDueDate!) : null;
  const overdue = dated && daysRemaining < 0;
  let countdownPct: number | null = null;
  if (dated && daysSinceSent != null) {
    if (overdue) countdownPct = 100;
    else {
      const span = daysSinceSent + daysRemaining;
      const pct = span <= 0 ? 100 : Math.round((daysSinceSent / span) * 100);
      countdownPct = Math.min(100, Math.max(2, pct));
    }
  }
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
    chipPause:
      !dated && l.letterType === "debt_validation" ? CASE_RAIL.chipCollectionPause : null,
    countdownPct,
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
): Omit<RailLetterGroup, "steps" | "disputeId"> {
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
  const { letters, now } = input;
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
      openLetterLabel: CASE_RAIL.ctaOpenLetter,
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
        undo: l.stage === "next",
        disputeId: l.disputeId,
      });
    }
  }
  // Stage-8 "Your next move" (phase 1b) — per letter at stage `next` (letter
  // offer + regulator card), and doors-only at resolved TERMINAL rungs
  // (isTerminalRung: the ladder's end is where the regulator card matters
  // most; suggestNextStep is null there, so stage alone would never surface
  // it). Last in the letter's block — it is what this letter's outcome opens.
  {
    const terminalResolved =
      l.stage === "resolved" &&
      l.outcome != null &&
      isTerminalRung({ letterType: l.letterType, status: l.outcome.status });
    if (l.stage === "next" || terminalResolved) {
      const snsRaw =
        l.stage === "next" && l.outcome
          ? suggestNextStep(l.letterType as DisputeLetterType, l.outcome.detail)
          : null;
      // Offer suppression (Andrew, 1b E2E): once a letter of the suggested
      // type EXISTS on the case it has its own rung/steps — a lingering
      // start-offer would duplicate it. The step keeps the regulator card;
      // the "two paths" sub retires with the offer (doors-only anatomy,
      // same as the terminal rung).
      const sns =
        snsRaw &&
        !letters.some(
          (x) =>
            x.disputeId !== l.disputeId &&
            x.letterType === snsRaw.nextLetterType &&
            x.stage !== "none",
        )
          ? snsRaw
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
      const suggested = suggestDoors({
        track: l.recipientKind === "insurer" ? "insurer" : "provider",
        hasCollections: letters.some(
          (x) => x.letterType === "debt_validation" && x.stage !== "none",
        ),
        grounds: l.letterType === "balance_billing" ? ["balance_billing"] : [],
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
          regulator: {
            title: PACK_D_TITLE,
            lead: CASE_RAIL.regulatorLead,
            doors: suggested.flatMap((id, i) => {
              const d = COMPLAINT_DOORS.find((x) => x.id === id);
              return d
                ? [
                    {
                      id: d.id,
                      name: d.name,
                      desc: d.desc,
                      href: d.href,
                      chip: i === 0 ? PACK_D_SUGGESTED_CHIP : null,
                    },
                  ]
                : [];
            }),
            attest: {
              key: "packD:filed",
              title: filedStep?.title ?? "File it, then log the confirmation number",
              checkboxLabel: filedStep?.checkboxLabel ?? "Complaint filed",
              notePlaceholder: CASE_RAIL.filedNotePlaceholder,
              filed: l.regulatorFiled,
              note: l.regulatorFiledNote,
            },
            foot: CASE_RAIL.regulatorFoot,
          },
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
export function composeRailGroups(input: ComposeRailInput): RailLetterGroup[] {
  const { letters, firstNumber } = input;
  const activeWaitCount = letters.filter((l) => l.stage === "awaiting").length;
  const onRail = letters.filter(contributesSteps);

  let n = firstNumber;
  return onRail.map((l, i) => ({
    disputeId: l.disputeId,
    ...buildBand(l, input, i + 1, onRail.length),
    steps: buildLetterSteps(l, input, activeWaitCount).map((s) => ({
      ...s,
      badge: String(n++),
    })),
  }));
}
