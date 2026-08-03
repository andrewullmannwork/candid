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
 * Composition rules (agenda §0 + §0.9a/§0.9d):
 *  - Steps are strictly chronological after the prep rail: each SENT letter
 *    contributes a WAIT step anchored at latestSendAt; each NON-PRIMARY
 *    letter additionally contributes a SEND step anchored at startAt (the
 *    primary letter's send step is the existing 4b — never duplicated here).
 *  - Numbering continues from `firstNumber` (5 after the guided 4a/4b split);
 *    badges are strings so the a/b same-trigger grammar can land later
 *    without a model change (grouping logic deliberately deferred — no
 *    trigger field exists until T2 dual-grounds).
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
  LETTER_TYPE_LABELS,
  formatLetterDateShort,
  daysSinceLocal,
  daysUntilLocal,
} from "@/lib/disputes/letter-type";
import {
  CASE_RAIL,
  COLLECTIONS_STEPS,
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
    };

/**
 * The letter a rail step belongs to — the S300 deep-link anchor key.
 *
 * Every variant already carries its dispute id (directly, or one hop through
 * `card`/`move`), so the anchor needs no new model field and cannot drift from
 * what the step renders. Total by construction: a new variant that forgets to
 * expose one fails the exhaustiveness check below rather than silently
 * anchoring nothing.
 */
export function railStepDisputeId(step: RailStepModel): string {
  switch (step.kind) {
    case "wait-active":
      return step.card.disputeId;
    case "next-move":
      return step.move.disputeId;
    case "wait-receipt":
    case "send-receipt":
    case "send-draft":
    case "guide-step":
      return step.disputeId;
    default: {
      const _exhaustive: never = step;
      return _exhaustive;
    }
  }
}

export interface ComposeRailInput {
  letters: ProjectedLetterStep[];
  /** The dispute the prep rail's 4b renders — its send step is never duplicated. */
  primaryDisputeId: string | null;
  /** First extension badge number (5 after the guided 4a/4b split). */
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
  /**
   * S301 — `claims.metadata.guideSteps`, the SAME claim-scoped store Pack A′
   * already writes through. Reused rather than given its own home so the
   * collections attestations arrive server-stamped (which is where the rail's
   * "done «when»" comes from) and stay on the bill, surviving escalation.
   */
  guideSteps?: Record<
    string,
    { checkedAt?: string | null; skippedAt?: string | null; note?: string }
  >;
  /** The collector's first-contact date (dispute metadata) — step 2's value. */
  collectorFirstContactDate?: string | null;
}

/**
 * "Sep 29" — the shared letter-date rule (letter-type.ts, S299): timestamps
 * land on the user's LOCAL calendar; date-only strings pin to local midnight.
 * Re-exported under the rail's name so consumers keep one import site.
 */
export const fmtRailDate = formatLetterDateShort;

/** "billing dispute letter" — generic-title noun from the ONE label source. */
function letterNoun(letterType: string): string {
  const label =
    LETTER_TYPE_LABELS[letterType as DisputeLetterType] ?? letterType.replace(/_/g, " ");
  return `${label.toLowerCase()} letter`;
}

/** "Billing Dispute letter" — generic receipt label from the same source. */
function letterLabel(letterType: string): string {
  const label =
    LETTER_TYPE_LABELS[letterType as DisputeLetterType] ?? letterType.replace(/_/g, " ");
  return `${label} letter`;
}

/** A non-primary letter renders its own send step (the primary's send is 4b). */
function contributesSendStep(l: ProjectedLetterStep, primaryDisputeId: string | null): boolean {
  return l.stage !== "none" && l.disputeId !== primaryDisputeId;
}

/** Every sent, non-cancelled letter renders a wait step (active or receipt). */
function contributesWaitStep(l: ProjectedLetterStep): boolean {
  return l.stage !== "none" && l.latestSendAt != null;
}

/**
 * True when the rail extends past the prep steps — ClaimDetail uses this for
 * 4b's `last` prop and the mount decision; compose() uses the SAME predicates,
 * so the two can never disagree.
 */
export function railHasExtension(
  letters: ProjectedLetterStep[],
  primaryDisputeId: string | null,
): boolean {
  return letters.some(
    (l) => contributesSendStep(l, primaryDisputeId) || contributesWaitStep(l),
  );
}

/** ONE counterparty resolution — wait titles + next-move subs share it. */
function counterpartyFor(l: ProjectedLetterStep, input: ComposeRailInput): string {
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
  return CASE_RAIL.waitTitleGeneric(counterpartyFor(l, input), letterNoun(l.letterType));
}

function waitSub(l: ProjectedLetterStep): string | null {
  if (l.letterType === "insurance_appeal" && l.deadlineType === "plan_response") {
    return CASE_RAIL.waitSubAppeal;
  }
  if (l.letterType === "debt_validation") return CASE_RAIL.waitSubValidation;
  return null;
}

