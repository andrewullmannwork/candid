"use client";

/**
 * Bill card — per-bill summary card on `/claim` Bills tab.
 *
 * Phase 2 B4.1 refactor per design source-of-truth
 * `plans/findings/design-handoffs/s112-full-refresh/project/claim-summary.jsx`
 * (lines 52-170 BillCard + STATE_CONFIG):
 *   - 4-state STATE_CONFIG via shared `deriveBillState()` helper
 *     (overcharge_drafted / overcharge_no_draft / needs_review / clean)
 *   - Amounts diff block "You were billed → You should owe" with arrow + recovery delta
 *   - Narrative text below amounts for flagged/review states
 *   - Verbatim 4-state bottom-row copy per D-§1.D.1-G
 *   - "View full breakdown" footer action
 *
 * State is derived by the parent (page.tsx) and passed in as a prop so the
 * shared 4-state vocab lives in one place (`src/lib/claims/derive-bill-state.ts`).
 */

import type { BillState } from "@/lib/claims/derive-bill-state";
import { cn } from "@/lib/utils/cn";

interface ClaimSummary {
  id: string;
  date_of_service: string | null;
  status: string;
  total_billed: number | null;
  total_patient_responsibility: number | null;
  // Session 86 / mig 092 — insurer's contractual write-off sum across line items.
  total_insurance_adjusted?: number | null;
  lineItemCount: number;
  findingCount: number;
  providerName: string;
  created_at: string;
  potentialSavings?: number;
  reviewNeededCount?: number;
  lineItemPatientOwedSum?: number;
  topFindings?: Array<{ title: string; estimatedOvercharge: number; billingCode?: string | null }>;
  recovery?: {
    billed: number;
    alreadyPaid: number;
    stillOutstanding: number;
    shouldOwe: number;
    potentialRecovery: number;
    refundComponent: number;
    forgivenessComponent: number;
  };
}

// 4-state STATE_CONFIG per design canvas lines 54-79.
// B4.1-FIX3 (S131): outline-only chrome per Andrew "cleaner, no fill" direction.
// Card body stays bg-white; state is signaled by (1) border color and (2) the
// status badge + dot. No state-tinted fills on the outer card.
//   - `statusLabel` is the literal label shown in the header pill.
//   - `statusPillCls` drives the badge chrome (bg + border + text colors).
//   - `iconKey` chooses the leading icon (warn / search / check).
//   - `iconCls` is the icon-container chrome (subtle, state-tinted).
//   - `cardChromeCls` is the OUTER card chrome — bg-white + state-colored border.
const STATE_CONFIG: Record<
  BillState,
  {
    statusLabel: string;
    statusPillCls: string;
    iconKey: "warn" | "search" | "check";
    iconCls: string;
    cardChromeCls: string;
  }
> = {
  overcharge_drafted: {
    statusLabel: "Overcharge · dispute drafted",
    statusPillCls: "text-red-700 bg-white border-red-200",
    iconKey: "warn",
    iconCls: "bg-red-50 text-red-600 ring-red-100",
    cardChromeCls: "bg-white border-2 border-red-300",
  },
  overcharge_no_draft: {
    statusLabel: "Overcharge found",
    statusPillCls: "text-red-700 bg-white border-red-200",
    iconKey: "warn",
    iconCls: "bg-red-50 text-red-600 ring-red-100",
    cardChromeCls: "bg-white border-2 border-red-300",
  },
  needs_review: {
    statusLabel: "Needs review",
    statusPillCls: "text-amber-700 bg-amber-50 border-amber-200",
    iconKey: "search",
    iconCls: "bg-gray-100 text-gray-600 ring-gray-200",
    cardChromeCls: "bg-white border-2 border-gray-300",
  },
  clean: {
    statusLabel: "Looks correct",
    statusPillCls: "text-green-700 bg-green-50 border-green-100",
    iconKey: "check",
    iconCls: "bg-green-50 text-green-600 ring-green-100",
    cardChromeCls: "bg-white border border-gray-100 hover:border-blue-200",
  },
};

function formatDate(iso: string | null): string {
  if (!iso) return "Date unknown";
  try {
    // F-6 — parse YYYY-MM-DD as a LOCAL calendar date, not a UTC instant.
    const match = iso.slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (match) {
      const [, y, m, d] = match;
      return new Date(Number(y), Number(m) - 1, Number(d)).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      });
    }
    return new Date(iso).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return iso;
  }
}

