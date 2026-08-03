"use client";

/**
 * UnsendControl — "I haven't actually sent this", with its confirm.
 *
 * ONE component for BOTH surfaces (the claim rail's send step and the letter
 * page's sent view). They render the same act, so they must offer the same
 * words, the same confirm, and the same consequence — two implementations is
 * how the two ended up disagreeing about whether unsend was even possible
 * (S301: the rail blocked it behind "undo the result first" while the letter
 * page simply hid it).
 *
 * ALWAYS offered. When a response is logged, the confirm names WHAT will be
 * cleared and WHY, then performs it in the ONE atomic request that clears both
 * (outcome-actions.unsendPayload). §0.9b's invariant — an unsend can never
 * orphan a logged response — is upheld by that patch, not by hiding the button.
 *
 * Inline expansion, not a modal (Andrew, S301): the surrounding surfaces already
 * use inline disclosure, and a two-line question does not warrant a new overlay.
 */

import { useState } from "react";
import { UNSEND_COPY } from "@/lib/disputes/outcome-actions";

export function UnsendControl({
  loggedOutcomeLabel,
  loggedOutcomeDateLabel,
  withEditLabel,
  onUnsend,
}: {
  /** Non-null when a response is logged — drives the confirm. */
  loggedOutcomeLabel: string | null;
  loggedOutcomeDateLabel: string | null;
  /** Letter page: the affordance also reopens the letter for editing. */
  withEditLabel?: boolean;
  /** Performs the unsend; resolves false on failure. */
  onUnsend: () => Promise<boolean>;
}) {
  const [confirming, setConfirming] = useState(false);
  // The control owns its OWN in-flight + failure state (S301 audit). Passing
  // them in meant three separate mechanisms for one operation — keyed maps in
  // CaseRail, booleans in ClaimDetail, and props on LetterView that were never
  // wired at all, so a failed unsend there showed nothing. A fourth surface now
  // gets both for free.
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const hasOutcome = loggedOutcomeLabel != null;

  const run = async () => {
    setBusy(true);
    setFailed(false);
    try {
      const ok = await onUnsend();
      if (!ok) setFailed(true);
      else setConfirming(false);
    } finally {
      setBusy(false);
    }
  };

  const trigger = (
    <button
      type="button"
      onClick={() => (hasOutcome ? setConfirming(true) : void run())}
      disabled={busy}
      className="self-start border-none bg-transparent p-0 text-[12px] text-gray-400 underline underline-offset-2 transition-colors hover:text-gray-600 disabled:opacity-60"
    >
      {busy ? "Working…" : withEditLabel ? UNSEND_COPY.actionWithEdit : UNSEND_COPY.action}
    </button>
  );

  if (!confirming) {
    return (
      <div className="flex flex-col gap-1">
        {trigger}
        {failed && (
          <span className="text-[11.5px] font-medium text-red-600">
            That didn&apos;t save — please try again.
          </span>
        )}
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50/60 px-3.5 py-3">
      <div className="text-[12.5px] font-semibold text-amber-900">
        {UNSEND_COPY.confirmTitle}
      </div>
      <p className="mt-1 text-[12px] leading-[1.55] text-amber-900">
        {UNSEND_COPY.confirmBody(loggedOutcomeLabel ?? "", loggedOutcomeDateLabel)}
      </p>
      <div className="mt-2.5 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => void run()}
          disabled={busy}
          className="inline-flex items-center rounded-lg bg-blue-600 px-3.5 py-[7px] text-[12.5px] font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-60"
        >
          {busy ? "Working…" : UNSEND_COPY.confirm}
        </button>
        <button
          type="button"
          onClick={() => setConfirming(false)}
          className="border-none bg-transparent p-0 text-[12px] font-medium text-gray-500 underline underline-offset-2 hover:text-gray-700"
        >
          {UNSEND_COPY.cancel}
        </button>
      </div>
      {failed && (
        <p className="mt-2 text-[11.5px] font-medium text-red-600">
          That didn&apos;t save — please try again.
        </p>
      )}
    </div>
  );
}
