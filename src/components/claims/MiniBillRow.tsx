"use client";

/**
 * MiniBillRow — compact bill row rendered inside VisitGroupCard. One row per
 * member bill in a visit group. Click → navigates to /claim?claim=BILL_ID.
 *
 * Design source-of-truth: design's `MiniBillRow` in claim-summary (2).jsx.
 *
 * Per S139 A.3: consumes BillState from `derive-bill-state.ts` (passed in by
 * parent via billStates Map) for consistent state-dot color semantics with
 * BillCard. Recovery sum from LIST API's recovery.refundComponent +
 * forgivenessComponent fields.
 */

import type { BillState } from "@/lib/claims/derive-bill-state";

interface ClaimSummary {
  id: string;
  providerName: string;
  date_of_service: string | null;
  total_billed: number | null;
  lineItemCount: number;
  recovery?: {
    refundComponent: number;
    forgivenessComponent: number;
  };
}

const STATE_DOT: Record<BillState, string> = {
  overcharge_drafted: "bg-amber-600",
  overcharge_no_draft: "bg-amber-600",
  needs_review: "bg-orange-500",
  clean: "bg-emerald-500",
};

function fmt$(v: number): string {
  return v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function MiniBillRow({
  bill,
  state,
  onClick,
}: {
  bill: ClaimSummary;
  state: BillState;
  onClick: (id: string) => void;
}) {
  const refund = bill.recovery?.refundComponent ?? 0;
  const forgive = bill.recovery?.forgivenessComponent ?? 0;
  const total = refund + forgive;
  const dotCls = STATE_DOT[state];

  return (
    <button
      type="button"
      onClick={() => onClick(bill.id)}
      className="flex w-full items-center gap-3 rounded-xl border border-gray-100 bg-white px-4 py-3 text-left transition-colors hover:border-blue-200 hover:bg-blue-50/30"
    >
      <span className={`h-2 w-2 shrink-0 rounded-full ${dotCls}`} aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13.5px] font-semibold text-gray-900">{bill.providerName}</div>
        <div className="mt-0.5 truncate text-[12px] text-gray-500">
          {bill.lineItemCount} line item{bill.lineItemCount === 1 ? "" : "s"} · ${fmt$(bill.total_billed ?? 0)}
        </div>
      </div>
      <div className="shrink-0 text-right">
        {total >= 1 ? (
          <span className="text-[13px] font-bold tabular-nums text-emerald-700">+${fmt$(total)}</span>
        ) : (
          <span className="text-[12px] font-medium text-gray-500">No issue</span>
        )}
      </div>
      <svg className="h-4 w-4 shrink-0 text-gray-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} aria-hidden>
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
      </svg>
    </button>
  );
}
