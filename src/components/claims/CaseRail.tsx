"use client";

/**
 * CaseRail — the extended claim rail's live phase (S299, timeline unification
 * phase 1a; approved mock: plans/mocks/s298-extended-rail-mock.html Panels A+B).
 *
 * Mounted by ClaimDetail below the prep steps (1–4b) when `case_rail_v1` is ON
 * and the projection extends the rail. Renders EXCLUSIVELY from rail-steps
 * models (which compose EXCLUSIVELY from the projector — agenda §1 one
 * derivation): per-letter waiting cards (chips + countdown + "What happens
 * next"), concurrent waits in chronological order, collapsed receipts for
 * sent/answered steps.
 *
 * Phase-1a action contract (Andrew-approved): the rail RENDERS + NAVIGATES —
 * "Log their response", "Something else happened", "Undo this result", and
 * "Open this letter" all route to the letter's dispute page, where those
 * actions live today (BillCard precedent; on-rail unification is phase 2,
 * ruling 7). The ONE write is the "Collection resumed anyway" door →
 * POST /api/claims/[claimId]/case-events (capture-only case event, ruling 6).
 *
 * RailStep lives HERE (moved verbatim from ClaimDetail at S299) so the rail
 * chrome is importable without a module cycle — ClaimDetail imports CaseRail
 * to mount it, exactly like it already imports ShowFullStepButton from
 * GuidedPhoneSteps (chrome exported from the feature module that owns it).
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ShowFullStepButton } from "@/components/claims/GuidedPhoneSteps";
import { CASE_RAIL } from "@/lib/guides/pack-registry";
import {
  composeRailSteps,
  type ComposeRailInput,
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
  right,
  last,
  headerOnly,
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
  right?: React.ReactNode;
  last?: boolean;
  headerOnly?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <section className={!last && !headerOnly ? "relative pb-[30px]" : "relative"}>
      {!last && !headerOnly && (
        <span
          className="absolute bottom-1 left-[14px] top-[34px] hidden w-[1.5px] bg-gray-200 sm:block"
          aria-hidden
        />
      )}
      <header className="mb-3.5 flex flex-wrap items-start gap-3.5">
        <span
          className={
            "relative z-10 grid h-[30px] w-[30px] flex-shrink-0 place-items-center rounded-full text-sm font-bold text-white " +
            (done
              ? "bg-emerald-700 shadow-[0_2px_8px_rgba(4,120,87,0.25)]"
              : attention
                ? "bg-amber-500 shadow-[0_2px_8px_rgba(245,158,11,0.28)]"
                : "bg-blue-600 shadow-[0_2px_8px_rgba(37,99,235,0.25)]")
          }
        >
          {done ? "\u2713" : n}
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
}: {
  card: RailWaitCard;
  whnOpen: boolean;
  onWhnToggle: (open: boolean) => void;
  onLogResponse: () => void;
  onDoor: () => void;
  doorLogged: boolean;
  doorBusy: boolean;
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
      {card.countdownPct != null && (
        <div className="mb-1 mt-2.5 h-1 overflow-hidden rounded-full bg-slate-100">
          <i
            className="block h-full rounded-full bg-amber-500"
            style={{ width: `${card.countdownPct}%` }}
            aria-hidden
          />
        </div>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-3">
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

export function CaseRail({
  letters,
  insurerNameByDispute,
  providerName,
  primaryDisputeId,
  firstNumber,
  claimId,
  getAuthToken,
}: Omit<ComposeRailInput, "insurerNameByDispute" | "providerName"> & {
  insurerNameByDispute: Record<string, string>;
  providerName: string | null;
  claimId: string;
  getAuthToken: () => Promise<string | null>;
}) {
  const router = useRouter();
  const [openSteps, setOpenSteps] = useState<Record<string, boolean>>({});
  const [whnOpen, setWhnOpen] = useState<Record<string, boolean>>({});
  const [doorLogged, setDoorLogged] = useState<Record<string, boolean>>({});
  const [doorBusy, setDoorBusy] = useState<Record<string, boolean>>({});

  const steps: RailStepModel[] = composeRailSteps({
    letters,
    primaryDisputeId,
    firstNumber,
    insurerNameByDispute,
    providerName,
  });
  if (steps.length === 0) return null;

  const goToLetter = (disputeId: string) => router.push(`/disputes?dispute=${disputeId}`);

  // The rail's ONE write (ruling 6, capture-only): a case event on the record.
  // Fail-quiet UX: on a non-OK response the button simply re-enables — the
  // ledger is history, not state, and the user can retry.
  const logCollectionResumed = async (disputeId: string) => {
    if (doorBusy[disputeId] || doorLogged[disputeId]) return;
    setDoorBusy((m) => ({ ...m, [disputeId]: true }));
    try {
      const token = await getAuthToken();
      if (!token) return;
      const res = await fetch(`/api/claims/${claimId}/case-events`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ kind: "collection_resumed_reported", disputeId }),
      });
      if (res.ok) setDoorLogged((m) => ({ ...m, [disputeId]: true }));
    } catch {
      // fail-quiet — the door stays available
    } finally {
      setDoorBusy((m) => ({ ...m, [disputeId]: false }));
    }
  };

  return (
    <>
      {steps.map((s, i) => {
        const last = i === steps.length - 1;
        switch (s.kind) {
          case "wait-active":
            return (
              <RailStep key={s.key} n={s.badge} title={s.title} sub={s.sub ?? undefined} last={last}>
                <WaitCardBody
                  card={s.card}
                  whnOpen={whnOpen[s.key] ?? s.card.whn?.defaultOpen ?? false}
                  onWhnToggle={(open) => setWhnOpen((m) => ({ ...m, [s.key]: open }))}
                  onLogResponse={() => goToLetter(s.card.disputeId)}
                  onDoor={() =>
                    s.card.door.kind === "collection_resumed"
                      ? logCollectionResumed(s.card.disputeId)
                      : goToLetter(s.card.disputeId)
                  }
                  doorLogged={doorLogged[s.card.disputeId] ?? false}
                  doorBusy={doorBusy[s.card.disputeId] ?? false}
                />
              </RailStep>
            );
          case "wait-receipt":
            return (
              <RailStep
                key={s.key}
                n={s.badge}
                done
                title={s.title}
                sub={s.receipt ? <span className={receiptClass}>{s.receipt}</span> : undefined}
                right={
                  s.undo ? (
                    <button
                      type="button"
                      onClick={() => goToLetter(s.disputeId)}
                      className="border-none bg-transparent p-0 text-[12px] text-gray-400 underline underline-offset-2 transition-colors hover:text-gray-600"
                    >
                      {CASE_RAIL.quietUndoResult}
                    </button>
                  ) : undefined
                }
                last={last}
              />
            );
          case "send-receipt":
            return (
              <RailStep
                key={s.key}
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
                    <button
                      type="button"
                      onClick={() => goToLetter(s.disputeId)}
                      className="inline-flex items-center rounded-lg border border-gray-200 bg-white px-4 py-2 text-[13.5px] font-semibold text-gray-700 transition-colors hover:bg-gray-50"
                    >
                      {s.openLetterLabel}
                    </button>
                  </div>
                )}
              </RailStep>
            );
          case "send-draft":
            return (
              <RailStep key={s.key} n={s.badge} title={s.title} last={last}>
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
        }
      })}
    </>
  );
}
