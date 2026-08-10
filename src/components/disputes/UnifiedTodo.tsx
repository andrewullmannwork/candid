"use client";

/**
 * UnifiedTodo — "What you need to do" (Surface 4, clarity redesign v3;
 * extended into the unified case timeline, S286).
 *
 * ONE continuous spine for the whole case, merging the prep signals
 * ("What we need from you"), the send steps, the after-sent CASE TIMELINE
 * (previously the separate "The case" CaseSummary card, retired in v3), and
 * the claim's other letters (the escalation ladder):
 *
 *   [earlier letters]  — one segment per previously-created letter: micro-label
 *                        + "Go back to this letter" link + its steps rendered
 *                        checked/un-numbered + a timer summary row ("closed —
 *                        denied Sep 4"). A still-LIVE earlier letter keeps its
 *                        live "Awaiting response" rung (never hide a running
 *                        clock). Only the immediately-previous letter expands
 *                        by default; older ones collapse to their label row.
 *   GET IT READY       — provider/insurer mailing address, patient-identity
 *                        confirm, "Confirm the claim details" (embeds the REAL
 *                        CaseNeedsPanel via children), optional read-through.
 *   SEND IT            — Download & sign → Mail it certified → Mark it as sent.
 *   AFTER IT'S SENT    — before send: locked static guidance (unchanged).
 *                        Once sent (deadline engine on): the REAL schedule —
 *                        Awaiting response · response due date, scheduled
 *                        follow-ups + final notice (from followupPlan), and the
 *                        locked External review rung — with the guidance copy
 *                        carried verbatim as sub-lines. The stage-action bar
 *                        (Report the result / Sent to collections / escalate /
 *                        undo) renders at the bottom, driven by computeCaseStage.
 *   [later letters]    — when viewing an earlier letter: compact pointers to
 *                        the newer letters ("Go to this letter").
 *
 * Data rules: every state shown derives from live dispute data. Check-offs
 * that have no dedicated column (mailed-it, read-through, details confirmation,
 * follow-up done marks) persist via POST /api/disputes/[id]/checklist into
 * dispute.metadata.checklist (user-scoped) — previously session-local.
 */

import { useState, type ReactNode } from "react";
import { cn } from "@/lib/utils/cn";
import { PatientIdentityChoices } from "@/components/disputes/PatientIdentityChoices";
import type { LetterPatientIdentity } from "@/lib/disputes/letter-type";
import { computeCaseStage, stageActions } from "@/lib/disputes/case-stage";
import { GuidedPackCSection, GuidedPackDSection } from "@/components/disputes/GuidedSpineSteps";
import {
  SEND_GATE_COPY,
  type ReadinessBlocker,
} from "@/lib/disputes/dispute-readiness";

// ── Types ───────────────────────────────────────────────────────────────────

/** Real post-sent schedule for the viewed letter (null → deadline engine off →
 *  static guidance fallback, byte-identical to the pre-S286 behavior). */
export interface CaseTimelineEvents {
  /** deadlineWarning.severity === "past" — the response window elapsed. */
  windowPassed: boolean;
  windowPassedNextStep: string | null;
  /** deadlineWarning.daysRemaining (present only when the guard is urgent). */
  daysRemaining: number | null;
  /** Formatted governing-deadline date ("Sep 15, 2026"). */
  responseDueDateLabel: string | null;
  followups: Array<{ dueDate: string; dateLabel: string; kind: string }>;
  /** insurance_appeal track — the locked External review rung. */
  externalReviewLocked: boolean;
}

/** One letter in the claim's ladder (viewed letter included). */
export interface CaseLetterSummary {
  id: string;
  /** 1-based chronological position. */
  ordinal: number;
  /** "Provider dispute", "Insurance appeal", … */
  label: string;
  viewed: boolean;
  latest: boolean;
  sentDateLabel: string | null;
  /** "closed — denied Sep 4, 2026" (terminal) | null. */
  statusLine: string | null;
  /** Short outcome word for the viewing-past banner ("denied"). */
  outcomeWord: string | null;
  /** Sent + not terminal — its clock is still running. */
  live: boolean;
  liveDueLabel: string | null;
  href: string;
  /** Standard step set rendered checked/un-numbered for earlier letters. */
  steps: Array<{ title: string; done: boolean }>;
}

/** Draft-stage filing-deadline guard (absorbed from the retired CaseSummary
 *  countdown tile; amber, never red, per the style fence). */
export interface FilingWarning {
  passed: boolean;
  /** "Appeal window" / "Validation window" / "Deadline". */
  label: string;
  daysRemaining: number | null;
  dateLabel: string | null;
  nextStep: string | null;
}

export interface UnifiedTodoProps {
  /** "$775.00" — used in "Finish this list to get your $X moving." */
  amountLabel: string | null;
  sent: boolean;
  /**
   * S302 (tracker Item AB) — the server's readiness floor (`strength.readiness`),
   * now the ONE progress signal on this page.
   *
   * Before this the page carried two: this card's "4/7" required-step count at
   * the top, and CaseNeedsPanel's four-rung tier nested inside the claim-details
   * expansion, where nobody scrolls. They measured different things and could
   * disagree. Andrew's call: merge into one, floor-derived, with the step count
   * as its detail rather than the headline — the floor is the more truthful of
   * the two, because it knows what actually blocks sending.
   *
   * Null when the strength payload is absent → the header falls back to the
   * step-count pill, byte-identical to today.
   */
  readiness?: {
    state: "attention" | "ready_to_send" | "airtight";
    requiredMet: number;
    requiredTotal: number;
  } | null;
  /**
   * S302 — the floor items still missing, from the SHARED `sendBlockers`
   * (dispute-readiness.ts). Non-empty locks Download / Mail it certified /
   * Mark it as sent, and the same list is what the outcome route refuses the
   * transition on, so the button state and the server verdict agree by
   * construction. Empty (or flag OFF) = today's behaviour exactly.
   */
  sendBlockers?: ReadinessBlocker[];
  /** S299 phase 2a — one-letter mode: suppress the case-ladder furniture
   *  (earlier/later segments, viewing-past banner); the claim rail owns case
   *  navigation now. The letter-work rows are untouched. */
  letterOnly?: boolean;
  /** Formatted sent date — prefers sent_at over filed_date (S286). */
  sentDateLabel: string | null;
  /** Formatted response-due date — governing deadline, else sent + 30 days. */
  responseDueLabel: string | null;
  /** Dispute status — drives the stage-action bar + terminal rendering. */
  status?: string | null;
  /** "closed — denied Sep 4, 2026" for the viewed letter when terminal. */
  outcomeLine?: string | null;

