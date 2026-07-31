"use client";

/**
 * Guided Steps v1 (S297) — Pack A′ "Work it by phone first".
 *
 * The step-4 phone subflow on /claim bill detail: collapsed by default,
 * optional, track-aware (insurer-directed bills lead with the insurer call),
 * scripts autofilled from the SAME already-fetched payload the page renders
 * (one-derivation invariant — no fetches here; ClaimDetail assembles the
 * GuideFillContext projection).
 *
 * Persistence: POST /api/claims/[claimId]/checklist — claim-scoped because
 * this is the BILL's call log (shared by every letter on the bill). Optimistic
 * paint with snap-back on failure (S295 latency idiom); the STORED timestamp
 * is always the server's (§3.9).
 *
 * Copy comes from the registry VERBATIM (Andrew-approved) — do not edit
 * strings here; string changes go through the registry + Andrew.
 */

import { useState } from "react";
import {
  GUIDE_CHROME,
  PHONE_OUTCOME,
  PREP_CHIPS,
  PHONE_LINES,
  countCheckboxSteps,
  packAStepsForTrack,
  type GuideFillContext,
  type GuideStep,
  type ScriptSegment,
} from "@/lib/guides/pack-registry";

export type GuideStepState = { checkedAt: string | null; note?: string };

/**
 * "Show full step" / "Hide full step" — the S297 expand affordance, shared by
 * this subflow's header and the done-collapsed rail steps in ClaimDetail.
 * Styled to match the step-2 header's neutral buttons.
 */
export function ShowFullStepButton({
  open,
  onToggle,
}: {
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      className="inline-flex items-center gap-1.5 rounded-xl border border-gray-200 bg-white px-4 py-[9px] text-[13px] font-semibold text-gray-700 transition-colors hover:bg-gray-50"
    >
      {open ? GUIDE_CHROME.collapseLabel : GUIDE_CHROME.expandLabel}
      <svg
        width="13"
        height="13"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        {open ? <path d="M5 15l7-7 7 7" /> : <path d="M19 9l-7 7-7-7" />}
      </svg>
    </button>
  );
}

/** "Jul 30, 2:14 pm" — local time; only ever fed SERVER-issued timestamps. */
function fmtStamp(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const d = new Date(t);
  const day = d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const time = d
    .toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
    .toLowerCase()
    .replace(/\s/g, " ");
  return `${day}, ${time}`;
}

export function Segments({ segments }: { segments: ScriptSegment[] }) {
  return (
    <>
      {segments.map((s, i) =>
        s.fill ? (
          <mark key={i} className="rounded bg-blue-100 px-1 py-0.5 font-semibold text-blue-900">
            {s.text}
          </mark>
        ) : (
          <span key={i}>{s.text}</span>
        ),
      )}
    </>
  );
}

function resolveCopy(
  copy: GuideStep["copy"],
  ctx: GuideFillContext,
): ScriptSegment[] | null {
  if (typeof copy === "string") return [{ text: copy }];
  return copy(ctx);
}

