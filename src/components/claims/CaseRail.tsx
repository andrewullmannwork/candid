"use client";

/**
 * CaseRail — the extended claim rail's live phase (S299, timeline unification
 * phase 1a; approved mock: plans/mocks/s298-extended-rail-mock.html Panels A+B).
 *
 * Mounted by ClaimDetail below the prep steps when `case_rail_v1` is ON and any
 * letter exists. Renders EXCLUSIVELY from rail-steps models (which compose
 * EXCLUSIVELY from the projector — agenda §1 one derivation): per-letter
 * waiting cards (chips + countdown + "What happens next"), collapsed receipts
 * for sent/answered steps.
 *
 * S302 phase 3 — the rail owns EVERY letter's send step, grouped one block per
 * letter under a band. Before this the first letter's send step was the prep
 * rail's 4b, so one letter rendered with guided-step anatomy and the rest
 * rendered with rail anatomy (Andrew, S301: "each letter is a little
 * different"). 4b now renders only before the first letter exists.
 *
 * Phase-1a action contract (Andrew, S299 E2E round): the wait-card options
 * act INLINE on the claim page via the EXISTING machinery — "Log their
 * response" opens the same OutcomeReportingModal the dispute page mounts,
 * "Something else happened" opens the same CollectorModal → escalate route,
 * "Undo this result" calls the same outcome-undo request, and the
 * "Collection resumed anyway" door posts a capture-only case event (ruling
 * 6). All four reuse dispute-side components/endpoints verbatim — zero new
 * server machinery. "Open this letter" remains the one navigation.
 *
 * RailStep lives HERE (moved verbatim from ClaimDetail at S299) so the rail
 * chrome is importable without a module cycle — ClaimDetail imports CaseRail
 * to mount it, exactly like it already imports ShowFullStepButton from
 * GuidedPhoneSteps (chrome exported from the feature module that owns it).
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ShowFullStepButton } from "@/components/claims/GuidedPhoneSteps";
import { UnsendControl } from "@/components/disputes/UnsendControl";
import { CASE_RAIL, COLLECTIONS_CHROME } from "@/lib/guides/pack-registry";
import {
  type RailCaseResolution,
  type RailDoorTile,
  type RailLetterGroup,
  type RailStepModel,
  type RailWaitCard,
} from "@/lib/case/rail-steps";

// ── Surface 3 — flagged-bill guided step rail chrome ──────────────────────
// Numbered step section per design bill-detail.jsx StepSection + styles.css
// .bd-step family: 30px blue number circle (green ✓ when done), 1.5px
// connector line, body indented 43px on ≥sm. `headerOnly` renders just the
// header (the step body lives outside — the in-place line-items table);
// `last` drops the connector + bottom padding. Exported for reuse by other
// guided flows (and the dev preview harness).
export function RailStep({
  n,
  title,
  sub,
  done,
  attention,
  skipped,
  right,
  last,
  headerOnly,
  dataLetter,
  children,
}: {
  /** Badge content — numeric for the classic rail, "4a"/"4b" for the S297 split. */
  n: number | string;
  title: string;
  sub?: React.ReactNode;
  done?: boolean;
  /**
   * S291 (Andrew) — this step still needs the user, and they've moved past it.
   * Amber badge keeping the NUMBER (not a check): the step is skipped, not
   * finished, so it must stay findable. `done` wins if both are set.
   */
  attention?: boolean;
  /**
   * S301 — the user DISMISSED this step. Grey badge with a dash, never a check:
   * a declined step must not read as a performed one. `done` wins if both set.
   */
  skipped?: boolean;
  right?: React.ReactNode;
  last?: boolean;
  headerOnly?: boolean;
  /**
   * S300 phase 2b — the deep-link anchor. Keyed on the LETTER (dispute id),
   * never on the step number: a follow-up email sits in an inbox for weeks,
   * and phase 3 renumbers this rail. Dispute ids are permanent, so old email
   * links keep landing correctly after the rail is restructured.
   */
  dataLetter?: string | null;
  children?: React.ReactNode;
}) {
  return (
    <section
      data-case-letter={dataLetter ?? undefined}
      className={!last && !headerOnly ? "relative pb-[30px]" : "relative"}
    >
      {!last && !headerOnly && (
        <span
          className="absolute bottom-1 left-[14px] top-[34px] hidden w-[1.5px] bg-gray-200 sm:block"
          aria-hidden
        />
      )}
      <header className="mb-3.5 flex flex-wrap items-start gap-3.5">
        <span
          className={
            // leading-none: without it the glyph sits off-centre in the 30px
            // circle (Andrew, S301 \u2014 "the numbers are not centred in their
            // bubbles"); grid centring positions the LINE BOX, not the glyph.
            "relative z-10 grid h-[30px] w-[30px] flex-shrink-0 place-items-center rounded-full text-sm font-bold leading-none text-white " +
            (done
              ? "bg-emerald-700 shadow-[0_2px_8px_rgba(4,120,87,0.25)]"
              : skipped
                ? "bg-gray-300 text-gray-600 shadow-none"
                : attention
                  ? "bg-amber-500 shadow-[0_2px_8px_rgba(245,158,11,0.28)]"
                  : "bg-blue-600 shadow-[0_2px_8px_rgba(37,99,235,0.25)]")
          }
        >
          {done ? "\u2713" : skipped ? "\u2013" : n}
        </span>
        {/* S297 (Andrew E2E) — min-w-[12rem], not min-w-0: with a wide right
            cluster, flex was crushing the title into a one-word-per-line
            sliver through the rail line; now the right cluster wraps below
            instead (flex-wrap) and the title keeps a readable column. */}
        <div className="min-w-[12rem] flex-1 pt-0.5">
          <div className="text-[16.5px] font-bold tracking-[-0.005em] text-gray-900">{title}</div>
          {sub && <div className="mt-0.5 text-[13px] leading-normal text-gray-500">{sub}</div>}
        </div>
        {/* S297 (Andrew) — three responsive states in pure CSS:
            · wide: inline, flush RIGHT (ml-auto; the pl-[44px] hides inside
              the right-aligned box's leading space)
            · mid (doesn't fit): flex-wrap drops the box to its own row at
              x=0 — the pl-[44px] lands its content exactly at the TEXT
              column (badge 30px + gap 14px), left-aligned under the words
            · mobile (<sm): w-full, no rail indent, buttons align left. */}
        {right && (
          <div className="w-full sm:ml-auto sm:w-auto sm:flex-shrink-0 sm:self-center sm:pl-[44px]">
            {right}
          </div>
        )}
      </header>
      {children != null && <div className="sm:ml-[43px]">{children}</div>}
    </section>
  );
}

