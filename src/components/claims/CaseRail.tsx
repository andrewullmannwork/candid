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
import { CASE_RAIL } from "@/lib/guides/pack-registry";
import {
  composeRailSteps,
  railStepDisputeId,
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
  onLogResponse,
  onSomethingElse,
  onUndoResult,
  onStartNextLetter,
  escalating,
}: Omit<ComposeRailInput, "insurerNameByDispute" | "providerName" | "now"> & {
  insurerNameByDispute: Record<string, string>;
  providerName: string | null;
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
  /** Escalate in flight (ClaimDetail state) — disables the offer buttons. */
  escalating: boolean;
}) {
  const router = useRouter();
  const [openSteps, setOpenSteps] = useState<Record<string, boolean>>({});
  const [whnOpen, setWhnOpen] = useState<Record<string, boolean>>({});
  const [doorLogged, setDoorLogged] = useState<Record<string, boolean>>({});
  const [doorBusy, setDoorBusy] = useState<Record<string, boolean>>({});
  const [undoBusy, setUndoBusy] = useState<Record<string, boolean>>({});
  const [undoError, setUndoError] = useState<Record<string, boolean>>({});
  // Pack-D filed attest (phase 1b) — optimistic with snap-back (S295 idiom);
  // server truth arrives with the next projection refetch. Note drafts are
  // controlled (GuidedPhoneSteps idiom) so the attest click can carry the
  // UNION {done, note} in ONE request — clicking the button blurs the input,
  // and two concurrent read-modify-write POSTs lose one field to the other
  // (the S299 "complaint number disappeared" race, Andrew).
  const [filedOverride, setFiledOverride] = useState<Record<string, boolean>>({});
  const [attestNoteDrafts, setAttestNoteDrafts] = useState<Record<string, string>>({});

  const steps: RailStepModel[] = composeRailSteps({
    letters,
    primaryDisputeId,
    firstNumber,
    insurerNameByDispute,
    providerName,
    // Client clock — calendars are the user's timezone (letter-type.ts rule).
    now: new Date(),
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

  // Pack-D filed attest — the EXISTING dispute checklist POST (one state,
  // shared with the dispute-side Pack D until phase 3 retires that mount;
  // writes also emit guide_step_attested ledger events via Phase 0).
  const persistAttest = async (
    disputeId: string,
    body: { done?: boolean; note?: string },
  ): Promise<boolean> => {
    try {
      const token = await getAuthToken();
      if (!token) return false;
      const res = await fetch(`/api/disputes/${disputeId}/checklist`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ key: "packD:filed", ...body }),
      });
      return res.ok;
    } catch {
      return false;
    }
  };
  const toggleFiled = async (disputeId: string, next: boolean, note: string) => {
    setFiledOverride((m) => ({ ...m, [disputeId]: next }));
    // The union write: done + the current note together, so blur-vs-click
    // request ordering converges on both fields either way.
    const ok = await persistAttest(disputeId, { done: next, note });
    if (!ok) setFiledOverride((m) => ({ ...m, [disputeId]: !next }));
  };

  return (
    <>
      {steps.map((s, i) => {
        const last = i === steps.length - 1;
        switch (s.kind) {
          case "wait-active":
            return (
              <RailStep key={s.key} dataLetter={railStepDisputeId(s)} n={s.badge} title={s.title} sub={s.sub ?? undefined} last={last}>
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
                />
              </RailStep>
            );
          case "wait-receipt":
            return (
              <RailStep
                key={s.key}
                dataLetter={railStepDisputeId(s)}
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
                        {CASE_RAIL.quietUndoResult}
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
            const filedNow = filedOverride[s.move.disputeId] ?? s.move.regulator.attest.filed;
            const attestNoteValue =
              attestNoteDrafts[s.move.disputeId] ?? s.move.regulator.attest.note ?? "";
            return (
              <RailStep key={s.key} dataLetter={railStepDisputeId(s)} n={s.badge} title={s.title} sub={s.sub ?? undefined} last={last}>
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
                  <div className="rounded-xl border border-gray-200 bg-white px-4 py-3.5">
                    <div className="text-[14px] font-bold text-gray-900">{s.move.regulator.title}</div>
                    <div className="mb-2.5 mt-0.5 text-[12.5px] text-gray-500">
                      {s.move.regulator.lead}
                    </div>
                    <div className="flex flex-wrap gap-2.5">
                      {s.move.regulator.doors.map((d) => (
                        <a
                          key={d.id}
                          href={d.href}
                          target="_blank"
                          rel="noopener noreferrer"
                          className={
                            "min-w-[190px] flex-1 rounded-[10px] border px-3 py-2.5 text-[13px] transition-colors hover:bg-gray-50 " +
                            (d.chip ? "border-blue-200 bg-blue-50/40" : "border-gray-200 bg-white")
                          }
                        >
                          <span className="flex flex-wrap items-center gap-1.5 font-bold text-gray-900">
                            {d.name}
                            {d.chip && (
                              <span className="inline-flex items-center rounded-full bg-slate-100 px-2 py-[2px] text-[10.5px] font-semibold text-slate-600 ring-1 ring-inset ring-slate-200">
                                {d.chip}
                              </span>
                            )}
                          </span>
                          <span className="mt-0.5 block text-[12px] text-gray-500">{d.desc}</span>
                        </a>
                      ))}
                    </div>
                    <div className="mt-3 border-t border-gray-100 pt-2.5">
                      <div className="text-[13px] font-semibold text-gray-900">
                        {s.move.regulator.attest.title}
                      </div>
                      {/* Log input + attest button — the Pack A′ row anatomy
                          (Andrew, 1b E2E: match "work it by phone" + the
                          "I made the call" button). */}
                      <div className="mt-2 flex flex-wrap items-start gap-x-3 gap-y-2">
                        <input
                          type="text"
                          value={attestNoteValue}
                          placeholder={s.move.regulator.attest.notePlaceholder}
                          maxLength={500}
                          onChange={(e) =>
                            setAttestNoteDrafts((m) => ({
                              ...m,
                              [s.move.disputeId]: e.target.value,
                            }))
                          }
                          onBlur={(e) => {
                            const v = e.target.value.trim();
                            if (v !== (s.move.regulator.attest.note ?? "")) {
                              void persistAttest(s.move.disputeId, { note: v });
                            }
                          }}
                          className="min-w-[220px] flex-1 rounded-lg border border-gray-200 px-3 py-[7px] text-[12.5px] text-gray-800 placeholder:text-gray-400 focus:border-blue-300 focus:outline-none focus:ring-2 focus:ring-blue-100"
                        />
                        <button
                          type="button"
                          onClick={() =>
                            void toggleFiled(s.move.disputeId, !filedNow, attestNoteValue.trim())
                          }
                          className={
                            filedNow
                              ? "inline-flex items-center gap-1.5 rounded-xl border border-emerald-300 bg-emerald-50 px-3.5 py-[7px] text-[12.5px] font-semibold text-emerald-700"
                              : "inline-flex items-center gap-1.5 rounded-xl border-[1.5px] border-blue-400 bg-white px-3.5 py-[6.5px] text-[12.5px] font-semibold text-blue-700 transition-colors hover:bg-blue-50"
                          }
                        >
                          {s.move.regulator.attest.checkboxLabel}
                          {filedNow && (
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                              <path d="M5 13l4 4L19 7" />
                            </svg>
                          )}
                        </button>
                      </div>
                    </div>
                    <div className="mt-2.5 text-[11.5px] text-gray-400">{s.move.regulator.foot}</div>
                  </div>
                </div>
              </RailStep>
            );
          }
          case "send-receipt":
            return (
              <RailStep
                key={s.key}
                dataLetter={railStepDisputeId(s)}
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
              <RailStep key={s.key} dataLetter={railStepDisputeId(s)} n={s.badge} title={s.title} last={last}>
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