export function GuidedPhoneSteps({
  claimId,
  ctx,
  initialSteps,
  getAuthToken,
  onItemizedRequest,
  onNotResolved,
}: {
  claimId: string;
  ctx: GuideFillContext;
  /** claims.metadata.guideSteps as returned by the claim GET. */
  initialSteps: Record<string, GuideStepState>;
  getAuthToken: () => Promise<string | null>;
  /** Provider-track step-1 CTA — the EXISTING itemized-request flow, wired by
   *  the parent (legacy generate path; see RequestItemizedBill precedent). */
  onItemizedRequest?: () => Promise<void>;
  /** "Not yet" on the phone-outcome question — the parent pulses the letter
   *  CTA below so the eye lands on the next action (no auto-scroll). */
  onNotResolved?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [local, setLocal] = useState<Record<string, GuideStepState>>({});
  const [noteDrafts, setNoteDrafts] = useState<Record<string, string>>({});
  const [ctaBusy, setCtaBusy] = useState(false);

  const steps = packAStepsForTrack(ctx.track);
  const eff: Record<string, GuideStepState> = { ...initialSteps, ...local };

  const checkboxTotal = countCheckboxSteps(steps);
  const checkboxDone = steps.filter(
    (s) => s.control === "checkbox" && eff[s.id]?.checkedAt != null,
  ).length;
  const currentStepId =
    steps.find((s) => s.control === "checkbox" && eff[s.id]?.checkedAt == null)?.id ?? null;

  // Phone-outcome question (S297, Andrew) — replaces the passive hand-off row
  // once ≥1 call is attested. The answer rides in the note ("yes"/"no").
  const anyCallMade = checkboxDone > 0;
  const outcomeNote = eff[PHONE_OUTCOME.id]?.note;
  const outcomeAnswer = outcomeNote === "yes" ? "yes" : outcomeNote === "no" ? "no" : null;

  const persist = async (stepId: string, patch: { checked?: boolean; note?: string }) => {
    const prev = eff[stepId] ?? { checkedAt: null };
    // Optimistic paint in the click's own render; the provisional client time
    // is display-only — the server's stamp is adopted on success, and the row
    // snaps back on failure (S295 idiom).
    setLocal((s) => ({
      ...s,
      [stepId]: {
        ...prev,
        ...(patch.checked != null
          ? { checkedAt: patch.checked ? new Date().toISOString() : null }
          : {}),
        ...(patch.note != null ? { note: patch.note } : {}),
      },
    }));
    try {
      const token = await getAuthToken();
      if (!token) throw new Error("no-auth");
      const res = await fetch(`/api/claims/${claimId}/checklist`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ stepId, ...patch }),
      });
      if (!res.ok) throw new Error(String(res.status));
      const d = (await res.json()) as { guideSteps?: Record<string, GuideStepState> };
      const serverRow = d.guideSteps?.[stepId];
      if (serverRow) setLocal((s) => ({ ...s, [stepId]: serverRow }));
    } catch {
      setLocal((s) => ({ ...s, [stepId]: prev }));
      setNoteDrafts((n) => {
        const next = { ...n };
        delete next[stepId];
        return next;
      });
    }
  };

  // Prep row — presence-derived from the context, never fetched (§5.2).
  // S297 simplification (Andrew): on-file values stay green chips; everything
  // absent folds into ONE quiet "Have ready" text line instead of dashed chips.
  const onFileChips: string[] = [];
  if (ctx.memberIdOnFile) onFileChips.push(PREP_CHIPS.memberIdOnFile);
  if (ctx.planNameOnFile) onFileChips.push(PREP_CHIPS.planNameOnFile);
  if (ctx.claimNumber != null) onFileChips.push(PREP_CHIPS.claimNumberOnFile);
  const haveReadyParts: string[] = [];
  if (!ctx.memberIdOnFile) haveReadyParts.push("member ID (insurance card)");
  if (ctx.claimNumber == null) haveReadyParts.push("claim # (EOB)");
  const insurerPhoneMissing = ctx.track === "insurer" && ctx.memberServicesPhone == null;
  const billingPhoneMissing = ctx.providerPhone == null;
  if (insurerPhoneMissing && billingPhoneMissing) haveReadyParts.push("phone numbers (card + bill)");
  else if (insurerPhoneMissing) haveReadyParts.push("insurer phone (card)");
  else if (billingPhoneMissing) haveReadyParts.push("billing office phone (bill)");

  // Which step gets the on-file phone line under its title.
  const phoneLineFor = (step: GuideStep): ScriptSegment[] | null => {
    if (step.id === "packA:ins-call-insurer" && ctx.memberServicesPhone != null)
      return PHONE_LINES.memberServices(ctx.memberServicesPhone);
    const billingSteps = new Set([
      "packA:ins-ask-hold",
      "packA:prov-itemized",
      "packA:prov-call-flagged",
    ]);
    if (billingSteps.has(step.id) && ctx.providerPhone != null)
      return PHONE_LINES.billingOffice(ctx.providerPhone);
    return null;
  };

  return (
    <div className="mb-4 rounded-[14px] border border-gray-200 bg-white">
      {/* Collapsed header row — whole row toggles; the button is the visible affordance. */}
      <div
        role="button"
        tabIndex={0}
        onClick={() => setExpanded((e) => !e)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setExpanded((x) => !x);
          }
        }}
        className="flex cursor-pointer flex-wrap items-center gap-2.5 px-4 py-3"
      >
        <svg
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
          className={checkboxDone === checkboxTotal && checkboxTotal > 0 ? "text-emerald-600" : "text-blue-600"}
        >
          <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" />
        </svg>
        <span className="text-[14px] font-bold text-gray-900">{GUIDE_CHROME.packATitle}</span>
        {checkboxDone > 0 ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2.5 py-0.5 text-[11.5px] font-semibold text-emerald-700 ring-1 ring-inset ring-emerald-200">
            {checkboxDone === checkboxTotal && (
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M5 13l4 4L19 7" />
              </svg>
            )}
            {GUIDE_CHROME.doneMeta(checkboxDone, checkboxTotal)}
          </span>
        ) : (
          <span className="text-[12px] text-gray-500">{GUIDE_CHROME.packAMeta}</span>
        )}
        <div className="ml-auto">
          <ShowFullStepButton open={expanded} onToggle={() => setExpanded((e) => !e)} />
        </div>
      </div>

      {expanded && (
        <div className="border-t border-gray-100 px-4 pb-4 pt-3">
          {/* Have-ready prep row — green chips for on-file, one quiet line for the rest */}
          <div className="mb-3.5 flex flex-wrap items-center gap-x-2 gap-y-1.5 text-[12px] text-gray-500">
            {onFileChips.map((c) => (
              <span
                key={c}
                className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2.5 py-0.5 text-[11.5px] font-medium text-emerald-700 ring-1 ring-inset ring-emerald-200"
              >
                <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M5 13l4 4L19 7" />
                </svg>
                {c}
              </span>
            ))}
            {haveReadyParts.length > 0 && (
              <span>
                {GUIDE_CHROME.haveReady} {haveReadyParts.join(" · ")}
              </span>
            )}
          </div>

          <div className="flex flex-col gap-4">
            {steps.map((step) => {
              const state = eff[step.id];
              const checked = state?.checkedAt != null;
              const isCurrent = step.id === currentStepId;
              const copySegs = resolveCopy(step.copy, ctx);
              const scriptSegs = step.script ? step.script(ctx) : null;
              const phoneLine = phoneLineFor(step);
              const noteValue = noteDrafts[step.id] ?? state?.note ?? "";

              return (
                <div key={step.id} className="flex gap-2.5">
                  {/* 22px leading dot — blue current · hollow untouched · green
                      done (Andrew: keep the blue/white distinction; clicking
                      the attest button advances the blue marker). */}
                  <span
                    className={
                      "mt-0.5 grid h-[22px] w-[22px] flex-shrink-0 place-items-center rounded-full " +
                      (checked
                        ? "bg-emerald-600 text-white"
                        : isCurrent
                          ? "bg-blue-600 text-white"
                          : step.control === "info"
                            ? "text-gray-400"
                            : "border-[1.5px] border-gray-300 text-transparent")
                    }
                    aria-hidden
                  >
                    {checked ? (
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round">
                        <path d="M5 13l4 4L19 7" />
                      </svg>
                    ) : step.control === "info" ? (
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
                        <path d="M12 5v14m0 0l-5-5m5 5l5-5" />
                      </svg>
                    ) : isCurrent ? (
                      <svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                        <path d="M8 5v14l11-7z" />
                      </svg>
                    ) : null}
                  </span>

                  <div className="min-w-0 flex-1">
                    {/* S297 simplification — info/hand-off rows carry their
                        full approved sentence in `copy`; a title would repeat
                        it (the "No fix on the phone?" duplication). */}
                    {step.control !== "info" && (
                      <div className="text-[13.5px] font-bold text-gray-900">{step.title}</div>
                    )}
                    {phoneLine && (
                      <div className="mt-0.5 text-[12px] text-gray-600">
                        <Segments segments={phoneLine} />
                      </div>
                    )}
                    {step.control === "info" && anyCallMade ? (
                      /* Phone-outcome question (S297, Andrew) — the hand-off row
                         becomes a real decision point once a call is attested.
                         Both answers persist; "Not yet" re-surfaces the approved
                         hand-off copy and pulses the letter CTA below. */
                      <div>
                        <div className="text-[13.5px] font-bold text-gray-900">
                          {PHONE_OUTCOME.question}
                        </div>
                        <div className="mt-1.5 flex flex-wrap items-center gap-2">
                          <button
                            type="button"
                            onClick={() => void persist(PHONE_OUTCOME.id, { checked: true, note: "yes" })}
                            className={
                              outcomeAnswer === "yes"
                                ? "inline-flex items-center gap-1.5 rounded-xl border border-emerald-300 bg-emerald-50 px-3.5 py-[7px] text-[12.5px] font-semibold text-emerald-700"
                                : "inline-flex items-center rounded-xl border border-gray-200 bg-white px-3.5 py-[7px] text-[12.5px] font-semibold text-gray-700 transition-colors hover:bg-gray-50"
                            }
                          >
                            {PHONE_OUTCOME.yesLabel}
                            {outcomeAnswer === "yes" && (
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                                <path d="M5 13l4 4L19 7" />
                              </svg>
                            )}
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              void persist(PHONE_OUTCOME.id, { checked: true, note: "no" });
                              onNotResolved?.();
                            }}
                            className={
                              outcomeAnswer === "no"
                                ? "inline-flex items-center rounded-xl border border-blue-300 bg-blue-50 px-3.5 py-[7px] text-[12.5px] font-semibold text-blue-700"
                                : "inline-flex items-center rounded-xl border border-gray-200 bg-white px-3.5 py-[7px] text-[12.5px] font-semibold text-gray-700 transition-colors hover:bg-gray-50"
                            }
                          >
                            {PHONE_OUTCOME.noLabel}
                          </button>
                        </div>
                        {outcomeAnswer === "yes" && (
                          <p className="mt-1.5 text-[12.5px] leading-[1.55] text-gray-600">
                            {ctx.track === "insurer"
                              ? PHONE_OUTCOME.yesLineInsurer
                              : PHONE_OUTCOME.yesLineProvider}
                          </p>
                        )}
                        {outcomeAnswer === "no" && copySegs && (
                          <div className="mt-1.5 text-[12.5px] leading-[1.55] text-gray-500">
                            <Segments segments={copySegs} />
                          </div>
                        )}
                      </div>
                    ) : (
                      copySegs && (
                        <div className="mt-0.5 text-[12.5px] leading-[1.55] text-gray-500">
                          <Segments segments={copySegs} />
                        </div>
                      )
                    )}

                    {scriptSegs && (
                      <details className="mt-2" open={isCurrent}>
                        <summary className="cursor-pointer text-[12px] font-semibold text-blue-700 hover:underline">
                          Show the script
                        </summary>
                        <blockquote className="mt-1.5 rounded-r-lg border-l-2 border-blue-300 bg-blue-50/40 px-3 py-2 font-serif text-[13px] leading-[1.6] text-gray-800">
                          &ldquo;
                          <Segments segments={scriptSegs} />
                          &rdquo;
                        </blockquote>
                        {step.underScript && (
                          <div className="mt-1 text-[11px] text-gray-400">{step.underScript}</div>
                        )}
                      </details>
                    )}

                    {step.cta?.kind === "itemized_request" && onItemizedRequest && (
                      <button
                        type="button"
                        disabled={ctaBusy}
                        onClick={() => {
                          setCtaBusy(true);
                          void onItemizedRequest().finally(() => setCtaBusy(false));
                        }}
                        className="mt-2 inline-flex items-center gap-1.5 rounded-xl border border-gray-200 bg-white px-3.5 py-[7px] text-[12.5px] font-semibold text-gray-700 transition-colors hover:bg-gray-50 disabled:opacity-60"
                      >
                        {step.cta.label}
                      </button>
                    )}

                    {/* S297 simplification — log input + checkbox share one row. */}
                    {(step.note || (step.control === "checkbox" && step.checkboxLabel)) && (
                      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2">
                        {step.note && (
                          <input
                            type="text"
                            value={noteValue}
                            placeholder={step.note.placeholder}
                            maxLength={500}
                            onChange={(e) =>
                              setNoteDrafts((n) => ({ ...n, [step.id]: e.target.value }))
                            }
                            onBlur={() => {
                              const draft = noteDrafts[step.id];
                              if (draft != null && draft !== (state?.note ?? "")) {
                                void persist(step.id, { note: draft });
                              }
                            }}
                            className="min-w-[220px] flex-1 rounded-lg border border-gray-200 px-3 py-[7px] text-[12.5px] text-gray-800 placeholder:text-gray-400 focus:border-blue-300 focus:outline-none focus:ring-2 focus:ring-blue-100"
                          />
                        )}
                        {step.control === "checkbox" && step.checkboxLabel && (
                          <span className="flex flex-col gap-0.5">
                            {/* S297 (Andrew) — attestation is a BUTTON: click
                                advances the blue current marker to the next
                                step; click again un-attests. Blue when it's
                                the current step's action. */}
                            <button
                              type="button"
                              onClick={() => void persist(step.id, { checked: !checked })}
                              className={
                                checked
                                  ? "inline-flex items-center gap-1.5 rounded-xl border border-emerald-300 bg-emerald-50 px-3.5 py-[7px] text-[12.5px] font-semibold text-emerald-700"
                                  : isCurrent
                                    ? "inline-flex items-center gap-1.5 rounded-xl bg-blue-600 px-3.5 py-[7px] text-[12.5px] font-semibold text-white transition-colors hover:bg-blue-700"
                                    : "inline-flex items-center gap-1.5 rounded-xl border border-gray-200 bg-white px-3.5 py-[7px] text-[12.5px] font-semibold text-gray-700 transition-colors hover:bg-gray-50"
                              }
                            >
                              {step.checkboxLabel}
                              {checked && (
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                                  <path d="M5 13l4 4L19 7" />
                                </svg>
                              )}
                            </button>
                            <span className="text-[10.5px] text-gray-400">
                              {state?.checkedAt != null
                                ? `saves with a timestamp — ${fmtStamp(state.checkedAt)}`
                                : "saves with a timestamp"}
                            </span>
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
