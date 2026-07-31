"use client";

/**
 * Guided Steps v1 (S297) — Pack A′ "Work it by phone first".
 *
 * Since the 4a/4b split (Andrew): this component is the BODY of rail step 4a —
 * ClaimDetail owns the rail chrome (badge, title, meta, Show/Hide full step,
 * resolved/skipped chips) and mirrors this component's live pack state via
 * onStateChange. The hand-off info rows are superseded by step 4b, so they are
 * filtered out here; the bottom zone is either the "Skip this step" escape
 * hatch (no calls yet) or the "Did the calls fix it?" question (≥1 call).
 *
 * Scripts autofill from the SAME already-fetched payload the page renders
 * (one-derivation invariant — no fetches here; ClaimDetail assembles the
 * GuideFillContext projection). Persistence: POST /api/claims/[claimId]/
 * checklist — claim-scoped (the BILL's call log, shared by every letter).
 * Optimistic paint with snap-back (S295 idiom); the STORED timestamp is
 * always the server's (§3.9). Copy comes from the registry VERBATIM.
 */

import { useState } from "react";
import {
  GUIDE_CHROME,
  PHONE_OUTCOME,
  PREP_CHIPS,
  PHONE_LINES,
  packAStepsForTrack,
  type GuideFillContext,
  type GuideStep,
  type ScriptSegment,
} from "@/lib/guides/pack-registry";

export type GuideStepState = { checkedAt: string | null; note?: string };

/** 4a's rail-chrome state, derived from the persisted/live step map. */
export interface PhonePackState {
  done: number;
  total: number;
  outcome: "yes" | "no" | "skip" | null;
  outcomeAt: string | null;
  concluded: boolean;
}

export function derivePhonePackState(
  track: "insurer" | "provider",
  stepsState: Record<string, GuideStepState>,
): PhonePackState {
  const checkboxSteps = packAStepsForTrack(track).filter((s) => s.control === "checkbox");
  const total = checkboxSteps.length;
  const done = checkboxSteps.filter((s) => stepsState[s.id]?.checkedAt != null).length;
  const o = stepsState[PHONE_OUTCOME.id];
  const outcome =
    o?.note === "yes" || o?.note === "no" || o?.note === "skip" ? o.note : null;
  return {
    done,
    total,
    outcome,
    outcomeAt: o?.checkedAt ?? null,
    concluded: outcome != null,
  };
}