  /** Who this letter mails to (letterRecipientKind) — drives the mailing-
   *  address needed row (insurer appeals address vs provider address) and the
   *  after-sent guidance copy (appeals line vs billing office). Collector
   *  letters follow the provider branch. */
  recipientKind: "insurer" | "provider" | "collector";

  // GET IT READY — mailing-address rows (which one is REQUIRED depends on
  // recipientKind; the other stays available inside claim details).
  providerAddressOnFile: boolean;
  /** S301 — collections track: the agency address this letter actually prints. */
  collectorAddressOnFile?: boolean;
  /** S301 — opens the collector-details editor (the parameterized CollectorModal). */
  onAddCollectorDetails?: () => void;
  /** S301 `letter_requirements_v1` — OFF keeps the insurer-or-provider binary. */
  letterRequirementsOn?: boolean;
  onAddProviderAddress: () => void;
  insurerAddressOnFile: boolean;
  onAddInsurerAddress: () => void;

  // GET IT READY — patient identity row (renders only when a mismatch exists).
  // "me" → letter name becomes the account name; "dependent" → keeps the bill
  // name; "wrong" → correctedName fills the letter. All three resolve the
  // mismatch via the real confirm-patient-identity flow in the parent.
  nameMismatch: { billName: string; profileName: string } | null;
  nameResolved: boolean;
  /** S307 (tracker AT round 2) — the stored answer, pre-selecting the widget. */
  patientIdentity?: LetterPatientIdentity | null;
  onResolvePatient: (choice: "me" | "dependent" | "wrong", correctedName?: string) => void;

  /**
   * GET IT READY — plan-year mismatch (S291, Andrew). Renders only when the
   * bill's care year has no matching plan on file, the same conditional shape
   * as the patient-identity row above.
   *
   * Both years are facts off real documents — the care date from the bill, the
   * plan year from the plan — so a disagreement means we'd be citing coverage
   * that wasn't in force. It sits ABOVE "Confirm the claim details" because the
   * plan under question is what that step confirms.
   *
   * `children` for this row is the EXISTING VerifStrip, passed in by the parent
   * rather than reimplemented: its copy is approved verbatim (S111 §3c) and it
   * already owns the upload / search-library / use-as-stand-in choices and the
   * "letter asks the insurer for the missing year" wording.
   */
  planYearMismatch: { billYear: number; planYear: number | null; insurerName: string | null } | null;
  planYearResolved: boolean;
  planYearStrip?: ReactNode;

  // GET IT READY — claim-details expansion (embeds the real CaseNeedsPanel)
  children?: ReactNode;
  /**
   * S295 — the claim-details row's REAL confirmation state, mirroring the
   * `nameResolved` / `planYearResolved` props its sibling rows already get.
   *
   * Before this the row's green "done" came only from the cosmetic `details`
   * checklist flag, which the footer button wrote. The two were decoupled in
   * BOTH directions: confirming inside the panel (which persists the coverage
   * marks + attestation and recomposes the letter) left the row reading
   * "to-do", while the footer button turned the row green having written
   * nothing about the claim. Same family as the S294 "Done does nothing"
   * recurrence and the S291 "looked answered while nothing was written".
   *
   * Null when the details block isn't active (no truth to read) → the row
   * falls back to the persisted check, so nothing regresses.
   */
  detailsConfirmed?: boolean | null;

  // Optional read-through
  onOpenLetter: () => void;

  // SEND IT
  onDownload: () => void;
  onMarkSent: () => void;
  markingSent: boolean;

  // ── Unified case timeline (S286) ──────────────────────────────────────────
  /** Persisted check-offs from dispute.metadata.checklist. */
  initialChecks?: Record<string, boolean>;
  /** Persist one check-off (fire-and-forget; local state is optimistic). */
  onPersistCheck?: (key: string, done: boolean) => void;
  /** Real schedule once sent; null → static guidance fallback. */
  caseEvents?: CaseTimelineEvents | null;
  /** The claim's ladder (chronological, viewed letter included). Empty/single
   *  → no segment chrome (single-letter case renders exactly as before). */
  letters?: CaseLetterSummary[];
  /** Draft-stage filing-deadline guard. */
  filingWarning?: FilingWarning | null;
  // Stage-action bar (transplanted from the retired CaseSummary; handlers
  // live on the page). Omitted handlers hide their action.
  nextStepLabel?: string | null;
  escalating?: boolean;
  onReportOutcome?: () => void;
  onCollections?: () => void;
  onEscalateNext?: () => void;
  onUndoSent?: () => void;
  onUndoOutcome?: () => void;

  // ── Guided Steps v1 (S297) — spine packs. The PAGE decides mounting (flag +
  // track/terminal predicates); null/omitted → nothing renders (flag-OFF =
  // byte-identical spine). Booleans persist via the EXISTING checklist
  // plumbing (initialChecks/onPersistCheck); notes via the S297 extension.
  guidedPackC?: {
    collectorName: string | null;
    firstContactDateLabel: string | null;
    validationDeadlineLabel: string | null;
  } | null;
  guidedPackD?: { suggested: Array<"ag" | "cfpb" | "cms" | "doi"> } | null;
  /** Persisted per-row notes from dispute.metadata.checklistNotes. */
  initialNotes?: Record<string, string>;
  /** Persist one note (fire-and-forget; local state is optimistic). */
  onPersistNote?: (key: string, note: string) => void;
}

type RowState = "todo" | "done" | "locked" | "skipped";

// ── Icons ───────────────────────────────────────────────────────────────────

function CheckIcon({ size = 11 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M5 13l4 4L19 7" />
    </svg>
  );
}

function LockIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M7 11V7a5 5 0 0110 0v4M5 11h14v10H5V11z" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" aria-hidden>
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

function PlayIcon() {
  return (
    <svg width="9" height="9" viewBox="0 0 24 24" fill="#2563eb" aria-hidden>
      <path d="M8 5v14l11-7z" />
    </svg>
  );
}

function ClockIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}

// ── Row chrome ──────────────────────────────────────────────────────────────