function formatCurrency(n: number): string {
  return n.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function StateIcon({ kind, className }: { kind: "warn" | "search" | "check"; className?: string }) {
  if (kind === "warn") {
    return (
      <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M12 9v2m0 4h.01m-6.9 4h13.8c1.5 0 2.5-1.7 1.7-2.5L13.7 4c-.8-.8-2-.8-2.7 0L4.1 16.5c-.8.8.2 2.5 1.7 2.5z"
        />
      </svg>
    );
  }
  if (kind === "search") {
    return (
      <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
        />
      </svg>
    );
  }
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
    </svg>
  );
}

function buildNarrative(state: BillState, claim: ClaimSummary, potentialRecovery: number, shouldOwe: number): string | null {
  if (state === "overcharge_drafted" || state === "overcharge_no_draft") {
    const recoveryLabel = potentialRecovery > 0 ? `$${formatCurrency(potentialRecovery)}` : "this amount";
    const shouldOweClause =
      shouldOwe > 0
        ? `Your plan says you shouldn't owe more than $${formatCurrency(shouldOwe)} for this bill`
        : `Your plan says you shouldn't owe anything for this bill`;
    return `${shouldOweClause} — the ${recoveryLabel} difference is recoverable.`;
  }
  if (state === "needs_review") {
    const reviewCount = claim.reviewNeededCount ?? 0;
    if (reviewCount > 0) {
      const lineWord = reviewCount === 1 ? "line item" : "line items";
      const verb = reviewCount === 1 ? "this service" : "these services";
      return `Your plan covers ${verb} but the EOB shows no per-line breakdown for ${reviewCount} ${lineWord}. Reconcile below.`;
    }
    return "Audit raised questions we need your input to resolve.";
  }
  return null;
}

function buildBottomRowCopy(state: BillState): { text: string; cls: string } {
  switch (state) {
    case "overcharge_drafted":
      // Action taken — preserves blue affordance signal even on overcharge.
      return { text: "Dispute letter drafted", cls: "text-blue-700" };
    case "overcharge_no_draft":
      // B4.1-FIX1: urgent overcharge → red (was amber); matches rose card chrome.
      return { text: "Ready to draft dispute", cls: "text-red-700" };
    case "needs_review":
      return { text: "Questions for you", cls: "text-amber-700" };
    case "clean":
      return { text: "No issues found · plan matches bill", cls: "text-gray-600" };
  }
}

