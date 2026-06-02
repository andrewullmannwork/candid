"use client";

/**
 * ServiceVerificationGateCard (S154) — required gate on the dispute letter page
 * for a bill line whose coverage was resolved via the SECONDARY (category) match
 * (no exact plan row, e.g. annual_physical → preventive_care). Reuses the
 * EvidenceGaps gap-card visual + the `provider_address_confirm` two-button
 * pattern, repurposed as a verify gate: the user confirms whether the inferred
 * coverage matches the service —
 *   "Matches"       → confirm-coverage(match)   → the letter CITES this coverage
 *   "Doesn't match" → confirm-coverage(no_match) → the coverage is EXCLUDED
 * Until resolved the line carries no plan-coverage citation in the letter.
 *
 * Renders the inner card content only; the parent (EvidenceGaps) supplies the
 * `<li>` border/background so it stays visually consistent with the other gaps.
 */

import { useState } from "react";
import type { EvidenceGap } from "@/lib/disputes/evidence-resolver";

export function ServiceVerificationGateCard({
  gap,
  onDecide,
}: {
  gap: EvidenceGap;
  onDecide: (decision: "match" | "no_match") => Promise<void>;
}) {
  const [status, setStatus] = useState<"idle" | "match" | "no_match" | "error">("idle");
  const busy = status === "match" || status === "no_match";

  const decide = async (decision: "match" | "no_match") => {
    if (busy) return;
    setStatus(decision);
    try {
      await onDecide(decision);
      // Parent refetches → this gap disappears on success; reset defensively.
      setStatus("idle");
    } catch {
      setStatus("error");
    }
  };

  return (
    <div className="flex flex-col gap-3 @md:flex-row @md:items-center @md:justify-between">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <GateIcon />
          <div className="font-semibold text-slate-900">{gap.title}</div>
        </div>
        <p className="mt-1 pl-6 text-sm text-slate-600">{gap.description}</p>
        {status === "error" ? (
          <p className="mt-1 pl-6 text-sm text-red-600" role="status">
            Something went wrong — please try again.
          </p>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-2 @md:ml-4">
        <button
          type="button"
          onClick={() => decide("match")}
          disabled={busy}
          className="inline-flex items-center justify-center rounded-lg bg-blue-600 px-3.5 py-2 text-sm font-semibold text-white shadow-sm transition-all hover:-translate-y-px hover:bg-blue-700 hover:shadow disabled:cursor-wait disabled:opacity-70"
        >
          {status === "match" ? "Saving…" : "Matches"}
        </button>
        <button
          type="button"
          onClick={() => decide("no_match")}
          disabled={busy}
          className="inline-flex items-center justify-center rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-sm font-semibold text-slate-700 shadow-sm transition-all hover:-translate-y-px hover:bg-slate-50 hover:shadow disabled:cursor-wait disabled:opacity-70"
        >
          {status === "no_match" ? "Saving…" : "Doesn't match"}
        </button>
      </div>
    </div>
  );
}

function GateIcon() {
  return (
    <svg
      className="h-4 w-4 text-amber-500"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      viewBox="0 0 24 24"
      aria-hidden
    >
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="8" x2="12" y2="12" />
      <line x1="12" y1="16" x2="12.01" y2="16" />
    </svg>
  );
}