/**
 * S302 — the resolved fold (agenda §2.2, mock Panel D). Every letter on the
 * case reached a terminal outcome, so the whole rail collapses to one line.
 *
 * Exported from here with the rest of the rail chrome; ClaimDetail owns the
 * expanded/collapsed state because the steps it hides are ITS children (1–4
 * prep included — a resolved case folds entirely, not just its letters).
 *
 * §2.2's go-back principle: no collapse in this product is permanent, so the
 * expanded state keeps a Collapse control rather than being one-way.
 */
export function CaseResolvedFold({
  resolution,
  expanded,
  onToggle,
}: {
  resolution: RailCaseResolution;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="mt-6 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3.5">
      <div className="flex min-w-0 items-center gap-3">
        <span
          className="grid h-[26px] w-[26px] flex-shrink-0 place-items-center rounded-full bg-emerald-700 text-[12px] font-bold leading-none text-white"
          aria-hidden
        >
          {"✓"}
        </span>
        <div className="min-w-0">
          <div className="text-[14.5px] font-bold text-emerald-800">{resolution.headline}</div>
          <div className="mt-px text-[12.5px] text-emerald-700/80">{resolution.meta}</div>
        </div>
      </div>
      <button
        type="button"
        onClick={onToggle}
        className="flex-shrink-0 text-[13px] font-semibold text-emerald-800 underline-offset-2 hover:underline"
      >
        {expanded ? CASE_RAIL.foldCollapse : resolution.expandLabel}
      </button>
    </div>
  );
}

// ── The extension rail ──────────────────────────────────────────────────────

const receiptClass = "text-[13px] font-semibold text-emerald-700";