function TodoDot({
  state,
  num,
  optional,
  onToggle,
}: {
  state: RowState;
  num: number | null;
  optional?: boolean;
  onToggle?: () => void;
}) {
  return (
    <button
      type="button"
      disabled={state === "locked" || (!onToggle && state !== "done")}
      onClick={() => {
        if (onToggle && state !== "locked") onToggle();
      }}
      className={cn(
        "mt-0.5 grid h-[22px] w-[22px] flex-shrink-0 place-items-center rounded-full text-[11px] font-bold",
        state === "done"
          ? "bg-emerald-50 text-emerald-700 ring-1 ring-inset ring-emerald-300"
          : state === "locked"
            ? "bg-white text-gray-400 ring-[1.5px] ring-inset ring-gray-200"
            : optional
              ? "bg-gray-50 text-gray-400 ring-[1.5px] ring-inset ring-gray-200"
              : "bg-white text-gray-500 ring-[1.5px] ring-inset ring-gray-300",
        onToggle && state !== "locked" ? "cursor-pointer" : "cursor-default",
      )}
      aria-hidden={!onToggle}
      tabIndex={onToggle ? 0 : -1}
    >
      {state === "done" ? <CheckIcon /> : state === "locked" ? <LockIcon /> : optional ? <PlusIcon /> : num}
    </button>
  );
}

/** Case-EVENT dot — same 22px chrome as TodoDot, icon vocabulary carried from
 *  the retired CaseSummary timeline: done ✓ / current ▶ / scheduled 🕐 / locked. */
function EventDot({ kind }: { kind: "done" | "current" | "scheduled" | "locked" }) {
  return (
    <span
      className={cn(
        "mt-0.5 grid h-[22px] w-[22px] flex-shrink-0 place-items-center rounded-full",
        kind === "done" && "bg-emerald-50 text-emerald-700 ring-1 ring-inset ring-emerald-300",
        kind === "current" && "bg-blue-50 ring-1 ring-inset ring-blue-200",
        kind === "scheduled" && "bg-amber-50 text-amber-600 ring-1 ring-inset ring-amber-200",
        kind === "locked" && "bg-white text-gray-400 ring-[1.5px] ring-inset ring-gray-200",
      )}
      aria-hidden
    >
      {kind === "done" ? <CheckIcon /> : kind === "current" ? <PlayIcon /> : kind === "scheduled" ? <ClockIcon /> : <LockIcon />}
    </span>
  );
}

interface RowDef {
  id: string;
  title: string;
  sub?: ReactNode;
  state: RowState;
  required: boolean;
  cta?: string;
  onDo?: () => void;
  onSkip?: () => void;
  /** Checkable directly via the dot (send/after check-offs). */
  checkable?: boolean;
  /** Inline confirm instead of immediate action (Mark as sent). */
  confirm?: boolean;
}

/** One case-timeline event row (post-sent real schedule). */
interface EventRowDef {
  key: string;
  kind: "done" | "current" | "scheduled" | "locked";
  title: string;
  sub?: ReactNode;
  /** Persisted-check key → renders a "Mark done" affordance. */
  checkKey?: string;
}

const TERMINAL = new Set([
  "won",
  "lost",
  "settled",
  "withdrawn",
  "won_on_escalation",
  "settled_on_escalation",
]);

// ── Component ───────────────────────────────────────────────────────────────