/**
 * "Show full step" / "Hide full step" — the S297 expand affordance, shared by
 * the done-collapsed rail steps in ClaimDetail and the spine packs. Styled to
 * match the step-2 header's neutral buttons.
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
  onStateChange,
}: {
  claimId: string;
  ctx: GuideFillContext;
  /** claims.metadata.guideSteps as returned by the claim GET. */
  initialSteps: Record<string, GuideStepState>;
  getAuthToken: () => Promise<string | null>;
  /** Provider-track step-1 CTA — the EXISTING itemized-request flow, wired by
   *  the parent (legacy generate path; see RequestItemizedBill precedent). */
  onItemizedRequest?: () => Promise<void>;
  /** Emits the derived pack state after every persist (optimistic, server
   *  adopt, snap-back) so the parent's rail chrome tracks live. */
  onStateChange?: (state: PhonePackState) => void;
}) {
  const [local, setLocal] = useState<Record<string, GuideStepState>>({});
  const [noteDrafts, setNoteDrafts] = useState<Record<string, string>>({});
  const [ctaBusy, setCtaBusy] = useState(false);

  // Hand-off info rows are superseded by rail step 4b (their approved copy
  // lives on as 4b's sub line) — the pack renders only actionable steps.
  const steps = packAStepsForTrack(ctx.track).filter((s) => s.control !== "info");
  const eff: Record<string, GuideStepState> = { ...initialSteps, ...local };

  const checkboxDone = steps.filter(
    (s) => s.control === "checkbox" && eff[s.id]?.checkedAt != null,
  ).length;
  const currentStepId =
    steps.find((s) => s.control === "checkbox" && eff[s.id]?.checkedAt == null)?.id ?? null;

  const anyCallMade = checkboxDone > 0;
  const outcomeNote = eff[PHONE_OUTCOME.id]?.note;
  const outcomeAnswer =
    outcomeNote === "yes" ? "yes" : outcomeNote === "no" ? "no" : outcomeNote === "skip" ? "skip" : null;

  const emit = (map: Record<string, GuideStepState>) =>
    onStateChange?.(derivePhonePackState(ctx.track, map));

  const persist = async (stepId: string, patch: { checked?: boolean; note?: string }) => {
    const prev = eff[stepId] ?? { checkedAt: null };
    // Optimistic paint in the click's own render; the provisional client time
    // is display-only — the server's stamp is adopted on success, and the row
    // snaps back on failure (S295 idiom).
    const optimistic: GuideStepState = {
      ...prev,
      ...(patch.checked != null
        ? { checkedAt: patch.checked ? new Date().toISOString() : null }
        : {}),
      ...(patch.note != null ? { note: patch.note } : {}),
    };
    setLocal((s) => ({ ...s, [stepId]: optimistic }));
    emit({ ...eff, [stepId]: optimistic });
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
      if (serverRow) {
        setLocal((s) => ({ ...s, [stepId]: serverRow }));
        emit({ ...eff, [stepId]: serverRow });
      }
    } catch {
      setLocal((s) => ({ ...s, [stepId]: prev }));
      setNoteDrafts((n) => {
        const next = { ...n };
        delete next[stepId];
        return next;
      });
      emit({ ...eff, [stepId]: prev });
    }
  };

  // Prep row — presence-derived from the context, never fetched (§5.2).
  // On-file values stay green chips; everything absent folds into ONE quiet
  // "Have ready" text line (Andrew S297 simplification).
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

  const outcomeAt = eff[PHONE_OUTCOME.id]?.checkedAt ?? null;

  return (
    <div className="mb-4 flex flex-col gap-4">
      {/* No skip affordance (Andrew): non-callers click through via 4b's
          always-clickable draft button (§3.6). */}
      {/* Have-ready prep row */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-[12px] text-gray-500">
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
            {/* 22px leading dot — grey ⋯ in-progress (Andrew: "on the step,
                not completed") · hollow untouched · green ✓ done */}
            <span
              className={
                "mt-0.5 grid h-[22px] w-[22px] flex-shrink-0 place-items-center rounded-full " +
                (checked
                  ? "bg-emerald-600 text-white"
                  : isCurrent
                    ? "bg-gray-300 text-gray-600"
                    : "border-[1.5px] border-gray-300 text-transparent")
              }
              aria-hidden
            >
              {checked ? (
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round">
                  <path d="M5 13l4 4L19 7" />
                </svg>
              ) : isCurrent ? (
                <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                  <circle cx="5" cy="12" r="2.2" />
                  <circle cx="12" cy="12" r="2.2" />
                  <circle cx="19" cy="12" r="2.2" />
                </svg>
              ) : null}
            </span>

            <div className="min-w-0 flex-1">
              <div className="text-[13.5px] font-bold text-gray-900">{step.title}</div>
              {phoneLine && (
                <div className="mt-0.5 text-[12px] text-gray-600">
                  <Segments segments={phoneLine} />
                </div>
              )}
              {copySegs && (
                <div className="mt-0.5 text-[12.5px] leading-[1.55] text-gray-500">
                  <Segments segments={copySegs} />
                </div>
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

              {/* Log input + attest button share one row, top-aligned so the
                  button lines up with the input (subtitle hangs below). */}
              {(step.note || (step.control === "checkbox" && step.checkboxLabel)) && (
                <div className="mt-2 flex flex-wrap items-start gap-x-3 gap-y-2">
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
                    <span className="flex flex-col items-center gap-0.5">
                      {/* Attestation BUTTON: outline-blue ask on the current
                          step; green confirmed once attested (click again
                          un-attests); advances the blue marker. */}
                      <button
                        type="button"
                        onClick={() => void persist(step.id, { checked: !checked })}
                        className={
                          checked
                            ? "inline-flex items-center gap-1.5 rounded-xl border border-emerald-300 bg-emerald-50 px-3.5 py-[7px] text-[12.5px] font-semibold text-emerald-700"
                            : isCurrent
                              ? "inline-flex items-center gap-1.5 rounded-xl border-[1.5px] border-blue-400 bg-white px-3.5 py-[6.5px] text-[12.5px] font-semibold text-blue-700 transition-colors hover:bg-blue-50"
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
                      <span className="text-center text-[10.5px] text-gray-400">
                        {state?.checkedAt != null
                          ? `completed — ${fmtStamp(state.checkedAt)}`
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

      {/* Bottom zone — the skip escape hatch (no calls yet) OR the outcome
          question (≥1 call attested). Both conclude 4a; the parent collapses
          it and 4b activates. */}
      {anyCallMade ? (
        <div className="border-t border-gray-100 pt-3">
          <div className="text-[13.5px] font-bold text-gray-900">{PHONE_OUTCOME.question}</div>
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() =>
                void persist(
                  PHONE_OUTCOME.id,
                  outcomeAnswer === "yes"
                    ? { checked: false, note: "" }
                    : { checked: true, note: "yes" },
                )
              }
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
              onClick={() =>
                void persist(
                  PHONE_OUTCOME.id,
                  outcomeAnswer === "no"
                    ? { checked: false, note: "" }
                    : { checked: true, note: "no" },
                )
              }
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
              {/* "Resolved at «server date-time»." — the answered-at stamp IS
                  the resolution log (Andrew E2E). */}
              {outcomeAt != null
                ? `${PHONE_OUTCOME.resolvedAtPrefix} ${fmtStamp(outcomeAt)}. `
                : ""}
              {ctx.track === "insurer"
                ? PHONE_OUTCOME.yesLineRestInsurer
                : PHONE_OUTCOME.yesLineRestProvider}
            </p>
          )}
        </div>
      ) : null}
    </div>
  );
}