function WaitCardBody({
  card,
  whnOpen,
  onWhnToggle,
  onLogResponse,
  onDoor,
  doorLogged,
  doorBusy,
  doorFailed,
}: {
  card: RailWaitCard;
  whnOpen: boolean;
  onWhnToggle: (open: boolean) => void;
  onLogResponse: () => void;
  onDoor: () => void;
  doorLogged: boolean;
  doorBusy: boolean;
  /** The last door write FAILED. Rendered — never swallowed (S300 lesson). */
  doorFailed: boolean;
}) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white px-4 py-3.5">
      <div className="flex flex-wrap items-center gap-2.5">
        {card.chipSentAgo && (
          <span className="inline-flex items-center rounded-full bg-slate-100 px-2.5 py-[3px] text-[12px] font-semibold text-slate-600 ring-1 ring-inset ring-slate-200">
            {card.chipSentAgo}
          </span>
        )}
        {card.chipDeadline && (
          <span className="inline-flex items-center rounded-full bg-amber-50 px-2.5 py-[3px] text-[12px] font-semibold text-amber-800 ring-1 ring-inset ring-amber-200">
            {card.chipDeadline}
          </span>
        )}
        {card.chipPause && (
          <span className="inline-flex items-center rounded-full bg-slate-100 px-2.5 py-[3px] text-[12px] font-semibold text-slate-600 ring-1 ring-inset ring-slate-200">
            {card.chipPause}
          </span>
        )}
      </div>
      {/* S302 — the elapsed-% countdown BAR is gone in EVERY state (Andrew:
          "the number is enough if it updates daily"; and on round 2, "keep the
          bar away"). Urgency is the chip's colour alone. mt-3.5 keeps the
          chips-to-actions gap the bar used to provide. */}
      <div className="mt-3.5 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={onLogResponse}
          className="inline-flex items-center rounded-lg bg-blue-600 px-4 py-2 text-[13.5px] font-semibold text-white shadow-sm transition-colors hover:bg-blue-700"
        >
          {card.ctaLogResponse}
        </button>
        {card.door.kind === "collection_resumed" && doorLogged ? (
          <span className="inline-flex items-center gap-1 text-[12px] font-medium text-emerald-700">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M5 13l4 4L19 7" />
            </svg>
            {card.door.ackLabel}
          </span>
        ) : (
          <button
            type="button"
            onClick={onDoor}
            disabled={doorBusy}
            className="border-none bg-transparent p-0 text-[12px] text-gray-400 underline underline-offset-2 transition-colors hover:text-gray-600 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {card.door.label}
          </button>
        )}
      </div>
      {doorFailed && (
        <p className="mt-2 text-[11.5px] font-medium text-red-600">
          That didn&apos;t save — please try again.
        </p>
      )}
      {card.foot && <div className="mt-2 text-[11.5px] text-gray-400">{card.foot}</div>}
      {card.whn && (
        <details
          className="mt-3.5 border-t border-gray-200 pt-2.5"
          open={whnOpen}
          onToggle={(e) => onWhnToggle((e.target as HTMLDetailsElement).open)}
        >
          <summary className="cursor-pointer list-none text-[10.5px] font-extrabold uppercase tracking-[0.07em] text-gray-400 [&::-webkit-details-marker]:hidden">
            {card.whn.heading}
            <span aria-hidden>{whnOpen ? " ▾" : " ▸"}</span>
          </summary>
          <div className="mt-1.5 text-[12.5px] leading-8">
            {card.whn.rows.map(([lhs, rhs]) => (
              <div key={lhs}>
                <span className="font-semibold text-gray-700">{lhs}</span>
                <span className="text-gray-400"> — </span>
                <span className="text-gray-500">{rhs}</span>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

/**
 * S301 — one collections step. Andrew's grammar, exactly:
 *
 *   open     empty white CIRCLE (never a checkbox — the affordance is the
 *            button, not the indicator)
 *   done     green fill + white check, with the server stamp beside it
 *   skipped  light grey + a skip mark, NEVER a check — a declined step must not
 *            be readable as a performed one (these feed letters)
 *
 * Every step's action is a button, or input(s) plus a confirming button.
 */
function GuideStepCard({
  step,
  busy,
  failed,
  draft,
  onDraft,
  onAct,
  onSkip,
  onUndoSkip,
}: {
  step: Extract<RailStepModel, { kind: "guide-step" }>;
  busy: boolean;
  /** The last write for this step FAILED. Rendered — never swallowed (S300). */
  failed: boolean;
  draft: string | undefined;
  onDraft: (v: string) => void;
  onAct: (value: string | null) => void;
  onSkip: () => void;
  onUndoSkip: () => void;
}) {
  const value = draft ?? step.value ?? "";

  // NO inner indicator (Andrew, S301). Each of these steps carries exactly ONE
  // action, so the step's own NUMBER is the indicator — it turns green on
  // completion and grey on skip. A second circle inside the card would be a
  // sub-step marker for a step that has no sub-steps. Inner circles come back
  // only if a step ever holds several actions that resolve independently.
  return (
    <div className="rounded-xl border border-gray-200 bg-white px-4 py-3.5">
      <div className="min-w-0 flex-1">
        {/* S303 (Andrew, T8) — NO title here. RailStep already renders it as
            the step's header, directly above this card, so every collections
            step printed its own title twice. Shipped that way at S301 and
            never promoted. The header is the canonical position: it is where
            every other step kind names itself, and where the badge and spine
            align. */}
        <div className="text-[12.5px] leading-[1.55] text-gray-500">{step.body}</div>

        {step.state === "skipped" ? (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <span className="text-[11.5px] font-medium text-gray-400">
              {COLLECTIONS_CHROME.skippedLabel}
            </span>
            <button
              type="button"
              onClick={onUndoSkip}
              disabled={busy}
              className="text-[11.5px] font-medium text-gray-500 underline underline-offset-2 hover:text-gray-700 disabled:opacity-60"
            >
              {COLLECTIONS_CHROME.undoSkipLabel}
            </button>
          </div>
        ) : step.state === "done" ? (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <span className="text-[11.5px] font-medium text-emerald-700">
              {step.action.kind === "date" && step.value
                ? `${step.value}`
                : step.doneAt
                  ? `Done ${step.doneAt}`
                  : "Done"}
            </span>
            <button
              type="button"
              onClick={() => onAct(null)}
              disabled={busy}
              className="text-[11.5px] font-medium text-gray-500 underline underline-offset-2 hover:text-gray-700 disabled:opacity-60"
            >
              Undo
            </button>
          </div>
        ) : (
          <div className="mt-2 flex flex-wrap items-end gap-2">
            {step.action.kind !== "attest" && (
              <label className="flex flex-col gap-1">
                <span className="text-[11px] font-medium text-gray-500">{step.action.label}</span>
                <input
                  type={step.action.kind === "date" ? "date" : "text"}
                  value={value}
                  placeholder={step.action.kind === "text" ? step.action.placeholder : undefined}
                  onChange={(e) => onDraft(e.target.value)}
                  className="w-56 rounded-lg border border-gray-200 px-3 py-[7px] text-[12.5px] text-gray-800 placeholder:text-gray-400 focus:border-blue-300 focus:outline-none focus:ring-2 focus:ring-blue-100"
                />
              </label>
            )}
            {/* Skip sits on the button's centre line, not the input's baseline
                (Andrew, S301) — they are peers, so they share a row. */}
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => onAct(step.action.kind === "attest" ? null : value)}
                disabled={busy || (step.action.kind !== "attest" && !value.trim())}
                className="inline-flex items-center rounded-xl bg-blue-600 px-3.5 py-[7px] text-[12.5px] font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-60"
              >
                {/* "Working…" ONLY for the structural action (mark-as-sent).
                    Round 3b put it on every button, which masked the optimistic
                    flip it was supposed to complement — an attest that already
                    turned green still read as pending for the whole refetch
                    (Andrew, S301: "the undo is still pretty slow"). */}
                {busy && step.derivedFromSend
                  ? "Working…"
                  : step.action.kind === "attest"
                    ? step.action.label
                    : step.action.saveLabel}
              </button>
              {step.skippable && (
                <button
                  type="button"
                  onClick={onSkip}
                  disabled={busy}
                  className="text-[11.5px] font-medium text-gray-500 underline underline-offset-2 hover:text-gray-700 disabled:opacity-60"
                >
                  {COLLECTIONS_CHROME.skipLabel}
                </button>
              )}
            </div>
          </div>
        )}

        {/* A write that fails must SAY so. The S300 `acknowledge` bug 400'd on
            every click and showed nothing, because the UI moved on regardless. */}
        {failed && (
          <p className="mt-2 text-[11.5px] font-medium text-red-600">
            {COLLECTIONS_CHROME.saveFailed}
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * S302 — the letter band: the group header above one letter's steps (approved
 * mock option B). Names the letter once so its steps don't have to, and
 * carries the per-letter status the rail could not show at a glance before.
 *
 * The INDENT lives on the group wrapper below, not here: the band is the
 * group's left edge, and the steps step in under it.
 */
function LetterBand({ group }: { group: RailLetterGroup }) {
  const tone = group.status?.tone;
  return (
    <div className="mb-3 mt-1 flex flex-wrap items-center justify-between gap-2.5 rounded-xl border border-blue-100 bg-blue-50/40 px-3.5 py-2.5">
      <div className="min-w-0">
        <div className="text-[10px] font-extrabold uppercase tracking-[0.11em] text-blue-400">
          {group.eyebrow}
        </div>
        <div className="mt-px text-[14px] font-bold text-gray-900">{group.title}</div>
      </div>
      {group.status && (
        <span
          className={
            "inline-flex items-center rounded-full px-2.5 py-[3px] text-[12px] font-semibold ring-1 ring-inset " +
            (tone === "green"
              ? "bg-emerald-50 text-emerald-700 ring-emerald-200"
              : tone === "amber"
                ? "bg-amber-50 text-amber-800 ring-amber-200"
                : "bg-slate-100 text-slate-600 ring-slate-200")
          }
        >
          {group.status.label}
        </span>
      )}
    </div>
  );
}

export function CaseRail({
  groups,
  claimId,
  getAuthToken,
  onLogResponse,
  onSomethingElse,
  onUndoResult,
  onStartNextLetter,
  renderOfferAction,
  escalating,
  onMarkSent,
  onSaveFirstContactDate,
  onRefetch,
}: {
  /**
   * S303 — the rail arrives COMPOSED. ClaimDetail composes once (composeRail)
   * and passes both halves down; this component used to re-compose the same
   * inputs while ClaimDetail separately computed the fold from `letters`
   * alone, which is exactly how a finished-looking case could collapse with
   * steps still open. One composition, one truth.
   */
  groups: RailLetterGroup[];
  claimId: string;
  getAuthToken: () => Promise<string | null>;
  /** Opens the shared OutcomeReportingModal (ClaimDetail mounts it). */
  onLogResponse: (disputeId: string) => void;
  /** Opens the shared CollectorModal → escalate flow (ClaimDetail mounts it). */
  onSomethingElse: (disputeId: string) => void;
  /** The existing outcome-undo request + claim refetch; resolves false on failure. */
  onUndoResult: (disputeId: string) => Promise<boolean>;
  /** Stage-8 offers (phase 1b): routes to the existing escalate flow —
   *  external_review via the shared ExhaustionAttestModal, final_notice
   *  direct, debt_validation via the shared CollectorModal. */
  onStartNextLetter: (disputeId: string, targetLetterType: string) => void;
  /**
   * S305 — the draft control for a parallel-track offer, supplied by the owner
   * of the claim data.
   *
   * A NODE rather than a callback, deliberately. Drafting a first letter is not
   * one request: it is a cached feature-flag read, a plans-by-year fetch, the
   * plan-pinning chooser, the persistent draft overlay, an inline error and the
   * navigation on success — all of which `BulkDisputeButton` already owns.
   * Taking a callback here would mean re-implementing five behaviours; taking
   * the button means the same component renders in a second place with a
   * different letter type, and nothing is duplicated. The rail still knows
   * nothing about claims, findings or auth.
   */
  renderOfferAction: (letterType: string) => React.ReactNode;
  /** Escalate in flight (ClaimDetail state) — disables the offer buttons. */
  escalating: boolean;
  /** S301 — mark-as-sent / unsend for the collections "Mail it certified" step.
   *  Routes to the EXISTING mark-sent + unsend paths (one writer). */
  onMarkSent: (disputeId: string, sent: boolean) => Promise<boolean>;
  /** S301 — the FDCPA §1692g anchor, through the existing deadline-inputs route. */
  onSaveFirstContactDate: (disputeId: string, date: string | null) => Promise<void>;
  /** Refetch the claim projection after a collections step writes. */
  onRefetch: () => Promise<void>;
}) {
  const router = useRouter();
  const [openSteps, setOpenSteps] = useState<Record<string, boolean>>({});
  const [whnOpen, setWhnOpen] = useState<Record<string, boolean>>({});
  const [doorLogged, setDoorLogged] = useState<Record<string, boolean>>({});
  const [doorBusy, setDoorBusy] = useState<Record<string, boolean>>({});
  const [doorError, setDoorError] = useState<Record<string, boolean>>({});
  const [undoBusy, setUndoBusy] = useState<Record<string, boolean>>({});
  const [undoError, setUndoError] = useState<Record<string, boolean>>({});
  // S301 — collections step state, keyed by stepId (claim-scoped, so one per bill).
  const [guideBusy, setGuideBusy] = useState<Record<string, boolean>>({});
  const [guideError, setGuideError] = useState<Record<string, boolean>>({});
  const [guideDrafts, setGuideDrafts] = useState<Record<string, string>>({});
  const [guideOverride, setGuideOverride] = useState<
    Record<string, "open" | "done" | "skipped">
  >({});
  /**
   * S303 — the regulator card's optimistic state is `guideOverride` above,
   * keyed by the SAME stepId the write uses. It had its own `filedOverride`
   * and `filedSkipped` maps keyed by disputeId, which is the mistake the
   * storage move corrects: the record is claim-scoped, so a dispute in the key
   * meant three letters could hold three answers to one act. Both maps are
   * gone; only the note drafts remain, controlled (GuidedPhoneSteps idiom) so
   * the attest click carries the UNION {checked, note} in ONE request — the
   * button blurs the input, and two concurrent read-modify-writes lose one
   * field to the other (the S299 "complaint number disappeared" race, Andrew).
   */
  const [attestNoteDrafts, setAttestNoteDrafts] = useState<Record<string, string>>({});
  /**
   * S303 — "File again" has been pressed on an agency filed about an earlier
   * letter, so its field is open for a NEW confirmation number. A display mode
   * and nothing more: it asserts nothing, so it belongs in React state rather
   * than on the record.
   */
  const [refiling, setRefiling] = useState<Record<string, boolean>>({});

  if (groups.length === 0) return null;

  const goToLetter = (disputeId: string) => router.push(`/disputes?dispute=${disputeId}`);

  // The rail's ONE write (ruling 6, capture-only): a case event on the record.
  // Fail-quiet UX: on a non-OK response the button simply re-enables — the
  // ledger is history, not state, and the user can retry.
  const logCollectionResumed = async (disputeId: string) => {
    if (doorBusy[disputeId] || doorLogged[disputeId]) return;
    setDoorBusy((m) => ({ ...m, [disputeId]: true }));
    setDoorError((m) => ({ ...m, [disputeId]: false }));
    // Optimistic + snap-back, matching every other action on this rail (Andrew,
    // S301). It used to flip ONLY on success and swallow failure entirely — the
    // S300 acknowledge bug exactly: a write that 400s and shows no symptom.
    setDoorLogged((m) => ({ ...m, [disputeId]: true }));
    try {
      const token = await getAuthToken();
      if (!token) throw new Error("no token");
      const res = await fetch(`/api/claims/${claimId}/case-events`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ kind: "collection_resumed_reported", disputeId }),
      });
      if (!res.ok) throw new Error(`case-events ${res.status}`);
    } catch {
      setDoorLogged((m) => ({ ...m, [disputeId]: false }));
      setDoorError((m) => ({ ...m, [disputeId]: true }));
    } finally {
      setDoorBusy((m) => ({ ...m, [disputeId]: false }));
    }
  };


  // ── Collections steps (S301) ──────────────────────────────────────────────
  //
  // Persist through the EXISTING claim-checklist route: its stamps are
  // server-side, which is where each step's "done «date»" comes from, and being
  // claim-scoped they stay with the bill across escalation.
  //
  // ⚠ These calls do NOT navigate, and they surface failure. The S300 lesson was
  // an `acknowledge` write that 400'd on every click with no symptom, because
  // the button navigated whether or not the write landed. Every action here
  // awaits its result and reverts the row on failure.
  const runGuideStep = async (
    body: {
      stepId: string;
      checked?: boolean;
      skipped?: boolean;
      note?: string;
      /** Stamps the emitted ledger event with the letter this act answered. */
      disputeId?: string;
    },
  ): Promise<boolean> => {
    try {
      const token = await getAuthToken();
      if (!token) return false;
      const res = await fetch(`/api/claims/${claimId}/checklist`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      return res.ok;
    } catch {
      return false;
    }
  };

  // Optimistic override, snap-back on failure (the same S295 idiom filedOverride
  // uses above). Without it every click waited on a FULL claim refetch — ~3s on
  // this account — so the rail looked dead and Andrew clicked twice, which is
  // exactly what the doubled ledger events recorded.
  const applyOptimistic = (stepId: string, next: "open" | "done" | "skipped") =>
    setGuideOverride((m) => ({ ...m, [stepId]: next }));
  const clearOptimistic = (stepId: string) =>
    setGuideOverride((m) => {
      if (!(stepId in m)) return m;
      const rest = { ...m };
      delete rest[stepId];
      return rest;
    });

  /**
   * ONE claim-step write: busy → optimistic → POST → refetch → clear, with the
   * row reverting and the error surfacing on failure.
   *
   * S303 — extracted rather than copied a third time. The collections attest,
   * the collections skip, and now every regulator door do exactly this dance;
   * a third hand-rolled copy is how they drift apart, and the optimistic clear
   * is the easy step to forget (the S302 totals row VANISHED because an
   * optimistic clear raced the field it was derived from).
   */
  const runClaimStep = async (
    stepId: string,
    next: "open" | "done" | "skipped",
    body: { checked?: boolean; skipped?: boolean; note?: string; disputeId?: string },
  ): Promise<void> => {
    setGuideBusy((m) => ({ ...m, [stepId]: true }));
    setGuideError((m) => ({ ...m, [stepId]: false }));
    try {
      applyOptimistic(stepId, next);
      const ok = await runGuideStep({ stepId, ...body });
      if (ok) await onRefetch();
      else setGuideError((m) => ({ ...m, [stepId]: true }));
      clearOptimistic(stepId);
    } finally {
      setGuideBusy((m) => ({ ...m, [stepId]: false }));
    }
  };

  // ── The regulator complaint (S303) ────────────────────────────────────────
  //
  // Claim-scoped and PER AGENCY, through the same route above. Until S303 this
  // wrote `packD:filed` on the DISPUTE, so one bill could hold three
  // contradictory answers to a single act — measured on the Ballard case as
  // filed / filed / not-filed for one filing. The route stamps the times,
  // keeps `checkedAt` and `skippedAt` mutually exclusive on write, and banks
  // the previous confirmation number (noteHistory, last 5) before replacing
  // it, so a mistyped number is recoverable.
  // `disputeId` rides along ONLY to stamp the emitted ledger event with the
  // letter this complaint answered. It is not stored — the step key already
  // carries it — but without it the case spine would record the act with no
  // link to its letter, leaving the Case File to parse a string.
  const toggleFiled = (door: RailDoorTile, disputeId: string, next: boolean, note: string) =>
    // The UNION write — the attestation and the confirmation number in ONE
    // request. Clicking the button blurs the input, and two concurrent
    // read-modify-writes lose one field to the other (the S299 "complaint
    // number disappeared" race, Andrew).
    runClaimStep(door.stepId, next ? "done" : "open", { checked: next, note, disputeId });
  const saveFiledNote = (door: RailDoorTile, note: string) =>
    // Note-only save (blur). Deliberately NOT an attestation: a confirmation
    // number typed and never confirmed is not a filing, and the route emits no
    // ledger event for a note-only write.
    runGuideStep({ stepId: door.stepId, note });
  const toggleDeclined = (stepId: string, disputeId: string, next: boolean) =>
    runClaimStep(stepId, next ? "skipped" : "open", { skipped: next, disputeId });

  // Unsend from the rail — the EXISTING mark-sent route in its undo direction,
  // so the snapshot retention, clock retraction, and letter_unsent event all
  // happen on the one path that owns them. Structural (it changes which steps
  // exist), so this shows a PENDING state rather than faking the new shape:
  // inventing it client-side would be a second derivation of the rail.
  const runGuideAction = async (
    s: Extract<RailStepModel, { kind: "guide-step" }>,
    value: string | null,
  ) => {
    // An attestation step IS the shared claim-step write. The other two done
    // sources are different writers (mark-as-sent; the deadline-inputs route)
    // and keep their own handling below.
    if (s.doneSource === "attestation") {
      const nextDone = s.action.kind === "text" ? true : s.state !== "done";
      await runClaimStep(
        s.stepId,
        nextDone ? "done" : "open",
        s.action.kind === "text"
          ? { checked: true, note: value ?? "" }
          : { checked: nextDone },
      );
      return;
    }
    setGuideBusy((m) => ({ ...m, [s.stepId]: true }));
    setGuideError((m) => ({ ...m, [s.stepId]: false }));
    try {
      // "Mail it certified" IS mark-as-sent — one writer, so the immutable
      // snapshot, the clock, the version stack, and the letter_sent event all
      // happen exactly once, on the path that already owns them.
      if (s.derivedFromSend) {
        await onMarkSent(s.disputeId, s.state !== "done");
        return;
      }
      {
        // Undo on a date step CLEARS it (null); saving sets it. Both go through
        // the existing deadline-inputs route — the engine keeps one input path.
        // Optimistic like every other field flip: the stored date IS the answer,
        // so the step can show its new state immediately and reconcile after.
        const clearing = s.state === "done";
        if (!clearing && !value) return;
        applyOptimistic(s.stepId, clearing ? "open" : "done");
        try {
          await onSaveFirstContactDate(s.disputeId, clearing ? null : value);
        } finally {
          clearOptimistic(s.stepId);
        }
        return;
      }
    } finally {
      setGuideBusy((m) => ({ ...m, [s.stepId]: false }));
    }
  };

  const runGuideSkip = (
    s: Extract<RailStepModel, { kind: "guide-step" }>,
    skipped: boolean,
  ) => runClaimStep(s.stepId, skipped ? "skipped" : "open", { skipped });

  /**
   * One step. `letterId` is the S300 deep-link anchor — it comes from the
   * GROUP now, because every step inside a group belongs to that letter by
   * construction (which is what retired `railStepDisputeId`, whose whole job
   * was reaching the id through `card`/`move`). The anchor semantics are
   * unchanged: still one attribute per step, so claim/page.tsx's "last match
   * is the most recent step" still lands on the actionable card.
   *
   * S305 — null on an OFFER group. There is no letter, so there is nothing for
   * an emailed deep link to point at; `RailStep` already omits the attribute
   * rather than emitting an empty one.
   */
  const renderStep = (s: RailStepModel, last: boolean, letterId: string | null) => {
    {
        switch (s.kind) {
          case "wait-active":
            return (
              <RailStep key={s.key} dataLetter={letterId} n={s.badge} title={s.title} sub={s.sub ?? undefined} last={last}>
                <WaitCardBody
                  card={s.card}
                  whnOpen={whnOpen[s.key] ?? s.card.whn?.defaultOpen ?? false}
                  onWhnToggle={(open) => setWhnOpen((m) => ({ ...m, [s.key]: open }))}
                  onLogResponse={() => onLogResponse(s.card.disputeId)}
                  onDoor={() =>
                    s.card.door.kind === "collection_resumed"
                      ? logCollectionResumed(s.card.disputeId)
                      : onSomethingElse(s.card.disputeId)
                  }
                  doorLogged={doorLogged[s.card.disputeId] ?? false}
                  doorBusy={doorBusy[s.card.disputeId] ?? false}
                  doorFailed={doorError[s.card.disputeId] ?? false}
                />
              </RailStep>
            );
          case "wait-receipt":
            return (
              <RailStep
                key={s.key}
                dataLetter={letterId}
                n={s.badge}
                done
                title={s.title}
                sub={s.receipt ? <span className={receiptClass}>{s.receipt}</span> : undefined}
                right={
                  s.undo ? (
                    <div className="flex flex-col items-start gap-1 sm:items-end">
                      <button
                        type="button"
                        onClick={async () => {
                          if (undoBusy[s.disputeId]) return;
                          setUndoBusy((m) => ({ ...m, [s.disputeId]: true }));
                          setUndoError((m) => ({ ...m, [s.disputeId]: false }));
                          const ok = await onUndoResult(s.disputeId);
                          if (!ok) setUndoError((m) => ({ ...m, [s.disputeId]: true }));
                          setUndoBusy((m) => ({ ...m, [s.disputeId]: false }));
                        }}
                        disabled={undoBusy[s.disputeId] ?? false}
                        className="border-none bg-transparent p-0 text-[12px] text-gray-400 underline underline-offset-2 transition-colors hover:text-gray-600 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {/* Label flips while in flight — disabled+dimmed alone
                            still reads as "nothing happened" on a slow refetch
                            (S301 E2E). Same treatment as unsend below. */}
                        {undoBusy[s.disputeId] ? "Working…" : CASE_RAIL.quietUndoResult}
                      </button>
                      {(undoError[s.disputeId] ?? false) && (
                        <span className="text-[11.5px] text-red-600">
                          {"Couldn't undo — please try again."}
                        </span>
                      )}
                    </div>
                  ) : undefined
                }
                last={last}
              />
            );
          case "next-move": {
            const reg = s.move.regulator;
            // Per-door state rides the SHARED collections override map, keyed
            // by the same stepId the write uses — so an in-flight filing shows
            // instantly and reconciles from the projection, exactly like every
            // other attested step on this rail.
            const doorState = (d: RailDoorTile) =>
              guideOverride[d.stepId] ?? (d.filedAt ? "done" : "open");
            const anyFiled = reg != null && reg.doors.some((d) => doorState(d) === "done");
            const declined =
              reg?.skip != null &&
              (guideOverride[reg.skip.stepId] ??
                (reg.skip.declined ? "skipped" : "open")) === "skipped";
            return (
              <RailStep
                key={s.key}
                dataLetter={letterId}
                n={s.badge}
                title={s.title}
                sub={s.sub ?? undefined}
                last={last}
                // S302 round 4 (Andrew) — this step never carried a done-state
                // at all, so filing a complaint left it permanently blue. The
                // attestation IS its completion; skipping greys it, matching
                // every other attested step on this rail (S297 §3.2: a declined
                // step is never a check). S303 — ANY agency filed completes it.
                done={anyFiled}
                skipped={!anyFiled && declined}
              >
                <div className="space-y-2.5">
                  {s.move.letterOffer && (
                    <div className="rounded-xl border border-gray-200 bg-white px-4 py-3.5">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div className="min-w-[14rem] flex-1">
                          <div className="text-[14px] font-bold text-gray-900">
                            {s.move.letterOffer.title}
                          </div>
                          {s.move.letterOffer.sub && (
                            <div className="mt-0.5 text-[12.5px] text-gray-500">
                              {s.move.letterOffer.sub}
                            </div>
                          )}
                        </div>
                        <div className="flex flex-shrink-0 items-center gap-2">
                          {s.move.letterOffer.requiresPro && (
                            <span className="inline-flex items-center rounded-full bg-purple-50 px-2.5 py-[3px] text-[12px] font-semibold text-purple-700 ring-1 ring-inset ring-purple-200">
                              {s.move.letterOffer.proChip}
                            </span>
                          )}
                          <button
                            type="button"
                            onClick={() =>
                              onStartNextLetter(s.move.disputeId, s.move.letterOffer!.targetLetterType)
                            }
                            disabled={escalating}
                            className="inline-flex items-center rounded-lg bg-blue-600 px-4 py-2 text-[13.5px] font-semibold text-white shadow-sm transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            {s.move.letterOffer.cta}
                          </button>
                        </div>
                      </div>
                    </div>
                  )}
                  {reg && (
                  <div className="rounded-xl border border-gray-200 bg-white px-4 py-3.5">
                    <div className="text-[14px] font-bold text-gray-900">{reg.title}</div>
                    <div className="mb-2.5 mt-0.5 text-[12.5px] text-gray-500">{reg.lead}</div>
                    {/* Two rows of two (Andrew, S303 mock). A GRID, not a wrap:
                        grid cells stretch to the tallest in their row, and each
                        tile pins its controls with mt-auto — so every field and
                        button lands on the same line no matter how long the
                        agency's description runs. */}
                    <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                      {reg.doors.map((d) => {
                        const filed = doorState(d) === "done";
                        // Filed about an EARLIER letter and the user has not
                        // asked to file again: the number shows, read-only,
                        // and this letter's step stays open. Locked is a
                        // display mode, not an attestation, so it is plain
                        // React state — nothing about it belongs on the record.
                        const locked =
                          !filed && d.earlier != null && !refiling[d.stepId];
                        const noteValue = locked
                          ? (d.earlier?.note ?? "")
                          : (attestNoteDrafts[d.stepId] ?? d.note ?? "");
                        const busy = guideBusy[d.stepId] ?? false;
                        return (
                          <div
                            key={d.id}
                            className={
                              "flex flex-col rounded-[10px] border px-3 py-2.5 text-[13px] " +
                              (filed
                                ? "border-emerald-300 bg-emerald-50/60"
                                : locked
                                  ? "border-gray-200 bg-gray-50/70"
                                  : d.chip
                                    ? "border-blue-200 bg-blue-50/40"
                                    : "border-gray-200 bg-white")
                            }
                          >
                            <a
                              href={d.href}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="group"
                            >
                              <span className="flex flex-wrap items-center gap-1.5 font-bold text-gray-900 group-hover:underline">
                                {d.name}
                                {d.chip && (
                                  <span className="inline-flex items-center rounded-full bg-slate-100 px-2 py-[2px] text-[10.5px] font-semibold text-slate-600 ring-1 ring-inset ring-slate-200">
                                    {d.chip}
                                  </span>
                                )}
                              </span>
                              <span className="mt-0.5 block text-[12px] text-gray-500">
                                {d.desc}
                              </span>
                            </a>
                            <div className="mt-auto flex items-center gap-2 pt-2.5">
                              <input
                                type="text"
                                value={noteValue}
                                readOnly={locked}
                                placeholder={reg.notePlaceholder}
                                maxLength={500}
                                onChange={(e) =>
                                  setAttestNoteDrafts((m) => ({
                                    ...m,
                                    [d.stepId]: e.target.value,
                                  }))
                                }
                                onBlur={(e) => {
                                  if (locked) return;
                                  const v = e.target.value.trim();
                                  if (v !== (d.note ?? "")) void saveFiledNote(d, v);
                                }}
                                className={
                                  "min-w-0 flex-1 rounded-lg border border-gray-200 px-3 py-[7px] text-[12.5px] placeholder:text-gray-400 focus:outline-none " +
                                  (locked
                                    ? "bg-gray-100 text-gray-500"
                                    : "bg-white text-gray-800 focus:border-blue-300 focus:ring-2 focus:ring-blue-100")
                                }
                              />
                              <button
                                type="button"
                                disabled={busy || locked}
                                onClick={() =>
                                  void toggleFiled(d, s.move.disputeId, !filed, noteValue.trim())
                                }
                                className={
                                  "inline-flex flex-shrink-0 items-center gap-1.5 rounded-xl px-3.5 text-[12.5px] font-semibold disabled:cursor-not-allowed " +
                                  (filed
                                    ? "border border-emerald-300 bg-emerald-50 py-[7px] text-emerald-700 disabled:opacity-60"
                                    : locked
                                      ? // Greyed-out green (Andrew): this agency HAS been
                                        // filed, just not about this letter — readable as
                                        // history, not as this step's completion.
                                        "border border-emerald-200 bg-emerald-50/50 py-[7px] text-emerald-700/50"
                                      : "border-[1.5px] border-blue-400 bg-white py-[6.5px] text-blue-700 transition-colors hover:bg-blue-50 disabled:opacity-60")
                                }
                              >
                                {reg.filedLabel}
                                {(filed || locked) && (
                                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                                    <path d="M5 13l4 4L19 7" />
                                  </svg>
                                )}
                              </button>
                            </div>
                            {locked && d.earlier && (
                              <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11.5px] font-medium text-gray-500">
                                {d.earlier.label}
                                <button
                                  type="button"
                                  onClick={() => {
                                    setRefiling((m) => ({ ...m, [d.stepId]: true }));
                                    // Clear the field so a second filing is only
                                    // ever recorded when a second confirmation
                                    // number is actually typed — never by
                                    // clicking through the first one.
                                    setAttestNoteDrafts((m) => ({ ...m, [d.stepId]: "" }));
                                  }}
                                  className="underline underline-offset-2 hover:text-gray-700"
                                >
                                  {reg.fileAgainLabel}
                                </button>
                              </div>
                            )}
                            {/* S301 (Andrew E2E) — once filed the button reads
                                as a status pill, so nobody discovers that
                                clicking it again un-files. The same explicit
                                Undo every other attestation on this rail
                                carries. */}
                            {filed && (
                              <div className="mt-1.5 flex items-center gap-2 text-[11.5px] font-medium text-emerald-700">
                                {d.filedAtLabel ? `Filed ${d.filedAtLabel}` : "Filed"}
                                <button
                                  type="button"
                                  disabled={busy}
                                  onClick={() =>
                                    void toggleFiled(d, s.move.disputeId, false, noteValue.trim())
                                  }
                                  className="text-gray-500 underline underline-offset-2 hover:text-gray-700 disabled:opacity-60"
                                >
                                  {COLLECTIONS_CHROME.undoSkipLabel}
                                </button>
                              </div>
                            )}
                            {(guideError[d.stepId] ?? false) && (
                              <div className="mt-1.5 text-[11.5px] text-red-600">
                                {COLLECTIONS_CHROME.saveFailed}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                    {/* The case-level declination — offered ONLY while nothing
                        is filed, so "I'm not filing a complaint" and "I filed
                        one" can never both be true on the record. */}
                    {reg.skip && !anyFiled && (
                      <div className="mt-3 flex items-center gap-2">
                        {declined ? (
                          <>
                            <span className="text-[11.5px] font-medium text-gray-400">
                              {COLLECTIONS_CHROME.skippedLabel}
                            </span>
                            <button
                              type="button"
                              disabled={guideBusy[reg.skip.stepId] ?? false}
                              onClick={() =>
                                void toggleDeclined(reg.skip!.stepId, s.move.disputeId, false)
                              }
                              className="text-[11.5px] font-medium text-gray-500 underline underline-offset-2 hover:text-gray-700 disabled:opacity-60"
                            >
                              {COLLECTIONS_CHROME.undoSkipLabel}
                            </button>
                          </>
                        ) : (
                          <button
                            type="button"
                            disabled={guideBusy[reg.skip.stepId] ?? false}
                            onClick={() =>
                              void toggleDeclined(reg.skip!.stepId, s.move.disputeId, true)
                            }
                            className="text-[11.5px] font-medium text-gray-500 underline underline-offset-2 hover:text-gray-700 disabled:opacity-60"
                          >
                            {CASE_RAIL.regulatorSkipLabel}
                          </button>
                        )}
                      </div>
                    )}
                    <div className="mt-2.5 text-[11.5px] text-gray-400">{reg.foot}</div>
                  </div>
                  )}
                </div>
              </RailStep>
            );
          }
          case "send-receipt":
            return (
              <RailStep
                key={s.key}
                dataLetter={letterId}
                n={s.badge}
                done
                title={s.title}
                sub={<span className={receiptClass}>{s.receipt}</span>}
                right={
                  <ShowFullStepButton
                    open={openSteps[s.key] ?? false}
                    onToggle={() => setOpenSteps((m) => ({ ...m, [s.key]: !(m[s.key] ?? false) }))}
                  />
                }
                last={last}
              >
                {(openSteps[s.key] ?? false) && (
                  <div className="rounded-xl border border-gray-200 bg-white px-4 py-3.5">
                    <div className="flex flex-wrap items-center gap-3">
                      <button
                        type="button"
                        onClick={() => goToLetter(s.disputeId)}
                        className="inline-flex items-center rounded-lg border border-gray-200 bg-white px-4 py-2 text-[13.5px] font-semibold text-gray-700 transition-colors hover:bg-gray-50"
                      >
                        {s.openLetterLabel}
                      </button>
                      {/* S301 — unsend on the CASE surface, the SAME component
                          the letter page renders, so the two can never describe
                          the act differently. */}
                      <UnsendControl
                        loggedOutcomeLabel={s.unsend.loggedOutcomeLabel}
                        loggedOutcomeDateLabel={s.unsend.loggedOutcomeDateLabel}
                        onUnsend={() => onMarkSent(s.disputeId, false)}
                      />
                    </div>
                  </div>
                )}
              </RailStep>
            );
          case "letter-offer": {
            const o = s.offer;
            // Optimistic state rides the SAME map every other declinable step
            // on this rail uses, keyed by the same stepId the write uses — so
            // the decline paints in the click's own render and reconciles from
            // the claim, exactly like the regulator doors and the collections
            // steps (S303).
            const declined = (guideOverride[o.stepId] ?? (o.declined ? "skipped" : "open")) === "skipped";
            return (
              <RailStep
                key={s.key}
                dataLetter={letterId}
                n={s.badge}
                title={s.title}
                sub={s.sub ?? undefined}
                last={last}
                // Never `done`: the moment the letter exists this step stops
                // being composed and the letter's own group replaces it.
                skipped={declined}
              >
                <div className={`rounded-xl border border-gray-200 px-4 py-3.5 ${declined ? "bg-gray-50" : "bg-white"}`}>
                  {/* S309 F1 (Andrew) — action FIRST, reason to its right, for
                      every letter offer: the button is the step's point; the
                      reason (finding's words, or the engine's own sentence —
                      F1-B) reads as its justification beside it. */}
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    {!declined && (
                      <div className="flex flex-shrink-0 items-center gap-2">
                        {renderOfferAction(o.letterType)}
                      </div>
                    )}
                    <div className="min-w-[14rem] flex-1 text-right">
                      {o.reasonTitle && (
                        <div className={`text-[14px] font-bold ${declined ? "text-gray-400" : "text-gray-900"}`}>
                          {o.reasonTitle}
                        </div>
                      )}
                      {o.reasonDetail && (
                        <div className={`mt-0.5 text-[12.5px] leading-[1.55] ${declined ? "text-gray-400" : "text-gray-500"}`}>
                          {o.reasonDetail}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
                <div className="mt-2.5 flex flex-wrap items-center gap-2 text-[11.5px] text-gray-400">
                  {declined ? (
                    <>
                      <span>
                        {COLLECTIONS_CHROME.skippedLabel}
                        {o.declinedAtLabel ? ` · ${o.declinedAtLabel}` : ""}
                      </span>
                      <button
                        type="button"
                        disabled={guideBusy[o.stepId] ?? false}
                        onClick={() => void runClaimStep(o.stepId, "open", { skipped: false })}
                        className="font-medium text-gray-500 underline underline-offset-2 hover:text-gray-700 disabled:opacity-60"
                      >
                        {COLLECTIONS_CHROME.undoSkipLabel}
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      disabled={guideBusy[o.stepId] ?? false}
                      onClick={() => void runClaimStep(o.stepId, "skipped", { skipped: true })}
                      className="font-medium text-gray-500 underline underline-offset-2 hover:text-gray-700 disabled:opacity-60"
                    >
                      {COLLECTIONS_CHROME.skipLabel}
                    </button>
                  )}
                  {(guideError[o.stepId] ?? false) && (
                    <span className="text-red-600">{COLLECTIONS_CHROME.saveFailed}</span>
                  )}
                </div>
              </RailStep>
            );
          }
          case "send-draft":
            return (
              <RailStep key={s.key} dataLetter={letterId} n={s.badge} title={s.title} last={last}>
                <div className="rounded-xl border border-gray-200 bg-white px-4 py-3.5">
                  <button
                    type="button"
                    onClick={() => goToLetter(s.disputeId)}
                    className="inline-flex items-center rounded-lg bg-blue-600 px-4 py-2 text-[13.5px] font-semibold text-white shadow-sm transition-colors hover:bg-blue-700"
                  >
                    {s.openLetterLabel}
                  </button>
                </div>
              </RailStep>
            );
          case "guide-step":
            return (
              <RailStep
                key={s.key}
                dataLetter={letterId}
                n={s.badge}
                title={s.title}
                last={last}
                done={(guideOverride[s.stepId] ?? s.state) === "done"}
                skipped={(guideOverride[s.stepId] ?? s.state) === "skipped"}
              >
                <GuideStepCard
                  step={
                    guideOverride[s.stepId]
                      ? { ...s, state: guideOverride[s.stepId] }
                      : s
                  }
                  busy={guideBusy[s.stepId] === true}
                  failed={guideError[s.stepId] === true}
                  draft={guideDrafts[s.stepId]}
                  onDraft={(v) => setGuideDrafts((d) => ({ ...d, [s.stepId]: v }))}
                  onAct={(value) => void runGuideAction(s, value)}
                  onSkip={() => void runGuideSkip(s, true)}
                  onUndoSkip={() => void runGuideSkip(s, false)}
                />
              </RailStep>
            );
        }
    }
  };

  return (
    <>
      {groups.map((g) => (
        // S306 (Andrew) — breathing room at every group boundary: the previous
        // letter's last card ("Your next move", "Waiting on…") was flush
        // against the next letter's band. First group keeps its position.
        <section key={g.key} className="mt-6 first:mt-0">
          <LetterBand group={g} />
          {/* The group's own spine — sits LEFT of the step badges, so the two
              lines read as hierarchy (letter, then its steps) rather than as
              one broken connector. Indent is sm-only: on a phone the rail
              already drops its indent and the band carries the grouping. */}
          <div className="relative sm:ml-[26px]">
            <span
              className="absolute -left-[13px] bottom-3.5 top-0 hidden w-[2px] rounded-full bg-blue-100 sm:block"
              aria-hidden
            />
            {g.steps.map((s, i) =>
              // Last WITHIN the group: the step connector must stop before the
              // next letter's band rather than running into it.
              renderStep(s, i === g.steps.length - 1, g.disputeId),
            )}
          </div>
        </section>
      ))}
    </>
  );
}
