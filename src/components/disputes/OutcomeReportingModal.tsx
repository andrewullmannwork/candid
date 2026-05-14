/**
 * OutcomeReportingModal — S74.6 D5 §E.2
 *
 * Lets the user mark a sent dispute as won / lost / won_on_escalation /
 * settled, capture the amount recovered + resolution date, and optionally
 * report the alternative billing code the insurer reprocessed under (only
 * when status === 'won_on_escalation'). The recodedAs payload feeds the
 * §E.1 `dispute_won_recoding` SourceEntry write on the audit-side flywheel.
 *
 * POST shape: same /api/disputes/outcome contract used by the existing
 * Mark-as-Sent flow. We pass full {disputeId, status, amountRecovered,
 * resolutionDate, recodedAs} and let the route persist accordingly.
 */
"use client";

import { useState } from "react";

interface Props {
  open: boolean;
  disputeId: string;
  defaultAmount?: number | null;
  onCancel: () => void;
  onSubmitted: () => void;
  /** Returns Firebase ID token (caller-managed). */
  getIdToken: () => Promise<string | null>;
}

type OutcomeStatus = "won" | "lost" | "won_on_escalation" | "settled";

const STATUS_OPTIONS: { value: OutcomeStatus; label: string }[] = [
  { value: "won", label: "Won — insurer paid the original code" },
  { value: "won_on_escalation", label: "Won on escalation — insurer reprocessed under a different code" },
  { value: "settled", label: "Settled — partial payment / negotiated outcome" },
  { value: "lost", label: "Lost / denied — no payment" },
];

// CPT (5 digits), HCPCS L2 (letter + 4 digits), G-codes (G + 4 digits),
// CAT II (4 digits + F). Same vocabulary as ProcedureCodeType in
// src/lib/billing/types.ts. Restrictive enough to catch fat-finger entries
// without blocking legitimate codes.
const CODE_TYPE_OPTIONS: { value: string; label: string }[] = [
  { value: "CPT", label: "CPT" },
  { value: "HCPCS_L2", label: "HCPCS Level II" },
  { value: "G_CODE", label: "G-code" },
  { value: "CAT_II", label: "Category II (CPT-II)" },
];

function isValidCodeFormat(code: string): boolean {
  const trimmed = code.trim().toUpperCase();
  // Allow any 4-7 alphanumeric chars; precise validation happens server-side
  // via inferProcedureCodeType. We just want to catch empty / whitespace.
  return /^[A-Z0-9]{4,7}$/.test(trimmed);
}