export function BillCard({
  claim,
  state,
  onSelect,
}: {
  claim: ClaimSummary;
  state: BillState;
  onSelect: (claimId: string) => void;
}) {
  const config = STATE_CONFIG[state];
  const isFlagged = state === "overcharge_drafted" || state === "overcharge_no_draft";
  const isReview = state === "needs_review";
  const showAmountsBlock = isFlagged || isReview;

  const billed = claim.total_billed || 0;
  const insuranceAdjusted = Number(claim.total_insurance_adjusted ?? 0);
  const billedAdjusted = Math.max(0, billed - insuranceAdjusted);
  const shouldOwe = claim.recovery?.shouldOwe ?? claim.total_patient_responsibility ?? 0;
  const potentialRecovery =
    claim.recovery?.potentialRecovery ?? claim.potentialSavings ?? Math.max(0, billed - shouldOwe);
  const narrative = buildNarrative(state, claim, potentialRecovery, shouldOwe);
  const bottomRow = buildBottomRowCopy(state);

  return (
    <button
      type="button"
      onClick={() => onSelect(claim.id)}
      className={cn(
        "group block w-full overflow-hidden rounded-2xl border text-left transition-all hover:-translate-y-0.5 hover:shadow-md",
        config.cardChromeCls,
      )}
    >
      {/* Header: icon + provider + date + status pill — bg inherits from card chrome */}
      <div className="flex items-start justify-between gap-3 border-b border-gray-100/70 px-5 py-3.5">
        <div className="flex min-w-0 items-center gap-3">
          <div
            className={cn(
              "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ring-1",
              config.iconCls,
            )}
          >
            <StateIcon kind={config.iconKey} className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-gray-900">{claim.providerName}</p>
            <div className="mt-0.5 flex items-center gap-1.5 text-xs text-gray-500">
              <span>{formatDate(claim.date_of_service)}</span>
              <span className="text-gray-300">·</span>
              <span>
                {claim.lineItemCount} line {claim.lineItemCount === 1 ? "item" : "items"}
              </span>
              <span className="text-gray-300">·</span>
              <span>Total billed ${formatCurrency(billed)}</span>
            </div>
          </div>
        </div>
        <span
          className={cn(
            "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold",
            config.statusPillCls,
          )}
        >
          <span
            className={cn(
              "h-1.5 w-1.5 rounded-full",
              state === "clean"
                ? "bg-green-500"
                : state === "needs_review"
                  ? "bg-amber-500"
                  : "bg-rose-500", // overcharge_* states
            )}
          />
          {config.statusLabel}
        </span>
      </div>

      {/* Amounts diff block (flagged/review only)
          B4.1-FIX3: neutral grey for all states — state signal lives in the
          card outline + status badge, not the internal block. */}
      {showAmountsBlock && (
        <div className="px-5 pt-4">
          <div className="flex items-center justify-between rounded-xl border border-gray-200 bg-gray-50 px-4 py-3">
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-500">
                You were billed
              </p>
              <p className="mt-0.5 text-lg font-bold tabular-nums text-gray-900">
                ${formatCurrency(billedAdjusted)}
              </p>
            </div>
            <svg
              className="h-5 w-5 shrink-0 text-gray-400"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17 8l4 4m0 0l-4 4m4-4H3" />
            </svg>
            <div className="text-right">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-500">
                You should owe
              </p>
              {isReview ? (
                <p className="mt-0.5 text-lg font-bold tabular-nums text-amber-700">?</p>
              ) : (
                <p
                  className={cn(
                    "mt-0.5 text-lg font-bold tabular-nums",
                    shouldOwe === 0 ? "text-green-600" : "text-gray-900",
                  )}
                >
                  ${formatCurrency(shouldOwe)}
                </p>
              )}
              {isFlagged && potentialRecovery > 0 && (
                <p className="mt-0.5 text-[11px] font-bold text-green-700 tabular-nums">
                  ↑ +${formatCurrency(potentialRecovery)} recoverable
                </p>
              )}
              {isReview && (
                <p className="mt-0.5 text-[11px] font-semibold text-amber-700">
                  Unclear — review needed
                </p>
              )}
            </div>
          </div>
          {narrative && (
            <p className="mt-2 px-1 text-xs leading-relaxed text-gray-700">{narrative}</p>
          )}
        </div>
      )}

      {/* Findings preview — drafted/no-draft overcharge cards keep the existing
          top-N findings list for at-a-glance context.
          B4.1-FIX3: subtle amber styling — distinct from the card outline + badge,
          structural sub-callout for the findings list. */}
      {isFlagged && claim.topFindings && claim.topFindings.length > 0 && (
        <div className="mx-5 mt-3 rounded-xl border border-amber-100 bg-amber-50/40 p-3">
          <p className="text-xs font-semibold text-amber-900">
            We found {claim.findingCount} {claim.findingCount === 1 ? "issue" : "issues"} to dispute
          </p>
          <ul className="mt-2 space-y-1">
            {claim.topFindings.slice(0, 2).map((f, i) => (
              <li key={i} className="text-xs text-amber-800">
                <span className="mr-1.5 text-amber-600">•</span>
                {f.title}
                {f.billingCode && <span className="ml-1 text-amber-600">({f.billingCode})</span>}
                {f.estimatedOvercharge > 0 && (
                  <span className="ml-1 text-amber-900">— ~${f.estimatedOvercharge.toFixed(0)}</span>
                )}
              </li>
            ))}
            {claim.topFindings.length > 2 && (
              <li className="text-[11px] text-amber-700">+ {claim.topFindings.length - 2} more</li>
            )}
          </ul>
        </div>
      )}

      {/* Bottom row: state-specific copy + "View full breakdown" action.
          B4.1-FIX2: bg inherits from card chrome — no separate gray band. */}
      <div className="mt-4 flex items-center justify-between border-t border-gray-100/70 px-5 py-3">
        <span className={cn("text-xs font-semibold", bottomRow.cls)}>{bottomRow.text}</span>
        <span className="inline-flex items-center gap-1 text-xs font-semibold text-blue-600 transition-colors group-hover:text-blue-700">
          View full breakdown
          <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </span>
      </div>
    </button>
  );
}
