/**
 * MethodologyTooltip — Pattern 1 #11 tiered methodology disclosure tooltip (T2.2 v3)
 *
 * Reusable hover tooltip for cross-user aggregate metrics surfaces. Per Pattern 1 #11:
 * "Aggregate metrics displayed publicly require methodology disclosure. Tiered:
 * headline inline; per-row hover."
 *
 * Consumer flows:
 *   - DisputeAggregateWidget (per-insurer aggregate; this is its hover tooltip)
 *   - Future: Care pricing widget (Phase 5.1A) will reuse same component
 *
 * Per Q-T2.2-5 LOCK + ABA Rule 7.1 basis.
 */

"use client";

import { useState } from "react";

export interface MethodologyMetadata {
  since: string | null;
  plan_years_included: number[];
  k_anon_min_distinct_users: number | null;
  states_included: string[];
  outlier_quarantine_active: boolean;
  insurer_canonical_id_used?: boolean;
  scope_note?: string;
}

interface Props {
  methodology: MethodologyMetadata;
  triggerLabel?: string;
  className?: string;
}

export function MethodologyTooltip({ methodology, triggerLabel = "How is this calculated?", className }: Props) {
  const [open, setOpen] = useState(false);

  const sinceText = methodology.since ? `since ${methodology.since}` : "since launch";
  const planYearsText = methodology.plan_years_included.length > 0
    ? `plan years ${methodology.plan_years_included.join(", ")}`
    : "all plan years";
  const kAnonText = methodology.k_anon_min_distinct_users
    ? `≥${methodology.k_anon_min_distinct_users} distinct users required to display`
    : "no minimum threshold (personal data)";
  const statesText = methodology.states_included.length > 0
    ? methodology.states_included.join(", ")
    : "all states";
  const outlierText = methodology.outlier_quarantine_active
    ? "outlier outcomes excluded"
    : "outlier outcomes included";

  return (
    <span className={`relative inline-block ${className ?? ""}`}>
      <button
        type="button"
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={() => setOpen((v) => !v)}
        className="text-xs text-gray-500 underline decoration-dotted underline-offset-2 hover:text-gray-700 focus:outline-none"
        aria-expanded={open}
        aria-label={triggerLabel}
      >
        {triggerLabel}
      </button>
      {open && (
        <div
          role="tooltip"
          className="absolute z-50 mt-1 w-72 rounded-lg border border-gray-200 bg-white p-3 text-xs text-gray-700 shadow-lg"
          style={{ left: 0, top: "100%" }}
        >
          <p className="mb-2 font-semibold text-gray-900">How this is calculated</p>
          <ul className="space-y-1">
            {methodology.scope_note && (
              <li className="text-gray-600">{methodology.scope_note}</li>
            )}
            <li>
              <span className="text-gray-500">Time window:</span> {sinceText}
            </li>
            <li>
              <span className="text-gray-500">Coverage:</span> {planYearsText}
            </li>
            <li>
              <span className="text-gray-500">States included:</span> {statesText.replace(/_/g, " ")}
            </li>
            <li>
              <span className="text-gray-500">Privacy threshold:</span> {kAnonText}
            </li>
            <li>
              <span className="text-gray-500">Outlier handling:</span> {outlierText}
            </li>
          </ul>
        </div>
      )}
    </span>
  );
}
