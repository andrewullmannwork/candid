"use client";

/**
 * LineDrawer — per-line expandable drawer for multi-line flagged bills on
 * /claim?claim=ID. Renders inline below a flagged row when the user expands
 * the chevron, showing the OVERCHARGE pill + side-by-side plan-vs-bill
 * cards + recoverable strip.
 *
 * Pure presentational. Parent computes all amounts (avoids coverage-rules
 * coupling in this module). Design source-of-truth: design's `LineDrawer`
 * component in bill-detail (2).jsx + screenshots dropped at S139.
 *
 * acaOverride sub-line renders inline per Q7-inline confirmed S139 — when
 * the plan's terms disagree with the ACA federal mandate, surface both
 * layers of truth inside the plan card (between value and detail).
 */

import { buildAcaOverrideLine, type AcaOverride } from "@/lib/claims/aca-override-line";

interface LineDrawerProps {
  /** What plan says the patient owes for this line (copay/coinsurance amount). */
  planSaysAmount: number;
  /** Raw billed amount on the line (claim_line_items.billed_amount). */
  billedAmount: number;
  /** Patient OOP paid for this line (claim_line_items.patient_paid_amount or fallback). */
  patientPaidAmount: number;
  /** Insurer-paid amount for this line (claim_line_items.insurance_paid). */
  insurancePaidAmount: number;
  /** Coverage label string (e.g., "Covered · $20 copay", "Covered · 10% coinsurance"). */
  coverageLabel: string;
  /** S85 recovery refundComponent — money already paid that can be refunded. */
  recovery: number;
  /** S85 recovery forgivenessComponent — provider must write off the balance. */
  forgiveness: number;
  /** Plan-vs-ACA override; renders inline in plan card when present. */
  acaOverride?: AcaOverride | null;
  /** Accessible label for the drawer region (typically the line's service name). */
  ariaLabelledBy?: string;
}

function fmt$(v: number): string {
  return v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function LineDrawer({
  planSaysAmount,
  billedAmount,
  patientPaidAmount,
  insurancePaidAmount,
  coverageLabel,
  recovery,
  forgiveness,
  acaOverride,
  ariaLabelledBy,
}: LineDrawerProps) {
  const overcharge = Math.max(0, billedAmount - planSaysAmount);
  const acaLine = buildAcaOverrideLine(acaOverride);
  const showRefund = recovery >= 1;
  const showForgive = forgiveness >= 1;

  return (
    <div
      role="region"
      aria-labelledby={ariaLabelledBy}
      className="overflow-hidden bg-gradient-to-br from-blue-50/60 to-white px-5 py-4 animate-in slide-in-from-top-2 fade-in duration-200"
    >
      <div className="rounded-2xl border border-blue-100 bg-white px-5 py-4 shadow-sm">
        {/* Top — overcharge pill + title */}
        <div className="mb-4 flex flex-col gap-1.5">
          <span className="inline-flex items-center gap-1.5 self-start rounded-full bg-red-50 px-2.5 py-1 text-[11px] font-bold uppercase tracking-[0.08em] text-red-700 ring-1 ring-inset ring-red-200">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} aria-hidden>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.9 4h13.8c1.5 0 2.5-1.7 1.7-2.5L13.7 4c-.8-.8-2-.8-2.7 0L4.1 16.5c-.8.8.2 2.5 1.7 2.5z" />
            </svg>
            Overcharge · ${fmt$(overcharge)}
          </span>
          <div className="text-sm font-semibold text-gray-900">
            Your plan covers this. You paid ${fmt$(patientPaidAmount)} OOP.
          </div>
        </div>

        {/* Side-by-side cards */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {/* Plan card */}
          <div className="flex flex-col gap-2 rounded-xl border border-emerald-200 bg-gradient-to-b from-emerald-50 to-emerald-50/30 px-4 py-3">
            <div className="inline-flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-[0.08em] text-emerald-700">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3} aria-hidden>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
              Your plan says
            </div>
            <div className="text-sm font-semibold text-gray-900">{coverageLabel}</div>
            {acaLine && (
              <div className="text-[12px] font-medium leading-[1.45] text-amber-700">{acaLine}</div>
            )}
            <div className="text-[12.5px] text-gray-600">
              You owe <strong className="font-semibold text-gray-900">${fmt$(planSaysAmount)}</strong> · Insurer covers the rest
            </div>
          </div>

          {/* Bill card */}
          <div className="flex flex-col gap-2 rounded-xl border border-red-200 bg-gradient-to-b from-red-50 to-red-50/30 px-4 py-3">
            <div className="inline-flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-[0.08em] text-red-700">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} aria-hidden>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.9 4h13.8c1.5 0 2.5-1.7 1.7-2.5L13.7 4c-.8-.8-2-.8-2.7 0L4.1 16.5c-.8.8.2 2.5 1.7 2.5z" />
              </svg>
              Bill shows
            </div>
            <div className="text-sm font-semibold text-gray-900">Billed ${fmt$(billedAmount)}</div>
            <div className="text-[12.5px] text-gray-600">
              You paid <strong className="font-semibold text-gray-900">${fmt$(patientPaidAmount)}</strong> · Insurer paid ${fmt$(insurancePaidAmount)}
            </div>
          </div>
        </div>

        {/* Bottom strip — recoverable */}
        {(showRefund || showForgive) && (
          <div className="mt-3 flex items-center justify-between gap-3 rounded-xl border border-emerald-200 bg-emerald-50/70 px-4 py-2.5">
            <div className="inline-flex items-center gap-2 text-[12.5px] font-semibold text-emerald-800">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} aria-hidden>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
              Recoverable from this line
            </div>
            <div className="text-[12.5px] font-bold tabular-nums text-emerald-700">
              {showRefund && <span>+${fmt$(recovery)} refund</span>}
              {showRefund && showForgive && <span className="mx-1.5 text-emerald-400">·</span>}
              {showForgive && <span>${fmt$(forgiveness)} forgiven</span>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
