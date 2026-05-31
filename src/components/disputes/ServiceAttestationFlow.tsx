"use client";

import { useState } from "react";

/**
 * ServiceAttestationFlow — Block C2 affordance #2 (§1c "make it stronger" + §1f L2).
 *
 * A neutral, truthful gate → per-line picker → affirmation flow that lets the user
 * state (under their own name) that one or more billed services were not rendered.
 * On confirm it commits the FULL attested set via `onSubmit`; the resolver then
 * reclassifies each line to `service_not_rendered` (documentary spine).
 *
 * Legal rails: L1 — no scores/odds shown here. L2 — question-first, never coaching
 * ("ask the truth, don't sell the action"). The affirmation text is legal copy
 * pending sign-off. Mounted inside <EvidenceBlock> only when the v3 flag is ON.
 */

export interface AttestationLine {
  lineItemId: string;
  serviceName: string;
  codeLabel: string | null;
  billedAmount: number;
}

// Block C2 item 1 — LOCKED legal copy (S150). String 1 = the in-app affirmation
// (name-interpolated below); String 2 (the transmitted letter sentence) lives in
// templates.ts. The microcopy + the editable "Attesting as" name are part of the
// same locked set. Keep in sync with templates.ts; change only with legal review.
const affirmationText = (name: string): string =>
  name
    ? `I, ${name}, attest that the service(s) I selected were not provided to me — true to the best of my knowledge, based on my own records and recollection.`
    : `I attest that the service(s) I selected were not provided to me — true to the best of my knowledge, based on my own records and recollection.`;
const ATTESTATION_MICROCOPY =
  "This statement becomes part of the letter you send. You are responsible for its contents. Candid does not verify or submit it on your behalf.";

function Check({ className = "h-3.5 w-3.5" }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={3.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M5 13l4 4L19 7" />
    </svg>
  );
}

