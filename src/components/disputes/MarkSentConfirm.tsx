"use client";

/**
 * S320 — the enclosure-aware send confirms (mock-approved copy, Andrew
 * 2026-08-19; design record: vault plans/mocks/s320-external-review-enclosures-mock.html).
 *
 * ONE implementation for every surface that downloads or marks a letter sent —
 * the letter page (toolbar + UnifiedTodo spine row) and the claim rail — so
 * the enclosure list and the send-method semantics can never drift between
 * them. The list itself comes from the one LETTER_ENCLOSURES declaration
 * (letter-type.ts); an empty list collapses MarkSentConfirm to exactly the
 * S302 method row ("choosing a method IS the confirmation") and hides the
 * band/reminder entirely.
 */

import { useState } from "react";

/** The amber "must go in the same envelope" band (rail + download reminder). */
export function EnclosureBand({ enclosures }: { enclosures: readonly string[] }) {
  if (enclosures.length === 0) return null;
  return (
    <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-3">
      <p className="flex items-start gap-2 text-[13px] font-bold text-amber-900">
        <span aria-hidden>⚠︎</span>
        Your request must go in the same envelope as these documents
      </p>
      <ul className="mt-2 flex list-disc flex-col gap-1 pl-5">
        {enclosures.map((e) => (
          <li key={e} className="text-[13px] leading-relaxed text-amber-950">
            {e}
          </li>
        ))}
      </ul>
      <p className="mt-2 text-[12px] text-amber-800">
        Reviewers can reject a request that arrives without them. Candid&apos;s download includes only
        the letter itself.
      </p>
    </div>
  );
}

/** S302 send methods — the stored semantics: certified is the only method
 *  that is evidence (the caller sets the `mailcert` fact from it). */
export type SendMethodKind = "certified" | "mail" | "portal";
const SEND_METHODS: ReadonlyArray<[SendMethodKind, string]> = [
  ["certified", "USPS certified mail"],
  ["mail", "Regular mail"],
  ["portal", "Insurer portal or email"],
];

/**
 * Two-stage inline confirm: enclosure attestation (only when the letter type
 * declares enclosures) gating the S302 method row. Renders inside whatever
 * container the surface already uses (UnifiedTodo's blue confirm box, the
 * rail's step body, the toolbar's popover).
 */
export function MarkSentConfirm({
  enclosures,
  busy,
  onMethod,
  onNotYet,
}: {
  enclosures: readonly string[];
  busy: boolean;
  /** Called with the chosen method; `enclosuresConfirmed` is true when the
   *  attestation stage was shown and checked (always false when no
   *  enclosures are declared — absence of the stage is not an attestation). */
  onMethod: (kind: SendMethodKind, enclosuresConfirmed: boolean) => void;
  onNotYet: () => void;
}) {
  const [confirmed, setConfirmed] = useState(false);
  const needsConfirm = enclosures.length > 0;
  const methodsEnabled = !needsConfirm || confirmed;
  return (
    <div className="animate-fade-in mt-2 mb-2 rounded-[10px] border border-blue-200 bg-blue-50 px-3 py-2.5 text-[12.5px] text-blue-900">
      {needsConfirm && (
        <>
          <div className="font-semibold">Before we record it as sent</div>
          <p className="mt-1 text-[12px] leading-relaxed text-blue-800/90">
            External reviewers can reject a request that arrives without its supporting documents.
            Confirm what went in the envelope:
          </p>
          <label className="mt-2 flex cursor-pointer items-start gap-2 rounded-lg border border-blue-200 bg-white px-3 py-2 font-semibold">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
              className="mt-0.5"
            />
            <span>
              I included the final denial letter, my internal appeal, the EOB, and my supporting
              documents with this request.
            </span>
          </label>
        </>
      )}
      <div className={methodsEnabled ? "" : "pointer-events-none opacity-45"}>
        <div className={`font-semibold ${needsConfirm ? "mt-3" : ""}`}>How did you send it?</div>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {SEND_METHODS.map(([kind, label]) => (
            <button
              key={kind}
              type="button"
              disabled={busy || !methodsEnabled}
              onClick={() => onMethod(kind, needsConfirm && confirmed)}
              className="rounded-lg border border-blue-200 bg-white px-3 py-1.5 font-semibold text-blue-800 hover:bg-blue-50 disabled:opacity-50"
            >
              {label}
            </button>
          ))}
          <button
            type="button"
            onClick={onNotYet}
            className="rounded-lg px-2 py-1.5 font-semibold text-gray-500 hover:text-gray-700"
          >
            Not yet
          </button>
        </div>
      </div>
      <div className="mt-1.5 text-[11.5px] font-normal text-blue-800/80">
        {busy
          ? "Saving…"
          : "Certified mail (USPS Form 3811) is your proof of delivery — we cite it in your letter and Case File."}
      </div>
    </div>
  );
}

/**
 * The download reminder (mock panel B) — one tap through, informational, never
 * a gate. Rendered only when the letter type declares enclosures.
 */
export function DownloadReminderModal({
  enclosures,
  onConfirm,
  onCancel,
}: {
  enclosures: readonly string[];
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true">
      <div className="w-full max-w-[480px] rounded-2xl border border-gray-200 bg-white shadow-2xl">
        <div className="px-5 py-5">
          <span className="inline-block rounded-full bg-blue-50 px-2.5 py-1 text-[10.5px] font-bold uppercase tracking-wider text-blue-700">
            Before you print
          </span>
          <h3 className="mt-2 text-[16px] font-extrabold tracking-tight text-gray-900">
            The letter alone isn&apos;t enough
          </h3>
          <p className="mt-1.5 text-[13.5px] leading-relaxed text-gray-700">
            Your external review request must be mailed <strong>together with</strong>:
          </p>
          <EnclosureBand enclosures={enclosures} />
        </div>
        <div className="flex justify-end gap-2.5 border-t border-gray-100 px-5 py-3.5">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-xl border-[1.5px] border-blue-100 bg-white px-4 py-2 text-[13.5px] font-semibold text-blue-600 hover:bg-blue-50/50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="rounded-xl bg-blue-600 px-4 py-2 text-[13.5px] font-semibold text-white hover:bg-blue-700"
          >
            Got it — download
          </button>
        </div>
      </div>
    </div>
  );
}
