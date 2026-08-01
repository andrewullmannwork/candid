"use client";

/**
 * LetterView — the ONE-LETTER page, sent state (S299 phase 2a).
 *
 * The approved mock is Panel E of plans/mocks/s298-extended-rail-mock.html:
 * "/disputes narrows to one letter — everything letter-specific stays;
 * everything about WHAT HAPPENS NEXT lives on the claim. Exactly two
 * affordances besides leaving." All copy below is Panel E / ruling-4 /
 * §0.9b approved VERBATIM — changes go to Andrew first.
 *
 * Rendered by the dispute page INSTEAD of the case-wide composition when
 * `case_rail_v1` is ON and the letter is sent. The draft state keeps the
 * existing letter-work engine (UnifiedTodo letterOnly) until the phase-3
 * rebuild; this component is the permanent sent-state home.
 *
 * §5 banked defect #1 dies here: the "Sent to" cell reads the LETTER —
 * collector letters show the letter's own collector (name + address),
 * insurer letters the pinned plan's insurer + appeals address — never
 * claim/track defaults, never a synthesized "Reprocess the claim" line.
 *
 * §0.9b sequencing guard: the unlock affordance renders ONLY while the
 * letter is stage `awaiting` (no outcome logged) — an unsend can never
 * orphan a logged response. The version stack labels unsent snapshots
 * "Marked sent «date», then unsent — never mailed" and never renders them
 * as mailed letters.
 */

import { useRouter } from "next/navigation";
import { LETTER_TYPE_LABELS } from "@/lib/disputes/letter-type";
import { fmtRailDate } from "@/lib/case/rail-steps";
import type { DisputeLetterType } from "@/lib/billing/types";

export interface LetterViewProps {
  letterType: string;
  /** Pinned-plan insurer display name (caseTimeline.insurerNameByDispute). */
  insurerName: string | null;
  /** The letter's OWN collector (dispute metadata) — collector letters only. */
  collector: { name?: string; address?: string | null } | null;
  /** The case's provider (caseTimeline.providerName) — breadcrumb + fallback. */
  providerName: string | null;
  /** "4b" for the primary letter; null hides the step suffix. */
  stepBadge: string | null;
  claimId: string;
  sentAtIso: string;
  certified: boolean;
  /** The immutable sent body (the GET serves sent_letter when sent). */
  body: string;
  strengthBand: string | null;
  appealsAddress: {
    line1?: string | null;
    line2?: string | null;
    city?: string | null;
    state?: string | null;
    postalCode?: string | null;
  } | null;
  /** §0.9 rule 4 stack (server-banked; newest last). */
  versions: Array<{
    body: string;
    sentAt: string;
    unsentAt?: string;
    collector?: { name?: string; address?: string | null } | null;
  }>;
  /** Present while stage `awaiting` — drives the pointer card's deadline line. */
  waitingDueLabel: string | null;
  /** §0.9b guard — true ONLY at stage `awaiting` (no outcome logged). */
  canUnlock: boolean;
  onDownload: () => void;
  onDraftUpdated: () => void;
  onUnlock: () => void;
}

function letterLabel(letterType: string): string {
  return LETTER_TYPE_LABELS[letterType as DisputeLetterType] ?? letterType.replace(/_/g, " ");
}

