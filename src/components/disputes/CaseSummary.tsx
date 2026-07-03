/**
 * CaseSummary — dispute-letters v2 Zone-2 ("The case", map §6 + §2 ladder + §3.4).
 *
 * Three read-only readouts stacked in one card:
 *   - estimate-HEDGED recovery ("up to $X · you may recover less"),
 *   - an amber DEADLINE COUNTDOWN (the fresh guard — appeal/validation window; caution amber,
 *     NEVER red, per the style fence),
 *   - an escalation TIMELINE (drafted → sent → follow-ups → next step) + the scheduled
 *     FOLLOW-UP PLAN.
 *
 * Render-when-present: every block is gated on its own data, and the deadline fields are null
 * when `dispute_deadline_engine_v1` is OFF — so the whole deadline UI simply doesn't appear.
 * No feature-flag read here; the presence of the data IS the gate.
 */
"use client";

import { computeCaseStage, stageActions } from "@/lib/disputes/case-stage";

interface DeadlineWarning {
  severity: "urgent" | "past";
  deadlineType: string | null;
  daysRemaining: number | null;
  nextStep: string | null;
}
interface Followup {
  dueDate: string;
  kind: string;
}

export interface CaseSummaryProps {
  letterType: string;
  status: string | null;
  isSent: boolean;
  filedDate: string | null;
  /** amount_disputed — the estimate-hedged recovery figure. Suppressed when null/≤0. */
  recoveryAmount: number | null;
  deadlineWarning: DeadlineWarning | null;
  governingDeadlineDate: string | null;
  deadlineType: string | null;
  filingDeadlineDate: string | null;
  followups: Followup[];
  followupPlan: Followup[];
  // Zone-3 (S266) — dynamic stage-action bar. Handlers live on the page (they close
  // over page state); the bar just calls them for the current stage. Omitted handlers
  // hide their action, so a read-only render is still valid.
  onMarkSent?: () => void;
  onReportOutcome?: () => void;
  onCollections?: () => void;
  onEscalateNext?: () => void;
  onUndoSent?: () => void;
  onUndoOutcome?: () => void;
  markingSent?: boolean;
  escalating?: boolean;
  /** suggestNextStep().ctaLabel — its presence means a next rung is available. */
  nextStepLabel?: string | null;
}

const TERMINAL = new Set([
  "won",
  "lost",
  "settled",
  "withdrawn",
  "won_on_escalation",
  "settled_on_escalation",
]);