export function OutcomeReportingModal({
  open,
  disputeId,
  defaultAmount,
  onCancel,
  onSubmitted,
  getIdToken,
}: Props) {
  const [status, setStatus] = useState<OutcomeStatus>("won");
  const [amountRecovered, setAmountRecovered] = useState<string>(
    defaultAmount != null ? String(defaultAmount) : "",
  );
  const [resolutionDate, setResolutionDate] = useState<string>(() => {
    // Default to today (YYYY-MM-DD local date).
    const d = new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  });
  const [recodedAsCode, setRecodedAsCode] = useState<string>("");
  const [recodedAsCodeType, setRecodedAsCodeType] = useState<string>("CPT");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  const showRecoded = status === "won_on_escalation";
  const recodedCodeTrim = recodedAsCode.trim();
  const recodedValid = !showRecoded || recodedCodeTrim.length === 0 || isValidCodeFormat(recodedCodeTrim);

  async function handleSubmit() {
    setError(null);
    const amt = Number(amountRecovered);
    if (Number.isNaN(amt) || amt < 0) {
      setError("Amount recovered must be a non-negative number.");
      return;
    }
    if (!resolutionDate) {
      setError("Resolution date is required.");
      return;
    }
    if (showRecoded && recodedCodeTrim && !isValidCodeFormat(recodedCodeTrim)) {
      setError("Recoded code must be 4-7 alphanumeric characters (e.g., 99213, G0008).");
      return;
    }

    setSubmitting(true);
    try {
      const token = await getIdToken();
      if (!token) {
        setError("You are not signed in. Refresh and try again.");
        setSubmitting(false);
        return;
      }
      const body: Record<string, unknown> = {
        disputeId,
        status,
        amountRecovered: amt,
        resolutionDate,
      };
      if (showRecoded && recodedCodeTrim) {
        body.recodedAs = {
          code: recodedCodeTrim.toUpperCase(),
          codeType: recodedAsCodeType,
        };
      }
      const res = await fetch("/api/disputes/outcome", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Unknown error" }));
        setError(err.error || "Failed to update outcome.");
        setSubmitting(false);
        return;
      }
      onSubmitted();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update outcome.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="outcome-modal-title"
    >
      <div className="w-full max-w-lg overflow-hidden rounded-2xl bg-white shadow-xl">
        <div className="border-b border-slate-100 px-6 py-4">
          <h2 id="outcome-modal-title" className="text-base font-semibold text-slate-900">
            Report dispute outcome
          </h2>
          <p className="mt-1 text-xs text-slate-500">
            How did your dispute resolve? Your answer helps us tell other users
            what to expect when they push back on similar charges.
          </p>
        </div>

        <div className="space-y-4 px-6 py-5">
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
              Outcome
            </label>
            <div className="mt-2 space-y-1.5">
              {STATUS_OPTIONS.map((opt) => (
                <label
                  key={opt.value}
                  className="flex cursor-pointer items-start gap-2 rounded-md border border-slate-100 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50"
                >
                  <input
                    type="radio"
                    name="outcome-status"
                    value={opt.value}
                    checked={status === opt.value}
                    onChange={() => setStatus(opt.value)}
                    className="mt-0.5"
                  />
                  <span>{opt.label}</span>
                </label>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="outcome-amount" className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
                Amount recovered
              </label>
              <input
                id="outcome-amount"
                type="number"
                min="0"
                step="0.01"
                value={amountRecovered}
                onChange={(e) => setAmountRecovered(e.target.value)}
                placeholder="0.00"
                className="mt-1 block w-full rounded-md border border-slate-200 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>
            <div>
              <label htmlFor="outcome-resolution-date" className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
                Resolution date
              </label>
              <input
                id="outcome-resolution-date"
                type="date"
                value={resolutionDate}
                onChange={(e) => setResolutionDate(e.target.value)}
                className="mt-1 block w-full rounded-md border border-slate-200 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>
          </div>

          {showRecoded && (
            <div className="rounded-md border border-blue-100 bg-blue-50/60 px-3 py-3">
              <p className="text-xs font-semibold text-blue-900">
                Did the insurer reprocess under a different code?
              </p>
              <p className="mt-0.5 text-[11px] text-blue-700">
                Optional but helpful — your answer trains our peer-code engine so
                we can suggest alternative billing codes to other users disputing
                similar charges.
              </p>
              <div className="mt-2 grid grid-cols-2 gap-2">
                <div>
                  <label htmlFor="outcome-recoded-code" className="block text-[10px] font-medium uppercase tracking-wide text-blue-700">
                    New code
                  </label>
                  <input
                    id="outcome-recoded-code"
                    type="text"
                    value={recodedAsCode}
                    onChange={(e) => setRecodedAsCode(e.target.value)}
                    placeholder="e.g. 99213"
                    maxLength={7}
                    className={`mt-0.5 block w-full rounded-md border px-3 py-1.5 text-sm focus:outline-none focus:ring-1 ${
                      recodedValid
                        ? "border-slate-200 focus:border-blue-500 focus:ring-blue-500"
                        : "border-red-300 focus:border-red-500 focus:ring-red-500"
                    }`}
                  />
                </div>
                <div>
                  <label htmlFor="outcome-recoded-type" className="block text-[10px] font-medium uppercase tracking-wide text-blue-700">
                    Code type
                  </label>
                  <select
                    id="outcome-recoded-type"
                    value={recodedAsCodeType}
                    onChange={(e) => setRecodedAsCodeType(e.target.value)}
                    className="mt-0.5 block w-full rounded-md border border-slate-200 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  >
                    {CODE_TYPE_OPTIONS.map((c) => (
                      <option key={c.value} value={c.value}>
                        {c.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              {!recodedValid && (
                <p className="mt-1 text-[11px] text-red-700">
                  Code must be 4-7 alphanumeric characters.
                </p>
              )}
            </div>
          )}

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
            {submitting ? "Saving…" : "Save outcome"}
          </button>
        </div>
      </div>
    </div>
  );
}