export function UnifiedTodo({
  amountLabel,
  sent,
  readiness = null,
  sendBlockers = [],
  letterOnly = false,
  sentDateLabel,
  responseDueLabel,
  status = null,
  outcomeLine = null,
  recipientKind,
  providerAddressOnFile,
  collectorAddressOnFile = false,
  onAddCollectorDetails,
  letterRequirementsOn = false,
  onAddProviderAddress,
  insurerAddressOnFile,
  onAddInsurerAddress,
  nameMismatch,
  patientIdentity,
  planYearMismatch,
  planYearResolved,
  planYearStrip,
  nameResolved,
  onResolvePatient,
  children,
  detailsConfirmed = null,
  onOpenLetter,
  onDownload,
  onMarkSent,
  markingSent,
  initialChecks,
  onPersistCheck,
  caseEvents = null,
  letters = [],
  filingWarning = null,
  nextStepLabel = null,
  escalating = false,
  onReportOutcome,
  onCollections,
  onEscalateNext,
  onUndoSent,
  onUndoOutcome,
  guidedPackC = null,
  guidedPackD = null,
  initialNotes,
  onPersistNote,
}: UnifiedTodoProps) {
  const [expanded, setExpanded] = useState<"patient" | "details" | "planyear" | null>(null);
  const [checks, setChecks] = useState<Record<string, boolean>>({});
  const [asking, setAsking] = useState(false);
  // Earlier-letter segments — the immediately-previous letter expands by
  // default; older ones collapse to their label row (3+ letter cases).
  const [prevExpanded, setPrevExpanded] = useState<Record<string, boolean>>({});

  // Server-persisted checks fill the base; local optimistic toggles win.
  const effChecks: Record<string, boolean> = { ...(initialChecks ?? {}), ...checks };
  const setCheck = (id: string, v: boolean) => {
    setChecks((c) => ({ ...c, [id]: v }));
    onPersistCheck?.(id, v);
  };
  const toggleCheck = (id: string) => setCheck(id, !effChecks[id]);

  // Guided Steps v1 (S297) — per-row notes beside the booleans, same
  // optimistic-local + fire-and-forget persistence idiom as setCheck.
  const [notesLocal, setNotesLocal] = useState<Record<string, string>>({});
  const effNotes: Record<string, string> = { ...(initialNotes ?? {}), ...notesLocal };
  const saveNote = (key: string, note: string) => {
    setNotesLocal((n) => ({ ...n, [key]: note }));
    onPersistNote?.(key, note);
  };

  // S295 — real confirmation state wins when we have it; the persisted check is
  // the fallback for the case where the details block isn't rendering (nothing
  // to derive from). See `detailsConfirmed` on the props for why.
  const detailsDone = detailsConfirmed ?? effChecks.details === true;
  const readState: "todo" | "done" | "skipped" = effChecks.read
    ? "done"
    : effChecks.read_skipped
      ? "skipped"
      : "todo";

  const lockIfSent = (s: RowState): RowState => (sent && s === "todo" ? "locked" : s);

  // GET IT READY — the REQUIRED mailing-address row targets whoever this
  // letter actually mails to; the other address stays editable inside the
  // claim-details expansion.
  // Which address THIS letter prints. Under the flag it is the real three-way
  // answer; OFF it collapses to the legacy insurer-or-provider binary.
  const mailingTo: "insurer" | "provider" | "collector" = letterRequirementsOn
    ? recipientKind
    : recipientKind === "insurer"
      ? "insurer"
      : "provider";
  // DERIVED, not a second source: the after-sent guidance copy still splits
  // insurer-vs-other, and two independent booleans for one question is the
  // drift this whole unit exists to remove.
  const insurerMailing = mailingTo === "insurer";
  const prepRows: RowDef[] = [
    {
      id: "address",
      // S301 — THREE recipients, not two. `insurerMailing` is a binary, so a
      // COLLECTOR letter fell to the else-branch and asked for the provider's
      // mailing address, with an Add button that opened the PROVIDER modal —
      // banked defect #2, in a fourth place nobody had listed (Andrew found it
      // in the S301 E2E, still showing after the needs panel was re-keyed).
      // Flag OFF keeps the two-way binary exactly.
      title:
        mailingTo === "insurer"
          ? "Add your insurer's appeals address"
          : mailingTo === "collector"
            ? // COPY PENDING ANDREW APPROVAL (S301) — names BOTH required fields,
              // because this one row now collects the address AND the account
              // number and a title saying only "address" understates it.
              "Add the collection agency's details"
            : "Add the provider's mailing address",
      sub:
        mailingTo === "insurer"
          ? "The appeal has nowhere to be mailed without it."
          : mailingTo === "collector"
            ? // COPY PENDING ANDREW APPROVAL (S301)
              "Their mailing address and the account number for this debt — both required."
            : "The letter has nowhere to be mailed without it.",
      state: lockIfSent(
        (mailingTo === "insurer"
          ? insurerAddressOnFile
          : mailingTo === "collector"
            ? collectorAddressOnFile
            : providerAddressOnFile)
          ? "done"
          : "todo",
      ),
      required: true,
      cta: "Add address",
      onDo:
        mailingTo === "insurer"
          ? onAddInsurerAddress
          : mailingTo === "collector"
            ? (onAddCollectorDetails ?? onAddProviderAddress)
            : onAddProviderAddress,
    },
    ...(nameMismatch
      ? [
          {
            id: "patient",
            title: "Confirm who the patient is",
            sub: (
              <>
                The bill lists <strong className="text-gray-900">&ldquo;{nameMismatch.billName}&rdquo;</strong>; your
                account is <strong className="text-gray-900">{nameMismatch.profileName}</strong>.
              </>
            ),
            state: lockIfSent(nameResolved ? "done" : "todo"),
            required: true,
            cta: "Resolve name",
            onDo: () => setExpanded((e) => (e === "patient" ? null : "patient")),
          } satisfies RowDef,
        ]
      : []),
    ...(planYearMismatch
      ? [
          {
            id: "planyear",
            title: `This bill is from ${planYearMismatch.billYear} — your plan is ${planYearMismatch.planYear ?? "from another year"}`,
            sub: "We need the plan you had when the care happened.",
            state: lockIfSent(planYearResolved ? "done" : "todo"),
            required: true,
            cta: "Fix this",
            onDo: () => setExpanded((e) => (e === "planyear" ? null : "planyear")),
          } satisfies RowDef,
        ]
      : []),
    {
      id: "details",
      title: "Confirm the claim details",
      // Approved copy (2026-07-18) — carried-forward acknowledgment when this
      // letter follows an earlier one on the same claim.
      sub:
        letters.some((l) => l.viewed && l.ordinal > 1)
          ? "Already on file from your last letter — confirm it still looks right."
          : "Addresses, EOB, plan costs, and the insurance this letter uses.",
      state: lockIfSent(detailsDone ? "done" : "todo"),
      required: true,
      cta: expanded === "details" ? "Close" : "Confirm details",
      onDo: () => setExpanded((e) => (e === "details" ? null : "details")),
    },
    {
      id: "review",
      title: "Read it through once",
      sub: "Skim top to bottom and edit anything that doesn't sound like you.",
      state: sent && readState === "todo" ? "locked" : readState === "done" ? "done" : readState === "skipped" ? "skipped" : "todo",
      required: false,
      cta: "Open letter",
      onDo: () => {
        onOpenLetter();
        setCheck("read", true);
      },
      onSkip: () => setCheck("read_skipped", true),
    },
  ];

  // SEND IT
  //
  // S302 — locked until the readiness floor is met (Andrew: "make sure the
  // letter can\u2019t be sent or used until the required fields are added").
  // `locked` is the row state the spine already has for after-sent guidance, so
  // this needs no new visual vocabulary. The server refuses the same transition
  // on the same list, so a stale tab cannot slip past the screen.
  const gateBlocked = !sent && sendBlockers.length > 0;
  const lockIfGated = (s: RowState): RowState => (gateBlocked ? "locked" : s);
  const sendRows: RowDef[] = [
    {
      id: "download",
      title: "Download & sign the letter",
      sub: "Print it, sign in ink, keep a copy.",
      state: lockIfGated(sent || effChecks.download ? "done" : "todo"),
      required: true,
      cta: "Download",
      onDo: () => {
        if (gateBlocked) return;
        onDownload();
        setCheck("download", true);
      },
      checkable: true,
    },
    // S302 round 2 (Andrew): "Mail it certified / Done — I mailed it" and "Mark
    // it as sent" were TWO rows for ONE act. They are two FACTS — the method
    // (certified mail is delivery evidence the letter and Case File cite) and
    // the event (sent, which starts the clock) — but the user performs them
    // together, so the method is now asked ON the confirm that already exists
    // rather than as a row of its own. One row, one act, method still captured.
    {
      id: "marksent",
      title: "Mark it as sent",
      sub: "Starts the clock on their response and schedules your follow-up reminders.",
      state: lockIfGated(sent ? "done" : "todo"),
      required: true,
      cta: "Mark as sent",
      onDo: () => {
        if (gateBlocked) return;
        setAsking(true);
      },
      confirm: true,
    },
  ];

  // AFTER IT'S SENT — guidance copy follows the recipient (appeal to the
  // insurer vs a provider/collector-directed dispute). Copy carried VERBATIM
  // into the event rungs below when the real schedule renders.
  const watchGuidance = insurerMailing
    ? "Most insurers must respond within 30 days of receipt."
    : "Providers and collectors typically respond within 30 days.";
  const followupGuidance = insurerMailing
    ? "No response? Call the appeals line with your tracking number."
    : "No response? Call the billing office with your tracking number.";
  const escalateGuidance = insurerMailing
    ? "Your state Insurance Commissioner or a healthcare attorney can step in."
    : "Your state Attorney General's consumer division or a healthcare attorney can step in.";

  // Static guidance fallback — pre-send (locked) AND sent-with-engine-off.
  const staticAfterRows: RowDef[] = [
    { id: "watch", title: "Watch for a reply", sub: watchGuidance },
    { id: "followup", title: "Follow up at day 30", sub: followupGuidance },
    { id: "escalate", title: "Escalate if unresolved", sub: escalateGuidance },
  ].map((r) => ({
    ...r,
    required: true,
    checkable: true,
    cta: "Mark done",
    state: (!sent ? "locked" : effChecks[r.id] ? "done" : "todo") as RowState,
    onDo: () => {
      if (sent) toggleCheck(r.id);
    },
  }));

  const terminal = TERMINAL.has(status ?? "");
  // Real-schedule mode: sent + deadline engine data present. Terminal letters
  // also use it (summary rung), even when events are sparse.
  const eventMode = sent && (caseEvents != null || terminal);

  // The real case-timeline rungs (eventMode only).
  const eventRows: EventRowDef[] = [];
  if (eventMode) {
    if (terminal) {
      eventRows.push({
        key: "response",
        kind: "done",
        title: "Awaiting response",
        sub: outcomeLine ?? undefined,
      });
    } else if (caseEvents?.windowPassed) {
      eventRows.push({
        key: "past",
        kind: "current",
        title: "Response window has passed",
        sub: caseEvents.windowPassedNextStep ?? undefined,
      });
    } else {
      eventRows.push({
        key: "awaiting",
        kind: "current",
        title: "Awaiting response",
        sub: (
          <>
            {caseEvents?.responseDueDateLabel ? (
              <span className="font-medium text-gray-700">
                Response due {caseEvents.responseDueDateLabel}
                {caseEvents.daysRemaining != null
                  ? ` · ${caseEvents.daysRemaining} ${caseEvents.daysRemaining === 1 ? "day" : "days"} left`
                  : ""}
              </span>
            ) : null}
            {caseEvents?.responseDueDateLabel ? <br /> : null}
            {watchGuidance}
          </>
        ),
      });
    }
    if (!terminal) {
      (caseEvents?.followups ?? []).forEach((f, i) => {
        const checkKey = `after-fu-${f.dueDate}-${f.kind}`;
        eventRows.push({
          key: checkKey,
          kind: effChecks[checkKey] ? "done" : "scheduled",
          title: f.kind === "deadline_final" ? "Final notice" : "Follow-up",
          sub: (
            <>
              Scheduled {f.dateLabel}
              {i === 0 ? (
                <>
                  <br />
                  {followupGuidance}
                </>
              ) : null}
            </>
          ),
          checkKey,
        });
      });
      if (caseEvents?.externalReviewLocked) {
        eventRows.push({
          key: "external",
          kind: "locked",
          title: "External review",
          sub: "Unlocks after a final internal denial.",
        });
      }
    }
  }

  // Stage-action bar (transplanted from the retired CaseSummary). mark_sent is
  // excluded — the SEND IT step + inline confirm owns that action in this card.
  const stage = computeCaseStage({
    status,
    isSent: sent,
    hasNextStep: !!nextStepLabel,
  });
  const barActions = stageActions(stage).filter((a) => a !== "mark_sent");
  const showActionBar =
    sent && (barActions.length > 0 || (stage === "resolved" && !!onUndoOutcome));
  const actionCls = (primary: boolean) =>
    primary
      ? "inline-flex items-center rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-blue-700 disabled:opacity-60"
      : "inline-flex items-center rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-700 shadow-sm transition-colors hover:bg-gray-50 disabled:opacity-60";

  // Ladder partition — earlier letters render above the viewed letter's steps,
  // later ones (visible only when viewing an old letter) below the action bar.
  // letterOnly (S299 2a): an empty partition suppresses ALL ladder furniture
  // (segments, viewing-past banner, later letters) in one gate.
  const viewedLetter = letterOnly ? null : (letters.find((l) => l.viewed) ?? null);
  const earlierLetters = viewedLetter
    ? letters.filter((l) => l.ordinal < viewedLetter.ordinal)
    : [];
  const laterLetters = viewedLetter
    ? letters.filter((l) => l.ordinal > viewedLetter.ordinal)
    : [];
  const latestLetter = letters.find((l) => l.latest) ?? null;
  const viewingPast = viewedLetter != null && !viewedLetter.latest;
  const isPrevExpanded = (l: CaseLetterSummary) =>
    prevExpanded[l.id] ?? (viewedLetter != null && l.ordinal === viewedLetter.ordinal - 1);

  // S302 — the ONE readiness signal. Labels are the server's three states; the
  // client's four-rung `computeTier` is deleted (it counted a different row set
  // and could disagree with the score that actually prints in the Case File).
  const readinessMeta =
    readiness == null
      ? null
      : readiness.state === "attention"
        ? { label: "Not ready to send", pill: "border-amber-200 bg-amber-50 text-amber-800" }
        : readiness.state === "airtight"
          ? { label: "Airtight", pill: "border-emerald-200 bg-emerald-50 text-emerald-700" }
          : { label: "Ready to send", pill: "border-blue-200 bg-blue-50 text-blue-700" };

  const all = [...prepRows, ...sendRows, ...(eventMode ? [] : staticAfterRows)];
  const required = all.filter((r) => r.required);
  const reqDone = required.filter((r) => r.state === "done").length;
  const current = all.find((r) => r.required && r.state === "todo") ?? null;

  let n = 0;
  const groups: Array<{ id: string; label: string; rows: RowDef[] }> = [
    { id: "ready", label: "Get it ready", rows: prepRows },
    { id: "send", label: "Send it", rows: sendRows },
    ...(eventMode ? [] : [{ id: "after", label: "After it's sent", rows: staticAfterRows }]),
  ];

  const microLabel = (l: CaseLetterSummary) => `Letter ${l.ordinal} · ${l.label}`;

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm md:p-6">
      {/* Viewing-past banner — approved copy (2026-07-18). */}
      {viewingPast && latestLetter && viewedLetter && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-blue-200 bg-blue-50 px-3.5 py-2.5 text-[12.5px] text-blue-900">
          <span>
            You&rsquo;re viewing an earlier letter
            {viewedLetter.sentDateLabel ? ` — sent ${viewedLetter.sentDateLabel}` : ""}
            {viewedLetter.outcomeWord ? ` · ${viewedLetter.outcomeWord}` : ""}.
          </span>
          <a
            href={latestLetter.href}
            className="font-semibold text-blue-700 hover:underline"
          >
            Go to your current letter →
          </a>
        </div>
      )}

      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-[15px] font-bold tracking-[-0.005em] text-gray-900">What you need to do</h3>
          <p className="mt-0.5 text-[12.5px] text-gray-500">
            {sent
              ? `Sent${sentDateLabel ? ` ${sentDateLabel}` : ""}${
                  terminal && outcomeLine
                    ? ` · ${outcomeLine}`
                    : responseDueLabel
                      ? ` · response due by ${responseDueLabel}`
                      : ""
                }`
              : `${readinessMeta ? `${reqDone} of ${required.length} steps done · f` : "F"}inish this list to get your ${amountLabel ?? "appeal"} moving.`}
          </p>
        </div>
        {/* S302 / Item AB — the readiness floor, promoted to the one place the
            eye lands. Falls back to the step-count pill when the strength
            payload is absent, so nothing regresses without it. */}
        {readinessMeta ? (
          <span
            className={
              "flex-shrink-0 whitespace-nowrap rounded-full border px-2.5 py-1 text-[12px] font-bold " +
              readinessMeta.pill
            }
          >
            {readinessMeta.label}
          </span>
        ) : (
          <span className="flex-shrink-0 rounded-full bg-blue-50 px-2.5 py-1 text-[12px] font-bold tabular-nums text-blue-700 ring-1 ring-inset ring-blue-200">
            {reqDone}/{required.length}
          </span>
        )}
      </div>

      {/* Draft-stage filing-deadline guard — absorbed from the retired
          CaseSummary countdown tile (amber, never red). */}
      {!sent && filingWarning && (
        <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-[12px] leading-snug text-amber-800">
          {filingWarning.passed ? (
            <>
              <span className="font-medium">This filing window has passed.</span>
              {filingWarning.nextStep ? (
                <span className="ml-1 text-amber-700">{filingWarning.nextStep}</span>
              ) : null}
            </>
          ) : (
            <>
              <span className="font-medium">
                {filingWarning.label}
                {filingWarning.daysRemaining != null
                  ? `: ${filingWarning.daysRemaining} ${filingWarning.daysRemaining === 1 ? "day" : "days"} left`
                  : ""}
              </span>
              {filingWarning.dateLabel ? (
                <span className="ml-1 text-amber-700">— file before {filingWarning.dateLabel}</span>
              ) : null}
            </>
          )}
        </div>
      )}

      {/* Guided Steps v1 (S297) — Pack C collections guard-rail, above the
          letter work it wraps. Page-gated (collections track + flag). */}
      {guidedPackC && (
        <GuidedPackCSection
          collectorName={guidedPackC.collectorName}
          firstContactDateLabel={guidedPackC.firstContactDateLabel}
          validationDeadlineLabel={guidedPackC.validationDeadlineLabel}
          checks={effChecks}
          notes={effNotes}
          onToggle={toggleCheck}
          onNote={saveNote}
          onOpenLetter={onOpenLetter}
          onReportOutcome={onReportOutcome}
          onNeedFirstContact={() => setExpanded("details")}
        />
      )}

      {/* Earlier letters — un-numbered, checked history (approved: items stay
          visible; only the immediately-previous letter expands by default). */}
      {earlierLetters.map((l) => {
        const open = isPrevExpanded(l);
        return (
          <div key={l.id} className="mt-1.5">
            <div className="mb-1 mt-3 flex items-center justify-between gap-2">
              <button
                type="button"
                onClick={() => setPrevExpanded((m) => ({ ...m, [l.id]: !open }))}
                className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.1em] text-gray-400"
                aria-expanded={open}
              >
                <svg
                  width="9"
                  height="9"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={3}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className={cn("transition-transform", open && "rotate-90")}
                  aria-hidden
                >
                  <path d="M9 6l6 6-6 6" />
                </svg>
                {microLabel(l)}
              </button>
              {/* Approved copy (2026-07-18). */}
              <a href={l.href} className="flex-shrink-0 text-[12px] font-semibold text-blue-600 hover:underline">
                Go back to this letter
              </a>
            </div>
            {open ? (
              <>
                {l.steps.map((s, i) => (
                  <div key={`${l.id}-s${i}`} className="flex items-start gap-2.5 rounded-xl px-2 py-1">
                    <EventDot kind={s.done ? "done" : "locked"} />
                    <div className="min-w-0 flex-1 pt-0.5 text-[13px] font-semibold leading-snug text-gray-400">
                      {s.title}
                    </div>
                  </div>
                ))}
                {/* Timer summary — collapses to the resolution once closed; a
                    still-LIVE clock keeps its live rung (never hidden). */}
                <div className="flex items-start gap-2.5 rounded-xl px-2 py-1">
                  <EventDot kind={l.live ? "current" : "done"} />
                  <div className="min-w-0 flex-1 pt-0.5">
                    <div className={cn("text-[13px] font-semibold leading-snug", l.live ? "text-gray-900" : "text-gray-400")}>
                      Awaiting response
                    </div>
                    <div className="mt-0.5 text-[11.5px] leading-relaxed text-gray-500">
                      {l.live
                        ? l.liveDueLabel
                          ? `Response due ${l.liveDueLabel}`
                          : "Response window open"
                        : (l.statusLine ?? "closed")}
                    </div>
                  </div>
                </div>
              </>
            ) : (
              <div className="px-2 pb-1 text-[11.5px] leading-relaxed text-gray-500">
                {l.sentDateLabel ? `Sent ${l.sentDateLabel}` : "Not sent"}
                {l.live
                  ? l.liveDueLabel
                    ? ` · response due ${l.liveDueLabel}`
                    : " · response window open"
                  : l.statusLine
                    ? ` · ${l.statusLine}`
                    : ""}
              </div>
            )}
          </div>
        );
      })}

      {/* Viewed-letter micro-label (multi-letter cases only). */}
      {viewedLetter && letters.length > 1 && (
        <div className="mb-0.5 mt-3 text-[10px] font-bold uppercase tracking-[0.1em] text-blue-600">
          {microLabel(viewedLetter)}
        </div>
      )}

      {groups.map((g) => (
        <div key={g.id} className="mt-1.5">
          <div className="mb-1 mt-3 text-[10px] font-bold uppercase tracking-[0.1em] text-gray-400">
            {g.label}
          </div>
          {/* S302 — WHY the send steps are locked, named item by item with its
              remedy. "Not ready to send" without a remedy is the dead end this
              gate exists to end; each line points at the row above that fixes
              it. Renders only on the SEND group, only while blocked. */}
          {g.id === "send" && gateBlocked && (
            <div className="mb-2 mt-1 rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-2.5">
              <div className="text-[12.5px] font-bold text-amber-800">
                {SEND_GATE_COPY.heading(sendBlockers.length)}
              </div>
              <ul className="mt-1 space-y-0.5">
                {sendBlockers.map((b) => {
                  const c = SEND_GATE_COPY.blocker(b, mailingTo);
                  return (
                    <li key={b} className="text-[12px] leading-relaxed text-amber-700">
                      · <span className="font-semibold">{c.what}</span> — {c.fix}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
          {g.rows.map((row) => {
            if (row.required) n += 1;
            const num = row.required ? n : null;
            const isCurrent = current?.id === row.id;
            // Prep rows stay re-editable after completion until the letter is
            // marked sent (the milestone that locks them).
            const updatable =
              !sent && row.state === "done" && ["address", "patient", "details"].includes(row.id);
            return (
              <div key={row.id}>
                <div
                  className={cn(
                    "flex flex-wrap items-start gap-2.5 rounded-xl px-2 py-2 sm:flex-nowrap",
                    isCurrent && "bg-blue-50 ring-1 ring-inset ring-blue-200",
                    row.state === "locked" && "opacity-55",
                  )}
                >
                  <TodoDot
                    state={row.state}
                    num={num}
                    optional={!row.required}
                    onToggle={row.checkable ? row.onDo : undefined}
                  />
                  <div className="min-w-0 flex-1 pt-0.5">
                    <div
                      className={cn(
                        "flex flex-wrap items-center gap-2 text-[13px] font-semibold leading-snug",
                        row.state === "done" ? "text-gray-400" : "text-gray-900",
                        row.state === "skipped" && "text-gray-400 line-through",
                      )}
                    >
                      {row.title}
                      {!row.required && row.state === "todo" && (
                        <span className="rounded-full border border-gray-200 bg-gray-100 px-1.5 py-px text-[9px] font-bold uppercase tracking-[0.07em] text-gray-400 no-underline">
                          Optional
                        </span>
                      )}
                    </div>
                    {row.sub && row.state !== "done" && (
                      <div className="mt-0.5 text-[11.5px] leading-relaxed text-gray-500">{row.sub}</div>
                    )}
                  </div>
                  {/* Row action */}
                  {row.state === "todo" && row.cta && !row.confirm && row.required && (
                    <button
                      type="button"
                      onClick={row.onDo}
                      className={cn(
                        "flex-shrink-0 self-center rounded-lg px-3 py-1.5 text-[12.5px] font-semibold transition-colors",
                        "max-sm:basis-full",
                        isCurrent
                          ? "bg-blue-600 text-white hover:bg-blue-700"
                          : "border border-gray-200 bg-white text-gray-700 hover:bg-gray-50",
                      )}
                    >
                      {row.cta}
                    </button>
                  )}
                  {row.state === "todo" && row.confirm && !asking && (
                    <button
                      type="button"
                      onClick={row.onDo}
                      className={cn(
                        "flex-shrink-0 self-center rounded-lg px-3 py-1.5 text-[12.5px] font-semibold transition-colors",
                        "max-sm:basis-full",
                        isCurrent
                          ? "bg-blue-600 text-white hover:bg-blue-700"
                          : "border border-gray-200 bg-white text-gray-700 hover:bg-gray-50",
                      )}
                    >
                      {row.cta}
                    </button>
                  )}
                  {/* Re-open affordance — done prep rows stay editable until sent. */}
                  {updatable && (
                    <button
                      type="button"
                      onClick={row.onDo}
                      className="flex-shrink-0 self-center text-[12px] font-semibold text-blue-600 hover:underline"
                    >
                      Update
                    </button>
                  )}
                  {row.state === "todo" && !row.required && (
                    <span className="flex flex-shrink-0 items-center gap-2.5 self-center max-sm:basis-full">
                      <button
                        type="button"
                        onClick={row.onDo}
                        className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-[12.5px] font-semibold text-gray-700 transition-colors hover:bg-gray-50"
                      >
                        {row.cta}
                      </button>
                      <button
                        type="button"
                        onClick={row.onSkip}
                        className="text-[12px] font-semibold text-gray-400 hover:underline"
                      >
                        Skip
                      </button>
                    </span>
                  )}
                </div>

                {/* Inline expansion — patient identity (three choices, all
                    resolving through the real confirm-patient-identity flow;
                    "me"/"wrong" also fill the letter name in the parent).
                    Re-openable after completion until the letter is sent. */}
                {row.id === "planyear" && expanded === "planyear" && !sent && planYearStrip && (
                  <div className="animate-fade-in mt-2 mb-2.5">{planYearStrip}</div>
                )}
                {row.id === "patient" && expanded === "patient" && !sent && nameMismatch && (
                  <div className="mt-2 mb-2.5">
                    {/* S294 — THE shared three-choice question (PatientIdentityChoices).
                        Extracted verbatim from the block that lived here so
                        CaseNeedsPanel's one-click "This is me" could adopt the
                        SAME form instead of resolving with no choice. */}
                    <PatientIdentityChoices
                      initialIdentity={patientIdentity}
                      billName={nameMismatch.billName}
                      profileName={nameMismatch.profileName}
                      onResolve={(choice, correctedName) => {
                        onResolvePatient(choice, correctedName);
                        setExpanded(null);
                      }}
                      onCancel={() => setExpanded(null)}
                    />
                  </div>
                )}

                {/* Inline expansion — claim details. The embedded (chromeless)
                    CaseNeedsPanel and this wrapper read as ONE card; the
                    wrapper owns the border, padding, and footer actions. */}
                {row.id === "details" && expanded === "details" && (
                  <div className="animate-fade-in mt-2 mb-2.5 rounded-[14px] border border-blue-200 bg-white p-4 shadow-[0_14px_30px_-20px_rgba(37,99,235,0.35)] sm:p-5">
                    {children}
                    <div className="mt-3 flex justify-end gap-2 border-t border-gray-100 pt-3">
                      <button
                        type="button"
                        onClick={() => setExpanded(null)}
                        className="rounded-lg px-3 py-1.5 text-[12.5px] font-semibold text-gray-500 hover:bg-gray-50"
                      >
                        Close
                      </button>
                      {/* S295 — demoted from a blue "These are right" that sat
                          inches below the panel's own blue "These look right"
                          and looked like the same action while writing only a
                          cosmetic flag. Now a neutral dismissal: it records
                          that the user has been through the section and
                          collapses it. The panel's button remains the ONLY
                          affirmative control, and the row's done-state comes
                          from what that button actually persisted. */}
                      {!sent && (
                        <button
                          type="button"
                          onClick={() => {
                            setCheck("details", true);
                            setExpanded(null);
                          }}
                          className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-[12.5px] font-semibold text-gray-700 hover:bg-gray-50"
                        >
                          Done reviewing
                        </button>
                      )}
                    </div>
                  </div>
                )}

                {/* Inline confirm — Mark as sent */}
                {row.id === "marksent" && asking && !sent && (
                  <div className="animate-fade-in mt-2 mb-2 rounded-[10px] border border-blue-200 bg-blue-50 px-3 py-2.5 text-[12.5px] text-blue-900">
                    {/* S302 — the METHOD, asked where the send is confirmed.
                        `mailcert` is still the stored fact (the receipts and the
                        Case File cite "certified mail"); only the extra ROW is
                        gone. Choosing a method IS the confirmation, so there is
                        no second click to lose. */}
                    <div className="font-semibold">How did you send it?</div>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      {(
                        [
                          ["certified", "USPS certified mail"],
                          ["mail", "Regular mail"],
                          ["portal", "Insurer portal or email"],
                        ] as const
                      ).map(([kind, label]) => (
                        <button
                          key={kind}
                          type="button"
                          disabled={markingSent}
                          onClick={() => {
                            setAsking(false);
                            // Certified is the only method that is evidence, so
                            // it is the only one that sets the flag — and an
                            // earlier answer must be cleared if they change it.
                            setCheck("mailcert", kind === "certified");
                            onMarkSent();
                          }}
                          className="rounded-lg border border-blue-200 bg-white px-3 py-1.5 font-semibold text-blue-800 hover:bg-blue-50 disabled:opacity-50"
                        >
                          {label}
                        </button>
                      ))}
                      <button
                        type="button"
                        onClick={() => setAsking(false)}
                        className="rounded-lg px-2 py-1.5 font-semibold text-gray-500 hover:text-gray-700"
                      >
                        Not yet
                      </button>
                    </div>
                    <div className="mt-1.5 text-[11.5px] font-normal text-blue-800/80">
                      {markingSent
                        ? "Saving…"
                        : "Certified mail (USPS Form 3811) is your proof of delivery — we cite it in your letter and Case File."}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ))}

      {/* AFTER IT'S SENT — the REAL case timeline (replaces the static guidance
          trio once sent; the retired "The case" card's rungs live here now). */}
      {eventMode && (
        <div className="mt-1.5">
          <div className="mb-1 mt-3 text-[10px] font-bold uppercase tracking-[0.1em] text-gray-400">
            After it&apos;s sent
          </div>
          {eventRows.map((row) => (
            <div
              key={row.key}
              className={cn(
                "flex flex-wrap items-start gap-2.5 rounded-xl px-2 py-2 sm:flex-nowrap",
                row.kind === "current" && "bg-blue-50 ring-1 ring-inset ring-blue-200",
              )}
            >
              <EventDot kind={row.kind} />
              <div className="min-w-0 flex-1 pt-0.5">
                <div
                  className={cn(
                    "text-[13px] font-semibold leading-snug",
                    row.kind === "done" ? "text-gray-400" : row.kind === "locked" ? "text-gray-500" : "text-gray-900",
                  )}
                >
                  {row.title}
                </div>
                {row.sub ? (
                  <div className="mt-0.5 text-[11.5px] leading-relaxed text-gray-500">{row.sub}</div>
                ) : null}
              </div>
              {row.checkKey && row.kind === "scheduled" && (
                <button
                  type="button"
                  onClick={() => toggleCheck(row.checkKey!)}
                  className="flex-shrink-0 self-center rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-[12.5px] font-semibold text-gray-700 transition-colors hover:bg-gray-50 max-sm:basis-full"
                >
                  Mark done
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Stage-action bar — Report the result / Sent to collections / escalate /
          undo (verbatim semantics from the retired CaseSummary; mark_sent is
          owned by the SEND IT step above). */}
      {showActionBar && (
        <div className="mt-5 border-t border-gray-100 pt-4">
          <div className="flex flex-wrap items-center gap-2">
            {barActions.map((key, i) => {
              const primary = i === 0;
              if (key === "report_result" && onReportOutcome) {
                return (
                  <button key={key} type="button" onClick={onReportOutcome} className={actionCls(primary)}>
                    {stage === "next" ? "Report a different result" : "Report the result"}
                  </button>
                );
              }
              if (key === "collections" && onCollections) {
                return (
                  <button key={key} type="button" onClick={onCollections} className={actionCls(primary)}>
                    Sent to collections
                  </button>
                );
              }
              if (key === "escalate_next" && onEscalateNext) {
                return (
                  <button key={key} type="button" onClick={onEscalateNext} disabled={escalating} className={actionCls(primary)}>
                    {escalating ? "Creating…" : (nextStepLabel ?? "Take the next step")}
                  </button>
                );
              }
              return null;
            })}
          </div>
          {stage === "next" && nextStepLabel ? (
            // Approved copy (2026-07-18) — signals the CTA creates a NEW letter.
            <p className="mt-2 text-[12px] leading-snug text-gray-500">
              Based on what you reported, this is the usual next step. It creates a new letter and continues this timeline.
            </p>
          ) : null}
          {/* Undo (S266) — a quiet escape hatch for a mis-click (no confirm dialog). */}
          {stage === "awaiting" && onUndoSent ? (
            <button
              type="button"
              onClick={onUndoSent}
              className="mt-3 text-[12px] font-medium text-gray-400 underline-offset-2 hover:text-gray-600 hover:underline"
            >
              Mark as not sent
            </button>
          ) : null}
          {(stage === "next" || stage === "resolved") && onUndoOutcome ? (
            <button
              type="button"
              onClick={onUndoOutcome}
              className="mt-3 block text-[12px] font-medium text-gray-400 underline-offset-2 hover:text-gray-600 hover:underline"
            >
              Undo this result
            </button>
          ) : null}
        </div>
      )}

      {/* Guided Steps v1 (S297) — Pack D regulator doors, the terminal zone
          (external_review / final_notice reached, or resolved loss). */}
      {guidedPackD && (
        <GuidedPackDSection
          suggested={guidedPackD.suggested}
          checks={effChecks}
          notes={effNotes}
          onToggle={toggleCheck}
          onNote={saveNote}
          onDownload={onDownload}
          onReportOutcome={onReportOutcome}
        />
      )}

      {/* Later letters — visible only when viewing an earlier letter. */}
      {laterLetters.map((l) => (
        <div key={l.id} className="mt-3 border-t border-gray-100 pt-3">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[10px] font-bold uppercase tracking-[0.1em] text-gray-400">
              {microLabel(l)}
            </span>
            <a href={l.href} className="flex-shrink-0 text-[12px] font-semibold text-blue-600 hover:underline">
              Go to this letter
            </a>
          </div>
          <div className="mt-0.5 px-0.5 text-[11.5px] leading-relaxed text-gray-500">
            {l.sentDateLabel ? `Sent ${l.sentDateLabel}` : "Drafting"}
            {l.live
              ? l.liveDueLabel
                ? ` · response due ${l.liveDueLabel}`
                : " · response window open"
              : l.statusLine
                ? ` · ${l.statusLine}`
                : ""}
          </div>
        </div>
      ))}
    </section>
  );
}

// ── Choice card (patient-identity radios) ───────────────────────────────────