function formatUsd(n: number): string {
  return `$${(n || 0).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

type Stage = "entry" | "picker" | "affirm" | "dismissed";

export function ServiceAttestationFlow({
  lines,
  attested,
  reviewed = false,
  accountName,
  attestingAsName,
  onSubmit,
  busy = false,
}: {
  lines: AttestationLine[];
  attested: string[];
  /** Block C2 item 2 — whether the user already answered the gate (persisted
   * dispute.metadata.serviceAttestationReviewed). True → don't re-prompt the full
   * gate; show the compact summary instead. */
  reviewed?: boolean;
  /** Default attesting name (account holder — users.display_name). */
  accountName: string;
  /** Persisted adopted name (dispute.metadata.attestingAsName); overrides default. */
  attestingAsName?: string | null;
  onSubmit: (payload: {
    attestedLineItemIds: string[];
    serviceAttestationReviewed: boolean;
    attestingAsName?: string;
  }) => void | Promise<void>;
  busy?: boolean;
}) {
  const [stage, setStage] = useState<Stage>("entry");
  const [selected, setSelected] = useState<string[]>(attested);
  const [accepted, setAccepted] = useState(false);
  // Block C2 item 1 — the editable "Attesting as" name. Defaults to the persisted
  // adopted name, else the account name. Checking the affirmation adopts it.
  const [attestName, setAttestName] = useState((attestingAsName || accountName || "").trim());
  const [editingName, setEditingName] = useState(false);

  if (lines.length === 0 || stage === "dismissed") return null;

  const toggle = (id: string) =>
    setSelected((s) =>
      s.includes(id) ? s.filter((x) => x !== id) : [...s, id],
    );
  const chosen = lines.filter((l) => selected.includes(l.lineItemId));

  // ── Entry ── full gate when nothing attested yet; compact summary otherwise.
  if (stage === "entry") {
    // Block C2 item 2 — once the gate is answered (reviewed) or any line is
    // attested, show the compact summary; never re-prompt the full gate.
    if (reviewed || attested.length > 0) {
      return (
        <div className="flex items-center justify-between gap-3 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
          <div className="text-xs text-slate-600">
            {attested.length > 0 ? (
              <>
                You&apos;ve noted{" "}
                <span className="font-semibold text-slate-800">
                  {attested.length}
                </span>{" "}
                service{attested.length === 1 ? "" : "s"} as not provided.
              </>
            ) : (
              <>You&apos;ve reviewed whether these services were provided.</>
            )}
          </div>
          <button
            type="button"
            onClick={() => {
              setSelected(attested);
              setStage("picker");
            }}
            className="text-[12.5px] font-semibold text-blue-600 hover:text-blue-700 hover:underline"
          >
            Edit
          </button>
        </div>
      );
    }
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-4">
        <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wide text-slate-400">
          <svg
            className="h-3.5 w-3.5"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            aria-hidden
          >
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
          </svg>
          Optional · only if it applies to you
        </div>
        <div className="mt-1.5 text-sm font-semibold text-slate-800">
          Were all of these services actually performed as billed?
        </div>
        <p className="mt-1 text-xs leading-relaxed text-slate-500">
          If a service on this claim wasn&apos;t provided to you, you can note it
          here. It&apos;s only worth doing if you remember it clearly — answer from
          your own records.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => {
              // Item 2 — persist that the gate was answered so it never re-prompts.
              void onSubmit({ attestedLineItemIds: [], serviceAttestationReviewed: true });
              setStage("dismissed");
            }}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-[13px] font-semibold text-slate-700 hover:border-slate-400 hover:bg-slate-50"
          >
            <span className="text-emerald-700">
              <Check className="h-3.5 w-3.5" />
            </span>{" "}
            Yes, all performed
          </button>
          <button
            type="button"
            onClick={() => setStage("picker")}
            className="inline-flex items-center rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-[13px] font-semibold text-slate-700 hover:border-slate-400 hover:bg-slate-50"
          >
            No — some weren&apos;t
          </button>
          <button
            type="button"
            onClick={() => {
              // Item 2 — "not sure" is still an answer; persist so it doesn't re-prompt
              // (the compact summary's Edit lets the user revisit).
              void onSubmit({ attestedLineItemIds: [], serviceAttestationReviewed: true });
              setStage("dismissed");
            }}
            className="ml-auto px-1 py-1.5 text-xs text-slate-400 hover:text-slate-600 hover:underline"
          >
            I&apos;m not sure
          </button>
        </div>
      </div>
    );
  }

  // ── Picker ──
  if (stage === "picker") {
    return (
      <div className="overflow-hidden rounded-xl border border-blue-200 bg-white">
        <div className="border-b border-slate-100 px-4 pb-3 pt-3.5">
          <div className="text-[10px] font-bold uppercase tracking-wide text-blue-600">
            Step 1 of 2
          </div>
          <div className="mt-1 text-sm font-semibold text-slate-900">
            Select the service(s) you did not receive
          </div>
          <p className="mt-1 text-xs text-slate-500">
            Choose only the lines you&apos;re certain were not provided to you.
          </p>
        </div>
        <div className="flex flex-col">
          {lines.map((l) => {
            const on = selected.includes(l.lineItemId);
            return (
              <button
                key={l.lineItemId}
                type="button"
                role="checkbox"
                aria-checked={on}
                onClick={() => toggle(l.lineItemId)}
                className={`flex items-start gap-3 border-b border-slate-100 px-4 py-3 text-left last:border-b-0 hover:bg-slate-50 ${on ? "bg-blue-50" : "bg-white"}`}
              >
                <span
                  className={`mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-md border ${on ? "border-blue-600 bg-blue-600 text-white" : "border-slate-300 bg-white text-transparent"}`}
                >
                  {on ? <Check className="h-3 w-3" /> : null}
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="text-[13px] font-semibold text-slate-900">
                    {l.serviceName}
                  </span>
                  {l.codeLabel ? (
                    <span className="font-mono text-[11px] text-slate-400">
                      {l.codeLabel}
                    </span>
                  ) : null}
                </span>
                <span className="shrink-0 text-[12.5px] tabular-nums text-slate-600">
                  {formatUsd(l.billedAmount)}
                </span>
              </button>
            );
          })}
        </div>
        <div className="flex items-center justify-between gap-3 border-t border-slate-100 bg-slate-50 px-4 py-3">
          <div className="text-xs text-slate-500">
            {selected.length > 0 ? (
              <>
                <span className="font-semibold text-slate-700">
                  {selected.length}
                </span>{" "}
                selected
              </>
            ) : (
              "Nothing selected yet"
            )}
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setStage("entry")}
              className="px-1 text-[12.5px] font-medium text-slate-500 hover:text-slate-700 hover:underline"
            >
              Back
            </button>
            <button
              type="button"
              disabled={selected.length === 0}
              onClick={() => setStage("affirm")}
              className="inline-flex items-center rounded-lg bg-blue-600 px-3.5 py-2 text-[13px] font-semibold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-45"
            >
              Continue
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── Affirm ──
  return (
    <div className="overflow-hidden rounded-xl border border-blue-200 bg-white">
      <div className="border-b border-slate-100 bg-slate-50 px-4 py-3">
        <div className="text-[11px] font-semibold text-slate-500">
          You&apos;re attesting that you did not receive:
        </div>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {chosen.map((l) => (
            <span
              key={l.lineItemId}
              className="inline-flex items-baseline gap-1.5 rounded-md border border-slate-200 bg-white px-2.5 py-1"
            >
              <span className="text-[12.5px] font-semibold text-slate-700">
                {l.serviceName}
              </span>
              {l.codeLabel ? (
                <span className="font-mono text-[11px] text-slate-400">
                  {l.codeLabel}
                </span>
              ) : null}
            </span>
          ))}
        </div>
      </div>
      <div className="px-4 py-4">
        <button
          type="button"
          role="checkbox"
          aria-checked={accepted}
          onClick={() => setAccepted((a) => !a)}
          className={`flex w-full items-start gap-3 rounded-lg border p-3.5 text-left ${accepted ? "border-blue-200 bg-blue-50" : "border-slate-200 bg-slate-50 hover:border-slate-300"}`}
        >
          <span
            className={`mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full border ${accepted ? "border-blue-600 bg-blue-600 text-white" : "border-slate-300 bg-white text-transparent"}`}
          >
            {accepted ? <Check className="h-3 w-3" /> : null}
          </span>
          <span className="flex-1 text-[13px] leading-relaxed text-slate-700">
            {affirmationText(attestName)}
          </span>
        </button>
        {/* Block C2 item 1 — editable "Attesting as" name; checking the box above
            adopts it. Defaults to the account name; persisted via onSubmit. */}
        <div className="mt-2.5 flex items-center gap-2 pl-8 text-[12px] text-slate-500">
          {editingName ? (
            <>
              <span className="shrink-0">Attesting as:</span>
              <input
                type="text"
                value={attestName}
                maxLength={120}
                autoFocus
                onChange={(e) => setAttestName(e.target.value)}
                onBlur={() => setEditingName(false)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") setEditingName(false);
                }}
                className="min-w-0 flex-1 rounded-md border border-slate-300 px-2 py-1 text-[12.5px] text-slate-800 focus:border-blue-400 focus:outline-none"
              />
              <button
                type="button"
                onClick={() => setEditingName(false)}
                className="shrink-0 font-semibold text-blue-600 hover:underline"
              >
                Done
              </button>
            </>
          ) : (
            <>
              <span className="truncate">
                Attesting as:{" "}
                <span className="font-semibold text-slate-700">
                  {attestName || accountName || "—"}
                </span>
              </span>
              <button
                type="button"
                onClick={() => setEditingName(true)}
                className="shrink-0 font-semibold text-blue-600 hover:text-blue-700 hover:underline"
              >
                edit
              </button>
            </>
          )}
        </div>
        <p className="mt-2 pl-8 text-[11.5px] leading-relaxed text-slate-400">
          {ATTESTATION_MICROCOPY}
        </p>
        <div className="mt-3.5 flex items-center justify-between gap-3">
          <p className="max-w-[42ch] text-[11.5px] leading-relaxed text-slate-400">
            Nothing is added to your letter until you confirm. You can undo it
            afterward.
          </p>
          <div className="flex shrink-0 gap-2">
            <button
              type="button"
              onClick={() => setStage("picker")}
              className="inline-flex items-center rounded-lg border border-slate-300 bg-white px-3 py-2 text-[13px] font-semibold text-slate-700 hover:bg-slate-50"
            >
              Back
            </button>
            <button
              type="button"
              disabled={!accepted || busy}
              onClick={async () => {
                await onSubmit({
                  attestedLineItemIds: selected,
                  serviceAttestationReviewed: true,
                  attestingAsName: (attestName || accountName || "").trim() || undefined,
                });
                setStage("dismissed");
              }}
              className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3.5 py-2 text-[13px] font-semibold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-45"
            >
              <Check className="h-3.5 w-3.5" /> Confirm
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