const money = (n: number): string =>
  `$${n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;

function prettyDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/** deadline_type → a friendly window label for the countdown + rungs. */
function deadlineLabel(t: string | null | undefined): string {
  switch (t) {
    case "erisa_appeal_180":
      return "Appeal window";
    case "plan_response":
      return "Response window";
    case "fdcpa_validation_30":
      return "Validation window";
    default:
      return "Deadline";
  }
}

// ── icons (inline stroke SVG, codebase style) ─────────────────────────────────
const stroke = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};
function ClockIcon({ className }: { className?: string }) {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" {...stroke} className={className} aria-hidden>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}

// ── timeline model ────────────────────────────────────────────────────────────
type RungState = "done" | "current" | "scheduled" | "locked";
interface Rung {
  key: string;
  label: string;
  state: RungState;
  detail?: string;
}

function buildRungs(p: CaseSummaryProps): Rung[] {
  const rungs: Rung[] = [];
  const terminal = TERMINAL.has(p.status ?? "");

  rungs.push({ key: "drafted", label: "Letter drafted", state: "done" });

  if (p.isSent) {
    const when = prettyDate(p.filedDate);
    rungs.push({ key: "sent", label: "Letter sent", state: "done", detail: when ? `Sent ${when}` : undefined });
  } else if (!terminal) {
    rungs.push({
      key: "send",
      label: "Ready to send",
      state: "current",
      detail: "Download it and mark as sent to start the clock.",
    });
  }

  if (terminal) {
    const label =
      p.status === "won" || p.status === "won_on_escalation"
        ? "Resolved — in your favor"
        : p.status === "settled" || p.status === "settled_on_escalation"
          ? "Resolved — settled"
          : p.status === "lost"
            ? "Closed — denied"
            : "Withdrawn";
    rungs.push({ key: "outcome", label, state: "done" });
    return rungs;
  }

  if (p.isSent) {
    if (p.deadlineWarning?.severity === "past") {
      rungs.push({
        key: "past",
        label: "Response window has passed",
        state: "current",
        detail: p.deadlineWarning.nextStep ?? undefined,
      });
    } else {
      const due = prettyDate(p.governingDeadlineDate);
      rungs.push({
        key: "awaiting",
        label: "Awaiting response",
        state: "current",
        detail: due ? `Response due ${due}` : undefined,
      });
    }
    const plan = p.followups.length > 0 ? p.followups : p.followupPlan;
    for (const f of plan) {
      const when = prettyDate(f.dueDate);
      rungs.push({
        key: `fu-${f.dueDate}-${f.kind}`,
        label: f.kind === "deadline_final" ? "Final notice" : "Follow-up",
        state: "scheduled",
        detail: when ? `Scheduled ${when}` : undefined,
      });
    }
  }

  if (p.letterType === "insurance_appeal" && p.deadlineWarning?.severity !== "past") {
    rungs.push({
      key: "external",
      label: "External review",
      state: "locked",
      detail: "Unlocks after a final internal denial.",
    });
  }

  return rungs;
}

// ── timeline rung marker ──────────────────────────────────────────────────────
function RungMarker({ state, last }: { state: RungState; last: boolean }) {
  const dot =
    state === "done" ? (
      <span className="grid h-5 w-5 place-items-center rounded-full bg-emerald-50">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#059669" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M5 13l4 4L19 7" /></svg>
      </span>
    ) : state === "current" ? (
      <span className="grid h-5 w-5 place-items-center rounded-full bg-blue-50">
        <svg width="9" height="9" viewBox="0 0 24 24" fill="#2563eb" aria-hidden><path d="M8 5v14l11-7z" /></svg>
      </span>
    ) : state === "scheduled" ? (
      <span className="grid h-5 w-5 place-items-center rounded-full border border-amber-200 bg-amber-50">
        <ClockIcon className="text-amber-600" />
      </span>
    ) : (
      <span className="grid h-5 w-5 place-items-center rounded-full border border-dashed border-gray-300">
        <svg width="10" height="10" viewBox="0 0 24 24" {...stroke} className="text-gray-400" aria-hidden><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 018 0v3" /></svg>
      </span>
    );
  return (
    <div className="flex flex-col items-center">
      {dot}
      {!last ? <div className="mt-1 w-px flex-1 bg-gray-200" style={{ minHeight: 18 }} /> : null}
    </div>
  );
}

export function CaseSummary(props: CaseSummaryProps) {
  const { recoveryAmount, deadlineWarning, filingDeadlineDate, governingDeadlineDate } = props;
  const rungs = buildRungs(props);
  const showRecovery = recoveryAmount != null && recoveryAmount > 0;
  const dw = deadlineWarning;
  const countdownDate = prettyDate(filingDeadlineDate ?? governingDeadlineDate);
  const stage = computeCaseStage({
    status: props.status,
    isSent: props.isSent,
    hasNextStep: !!props.nextStepLabel,
  });
  const actions = stageActions(stage);
  // Render the bar for actionable stages, OR for resolved so an "Undo this result"
  // escape hatch is available after a mis-reported outcome.
  const showActionBar = actions.length > 0 || (stage === "resolved" && !!props.onUndoOutcome);
  const actionCls = (primary: boolean) =>
    primary
      ? "inline-flex items-center rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-blue-700 disabled:opacity-60"
      : "inline-flex items-center rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-700 shadow-sm transition-colors hover:bg-gray-50 disabled:opacity-60";

  return (
    <section className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm md:p-6">
      <h3 className="text-[15px] font-semibold text-gray-900">The case</h3>

      {(showRecovery || dw) && (
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {showRecovery ? (
            <div className="rounded-xl bg-gray-50 p-4">
              <div className="text-[13px] text-gray-500">Estimated recovery</div>
              <div className="mt-0.5 text-2xl font-medium text-gray-900">up to {money(recoveryAmount)}</div>
              <div className="mt-0.5 text-[12px] text-gray-400">estimate — you may recover less</div>
            </div>
          ) : null}

          {dw ? (
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
              <div className="flex items-center gap-1.5 text-[13px] font-medium text-amber-700">
                <ClockIcon />
                {deadlineLabel(dw.deadlineType)}
              </div>
              {dw.severity === "past" ? (
                <>
                  <div className="mt-0.5 text-lg font-semibold text-amber-800">Window has passed</div>
                  {dw.nextStep ? <div className="mt-1 text-[12px] leading-snug text-amber-700">{dw.nextStep}</div> : null}
                </>
              ) : (
                <>
                  <div className="mt-0.5 text-2xl font-medium text-amber-800">
                    {dw.daysRemaining ?? 0} {dw.daysRemaining === 1 ? "day" : "days"} left
                  </div>
                  {countdownDate ? <div className="mt-0.5 text-[12px] text-amber-700">file before {countdownDate}</div> : null}
                </>
              )}
            </div>
          ) : null}
        </div>
      )}

      <div className="mt-5">
        <div className="mb-3 text-[13px] font-semibold text-gray-700">Case timeline</div>
        <ol className="space-y-0">
          {rungs.map((r, i) => (
            <li key={r.key} className="flex gap-3">
              <RungMarker state={r.state} last={i === rungs.length - 1} />
              <div className={`pb-3 ${i === rungs.length - 1 ? "" : ""}`}>
                <div className={`text-sm ${r.state === "locked" ? "text-gray-500" : "text-gray-900"}`}>{r.label}</div>
                {r.detail ? <div className="mt-0.5 text-[12px] leading-snug text-gray-500">{r.detail}</div> : null}
              </div>
            </li>
          ))}
        </ol>
      </div>

      {/* Zone-3 (S266) — dynamic stage-action bar: the ladder's current action(s).
          draft → Mark as sent · awaiting → Report the result / Sent to collections ·
          next → escalate CTA / Report a different result. Consolidates what used to be
          scattered across the toolbar + a separate "Heard back?" box. */}
      {showActionBar ? (
        <div className="mt-6 border-t border-gray-100 pt-5">
          {stage === "draft" && dw?.severity === "past" ? (
            <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-[12px] leading-snug text-amber-800">
              <span className="font-medium">This filing window has passed.</span>
              {dw.nextStep ? <span className="ml-1 text-amber-700">{dw.nextStep}</span> : null}
            </div>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            {actions.map((key, i) => {
              const primary = i === 0;
              if (key === "mark_sent" && props.onMarkSent) {
                return (
                  <button key={key} type="button" onClick={props.onMarkSent} disabled={props.markingSent} className={actionCls(primary)}>
                    {props.markingSent ? "Marking…" : "Mark as sent"}
                  </button>
                );
              }
              if (key === "report_result" && props.onReportOutcome) {
                return (
                  <button key={key} type="button" onClick={props.onReportOutcome} className={actionCls(primary)}>
                    {stage === "next" ? "Report a different result" : "Report the result"}
                  </button>
                );
              }
              if (key === "collections" && props.onCollections) {
                return (
                  <button key={key} type="button" onClick={props.onCollections} className={actionCls(primary)}>
                    Sent to collections
                  </button>
                );
              }
              if (key === "escalate_next" && props.onEscalateNext) {
                return (
                  <button key={key} type="button" onClick={props.onEscalateNext} disabled={props.escalating} className={actionCls(primary)}>
                    {props.escalating ? "Creating…" : (props.nextStepLabel ?? "Take the next step")}
                  </button>
                );
              }
              return null;
            })}
          </div>
          {stage === "next" && props.nextStepLabel ? (
            <p className="mt-2 text-[12px] leading-snug text-gray-500">
              Based on what you reported, this is the usual next step.
            </p>
          ) : null}
          {/* Undo (S266) — a quiet escape hatch for a mis-click (no confirm dialog). */}
          {stage === "awaiting" && props.onUndoSent ? (
            <button
              type="button"
              onClick={props.onUndoSent}
              className="mt-3 text-[12px] font-medium text-gray-400 underline-offset-2 hover:text-gray-600 hover:underline"
            >
              Mark as not sent
            </button>
          ) : null}
          {(stage === "next" || stage === "resolved") && props.onUndoOutcome ? (
            <button
              type="button"
              onClick={props.onUndoOutcome}
              className="mt-3 block text-[12px] font-medium text-gray-400 underline-offset-2 hover:text-gray-600 hover:underline"
            >
              Undo this result
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