function sendTitle(l: ProjectedLetterStep): string {
  if (l.letterType === "debt_validation") return CASE_RAIL.sendTitleValidation;
  return CASE_RAIL.sendTitleGeneric(letterNoun(l.letterType));
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
  input: ComposeRailInput,
): { before: RailStepModel[]; after: RailStepModel[] } {
  const steps = input.guideSteps ?? {};
  const before: RailStepModel[] = [];
  const after: RailStepModel[] = [];

  for (const step of COLLECTIONS_STEPS) {
    const stored = steps[step.id] ?? {};
    // packC:mailed has NO boolean of its own — mark-as-sent IS the attestation,
    // so its state reads the letter. That is what keeps the rail from asking the
    // user to re-assert something they already told us (and what made the old
    // pack say "Your letter is ready" on a letter sent days earlier).
    const derivedFromSend = step.id === "packC:mailed";
    const doneIso = derivedFromSend ? (l.latestSendAt ?? null) : (stored.checkedAt ?? null);
    const skipped = !derivedFromSend && stored.skippedAt != null;
    const state: "open" | "done" | "skipped" = doneIso
      ? "done"
      : skipped
        ? "skipped"
        : "open";

    const value =
      step.id === "packC:first-contact"
        ? (input.collectorFirstContactDate ?? null)
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
    };

    if (step.id === "packC:not-paid" || step.id === "packC:first-contact") before.push(model);
    else after.push(model);
  }

  return { before, after };
}

export function composeRailSteps(input: ComposeRailInput): RailStepModel[] {
  const { letters, primaryDisputeId, firstNumber, now } = input;
  const activeWaitCount = letters.filter((l) => l.stage === "awaiting").length;

  const anchored: Array<{ anchor: number; order: number; model: RailStepModel }> = [];
  let order = 0;
  const ts = (iso: string): number => {
    const t = Date.parse(iso);
    return Number.isNaN(t) ? 0 : t;
  };

  for (const l of letters) {
    // S301 — collections guard-rail steps BRACKET this letter's send step:
    // "don't pay" + "when did they contact you" are about the moment collections
    // started (anchored at the letter's birth, pushed before the send step), and
    // the certified-mail pair is about the send itself (anchored at the send).
    // Equal anchors fall back to push order, so the sequence reads correctly
    // whether or not the letter has been sent yet.
    const collections =
      l.letterType === "debt_validation" ? buildCollectionsSteps(l, input) : null;
    if (collections) {
      for (const m of collections.before) {
        anchored.push({ anchor: ts(l.startAt), order: order++, model: m });
      }
    }
    if (contributesSendStep(l, primaryDisputeId)) {
      if (l.latestSendAt == null) {
        anchored.push({
          anchor: ts(l.startAt),
          order: order++,
          model: {
            kind: "send-draft",
            key: `send:${l.disputeId}`,
            badge: "",
            title: sendTitle(l),
            disputeId: l.disputeId,
            openLetterLabel: CASE_RAIL.ctaOpenLetter,
          },
        });
      } else {
        const dateLabel = fmtRailDate(l.latestSendAt);
        anchored.push({
          anchor: ts(l.startAt),
          order: order++,
          model: {
            kind: "send-receipt",
            key: `send:${l.disputeId}`,
            badge: "",
            title: sendTitle(l),
            receipt:
              l.letterType === "debt_validation"
                ? CASE_RAIL.sendReceiptValidation(l.counterpartyName, dateLabel, l.mailedCertified)
                : CASE_RAIL.sendReceiptGeneric(letterLabel(l.letterType), dateLabel, l.mailedCertified),
            disputeId: l.disputeId,
            openLetterLabel: CASE_RAIL.ctaOpenLetter,
          },
        });
      }
    }
    if (collections) {
      const sendAnchor = ts(l.latestSendAt ?? l.startAt);
      for (const m of collections.after) {
        anchored.push({ anchor: sendAnchor, order: order++, model: m });
      }
    }
    if (contributesWaitStep(l)) {
      const anchor = ts(l.latestSendAt!);
      if (l.stage === "awaiting") {
        anchored.push({
          anchor,
          order: order++,
          model: {
            kind: "wait-active",
            key: `wait:${l.disputeId}`,
            badge: "",
            title: waitTitle(l, input),
            sub: waitSub(l),
            card: buildWaitCard(l, activeWaitCount, now),
          },
        });
      } else {
        anchored.push({
          anchor,
          order: order++,
          model: {
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
          },
        });
      }
    }
    // Stage-8 "Your next move" (phase 1b) — per letter at stage `next`
    // (letter offer + regulator card), and doors-only at resolved TERMINAL
    // rungs (isTerminalRung: the ladder's end is where the regulator card
    // matters most; suggestNextStep is null there, so stage alone would
    // never surface it). Anchored at the logged outcome — it lands after
    // the waits, chronologically honest.
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
      anchored.push({
        anchor: ts(l.outcome?.loggedAt ?? l.latestSendAt ?? l.startAt),
        order: order++,
        model: {
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
        },
      });
    }
  }

  anchored.sort((a, b) => a.anchor - b.anchor || a.order - b.order);
  return anchored.map((a, i) => ({ ...a.model, badge: String(firstNumber + i) }));
}
