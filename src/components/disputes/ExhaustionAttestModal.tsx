/**
 * ExhaustionAttestModal — dispute-letters v2 Zone-3 (S266).
 *
 * External review (I2) is only available AFTER the plan's internal appeal is
 * exhausted (ACA §2719 / 45 CFR §147.136). The escalate route hard-gates on
 * appealExhausted.attested (fail-closed), so this modal collects the attestation
 * + the final-denial date before the "Request an external review" CTA fires.
 */
"use client";

import { useState } from "react";

export interface ExhaustionSubmit {
  appealExhausted: { attested: boolean; denialDate: string | null };
}

interface Props {
  open: boolean;
  submitting?: boolean;
  onCancel: () => void;
  onSubmit: (input: ExhaustionSubmit) => void;
}

export function ExhaustionAttestModal({ open, submitting, onCancel, onSubmit }: Props) {
  const [attested, setAttested] = useState(false);
  const [denialDate, setDenialDate] = useState("");
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  function handleSubmit() {
    if (!attested) {
      setError("Please confirm you received a final internal denial before requesting external review.");
      return;
    }
    setError(null);
    onSubmit({ appealExhausted: { attested: true, denialDate: denialDate || null } });
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="exhaustion-modal-title"
    >
      <div className="w-full max-w-lg overflow-hidden rounded-2xl bg-white shadow-xl">
        <div className="border-b border-slate-100 px-6 py-4">
          <h2 id="exhaustion-modal-title" className="text-base font-semibold text-slate-900">
            Before you request an external review
          </h2>
          <p className="mt-1 text-xs text-slate-500">
            An independent external review is available once you&apos;ve completed your plan&apos;s
            internal appeal and received a final denial. Confirm that&apos;s happened so the letter is
            accurate.
          </p>
        </div>

        <div className="space-y-4 px-6 py-5">
          <label className="flex cursor-pointer items-start gap-2.5 rounded-md border border-slate-200 px-3 py-3 text-sm text-slate-700 hover:bg-slate-50">
            <input
              type="checkbox"
              checked={attested}
              onChange={(e) => setAttested(e.target.checked)}
              className="mt-0.5"
            />
            <span>
              I completed my plan&apos;s internal appeal and received a{" "}
              <span className="font-medium">final</span> adverse determination (denial).
            </span>
          </label>

          <div>
            <label htmlFor="exhaustion-denial-date" className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
              Final denial date <span className="font-normal normal-case text-slate-400">(optional)</span>
            </label>
            <input
              id="exhaustion-denial-date"
              type="date"
              value={denialDate}
              onChange={(e) => setDenialDate(e.target.value)}
              className="mt-1 block w-full rounded-md border border-slate-200 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>

          {error && (
            <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
              {error}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-slate-100 bg-slate-50 px-6 py-3">
          <button
            type="button"
            onClick={onCancel}
            disabled={submitting}
            className="rounded-md border border-slate-200 bg-white px-4 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-60"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={submitting}
            className="rounded-md bg-blue-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60"
          >
            {submitting ? "Creating…" : "Request external review"}
          </button>
        </div>
      </div>
    </div>
  );
}