export function LetterView(p: LetterViewProps) {
  const router = useRouter();
  const goClaim = () => router.push(`/claim?claim=${p.claimId}`);
  // The recipient AS MAILED (S299): the latest live sent version banks its
  // collector at send time — the sent view reads THAT, so a post-send
  // metadata mutation (the "Test" clobber) can never re-address a mailed
  // letter's page. Legacy sends (no banked version) fall back to current
  // metadata.
  const sentCollector =
    [...p.versions].reverse().find((v) => v.unsentAt == null)?.collector ?? p.collector;
  const counterparty =
    sentCollector?.name ?? p.insurerName ?? p.providerName ?? null;
  const sentLabel = fmtRailDate(p.sentAtIso);
  const addr = p.appealsAddress;
  const addrLines = addr
    ? [
        addr.line1,
        addr.line2,
        [addr.city, addr.state, addr.postalCode].filter(Boolean).join(", "),
      ].filter((l): l is string => typeof l === "string" && l.length > 0)
    : [];
  // Newest first for display; vTags count down (mock: v2 current, v1 unsent).
  const stack = [...p.versions].reverse();

  return (
    <div className="mx-auto max-w-3xl">
      <button
        type="button"
        onClick={goClaim}
        className="mb-4 inline-flex items-center gap-1.5 border-none bg-transparent p-0 text-[13px] font-semibold text-blue-600 hover:underline"
      >
        ← Return to your claim
      </button>

      <div className="mb-3.5 flex flex-wrap items-start gap-2.5">
        <div className="min-w-[200px] flex-1">
          <div className="text-[17px] font-extrabold text-gray-900">
            {letterLabel(p.letterType)}
            {counterparty ? ` — ${counterparty}` : ""}
          </div>
          <div className="mt-0.5 text-[12.5px] text-gray-500">
            {p.providerName ? `Part of your ${p.providerName} case` : "Part of your case"}
            {p.stepBadge ? ` · step ${p.stepBadge}` : ""}
          </div>
        </div>
        <span className="inline-flex items-center rounded-full bg-emerald-50 px-2.5 py-[3px] text-[12px] font-semibold text-emerald-700 ring-1 ring-inset ring-emerald-200">
          {`Sent ${sentLabel}${p.certified ? " · certified mail" : ""}`}
        </span>
        <span className="inline-flex items-center rounded-full bg-slate-100 px-2.5 py-[3px] text-[12px] font-semibold text-slate-600 ring-1 ring-inset ring-slate-200">
          Locked — sent letters never change
        </span>
      </div>

      <div className="relative overflow-hidden rounded-xl border border-gray-200 bg-gray-50 p-5">
        <span className="absolute right-3 top-2.5 rounded-md border border-slate-200 bg-white px-2 py-[2px] text-[10.5px] font-extrabold tracking-[0.06em] text-slate-400">
          SENT · VIEW ONLY
        </span>
        <div className="whitespace-pre-wrap font-serif text-[14px] leading-[1.7] text-slate-800">
          {p.body}
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-2.5">
        {p.strengthBand && (
          <div className="min-w-[170px] flex-1 rounded-[10px] border border-gray-200 px-3 py-2.5 text-[12.5px]">
            <div className="mb-1 text-[10.5px] font-bold uppercase tracking-[0.05em] text-gray-400">
              Evidence & strength
            </div>
            <span className="inline-flex items-center rounded-full bg-emerald-50 px-2 py-[2px] text-[11px] font-semibold text-emerald-700 ring-1 ring-inset ring-emerald-200">
              {p.strengthBand.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())}
            </span>
          </div>
        )}
        <div className="min-w-[170px] flex-1 rounded-[10px] border border-gray-200 px-3 py-2.5 text-[12.5px]">
          <div className="mb-1 text-[10.5px] font-bold uppercase tracking-[0.05em] text-gray-400">
            Sent to
          </div>
          {sentCollector?.name ? (
            <>
              {sentCollector.name}
              {sentCollector.address ? (
                <span className="block text-gray-500">{sentCollector.address}</span>
              ) : null}
            </>
          ) : (
            <>
              {p.insurerName ?? p.providerName ?? "On file"}
              {addrLines.map((l) => (
                <span key={l} className="block text-gray-500">
                  {l}
                </span>
              ))}
            </>
          )}
        </div>
        <div className="min-w-[170px] flex-1 rounded-[10px] border border-gray-200 px-3 py-2.5 text-[12.5px]">
          <div className="mb-1 text-[10.5px] font-bold uppercase tracking-[0.05em] text-gray-400">
            Your copy
          </div>
          <button
            type="button"
            onClick={p.onDownload}
            className="border-none bg-transparent p-0 text-[12.5px] font-semibold text-blue-600 hover:underline"
          >
            Download PDF
          </button>
        </div>
      </div>

      {stack.length > 0 && (
        <div className="mt-3 overflow-hidden rounded-[10px] border border-gray-200">
          <div className="border-b border-gray-200 bg-gray-50 px-3 py-2 text-[11px] font-bold uppercase tracking-[0.05em] text-gray-400">
            Letter versions
          </div>
          {stack.map((v, i) => {
            const tag = `v${stack.length - i}`;
            const unsent = v.unsentAt != null;
            return (
              <div
                key={`${v.sentAt}-${i}`}
                className={
                  "border-t border-dashed border-gray-200 px-3 py-2 text-[13px] first:border-t-0 " +
                  (unsent ? "text-gray-500" : "")
                }
              >
                <div className="flex flex-wrap items-baseline gap-2.5">
                  <span className="rounded-md bg-slate-100 px-1.5 py-[1px] text-[11.5px] font-extrabold text-slate-500">
                    {tag}
                  </span>
                  {unsent ? (
                    <span>{`Marked sent ${fmtRailDate(v.sentAt)}, then unsent — never mailed`}</span>
                  ) : (
                    <span>
                      <b>{`Sent ${fmtRailDate(v.sentAt)}`}</b>
                      {counterparty ? ` — the version ${counterparty} has` : " — this letter"}
                    </span>
                  )}
                </div>
                {unsent && (
                  <details className="mt-1">
                    <summary className="cursor-pointer list-none text-[12px] font-semibold text-blue-600 hover:underline">
                      See it
                    </summary>
                    <div className="mt-1.5 max-h-64 overflow-y-auto whitespace-pre-wrap rounded-lg border border-gray-200 bg-white p-3 font-serif text-[12.5px] leading-relaxed text-slate-600">
                      {v.body}
                    </div>
                  </details>
                )}
              </div>
            );
          })}
        </div>
      )}

      <hr className="my-4 border-gray-200" />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={p.onDraftUpdated}
            className="inline-flex items-center rounded-lg border border-gray-200 bg-white px-4 py-2 text-[13.5px] font-semibold text-gray-700 transition-colors hover:bg-gray-50"
          >
            Draft an updated letter
          </button>
          {p.canUnlock && (
            <button
              type="button"
              onClick={p.onUnlock}
              className="border-none bg-transparent p-0 text-[12px] text-gray-400 underline underline-offset-2 transition-colors hover:text-gray-600"
            >
              I haven&apos;t actually sent this — unlock and edit
            </button>
          )}
        </div>
        <button
          type="button"
          onClick={goClaim}
          className="inline-flex items-center rounded-lg bg-blue-600 px-4 py-2 text-[13.5px] font-semibold text-white shadow-sm transition-colors hover:bg-blue-700"
        >
          Return to your claim
        </button>
      </div>

      <div className="mt-3.5 rounded-xl border border-gray-200 bg-blue-50/30 px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-3 text-[13px]">
          <div>
            <b>What happens next lives on your claim</b>
            {p.waitingDueLabel
              ? ` — waiting on ${counterparty ?? "a response"} · deadline ${p.waitingDueLabel}`
              : ""}
          </div>
          <button
            type="button"
            onClick={goClaim}
            className="border-none bg-transparent p-0 text-[12.5px] font-semibold text-blue-600 hover:underline"
          >
            Go to the waiting step →
          </button>
        </div>
      </div>
    </div>
  );
}
