"use client";

/**
 * VisitGroupCard — groups ≥2 bills sharing a `claim_group_id` into one card
 * on the /claim Bills tab. Uses existing claim_group_id matching from
 * `src/lib/claims/claim-matching.ts` (7-day date_of_service window + provider
 * name fuzzy match; auto-assigned at parse time).
 *
 * Design source-of-truth: design's `VisitGroupCard` in claim-summary (2).jsx.
 *
 * S139 Q2 defer: NO "Draft bundled dispute" CTA. Bundle pipeline + screen
 * are post-launch. Card is read-only grouping visualization + MiniBillRow
 * per-bill drill-down.
 *
 * S139 A.2 provider derivation: don't synthesize a fake "primary"; if all
 * members share a provider, show single name; if members differ, show
 * "{firstProvider} + N-1 other{s}".
 *
 * S139 A.4 combined recovery: sum across all members (clean bills contribute
 * $0); counts ALL members in "N bills" eyebrow.
 */

import type { BillState } from "@/lib/claims/derive-bill-state";
import { MiniBillRow } from "./MiniBillRow";

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

function fmt$(v: number): string {
  return v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatDateLabel(iso: string | null): string {
  if (!iso) return "Unknown date";
  try {
    const d = new Date(iso);
    return d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
  } catch {
    return iso;
  }
}

export function VisitGroupCard({
  bills,
  billStates,
  onSelectBill,
}: {
  bills: ClaimSummary[];
  billStates: Map<string, BillState>;
  onSelectBill: (id: string) => void;
}) {
  if (bills.length === 0) return null;

  const totalBilled = bills.reduce((s, b) => s + (b.total_billed ?? 0), 0);
  const totalRecovery = bills.reduce(
    (s, b) => s + (b.recovery?.refundComponent ?? 0) + (b.recovery?.forgivenessComponent ?? 0),
    0,
  );
  const flaggedCount = bills.filter((b) => {
    const st = billStates.get(b.id) ?? "clean";
    return st === "overcharge_drafted" || st === "overcharge_no_draft";
  }).length;

  // S139 A.2 — provider field derivation; never fake a "primary" when members differ.
  const uniqueProviders = Array.from(new Set(bills.map((b) => b.providerName).filter(Boolean)));
  const providerLabel =
    uniqueProviders.length <= 1
      ? uniqueProviders[0] || "Unknown provider"
      : `${uniqueProviders[0]} + ${uniqueProviders.length - 1} other${uniqueProviders.length === 2 ? "" : "s"}`;

  // Earliest date_of_service among members anchors the visit label.
  const earliestDate = bills
    .map((b) => b.date_of_service)
    .filter((d): d is string => !!d)
    .sort()[0] ?? null;

  return (
    <div className="rounded-2xl border border-blue-100 bg-gradient-to-br from-blue-50/50 to-white p-5">
      {/* Head */}
      <div className="mb-4 flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-bold uppercase tracking-[0.08em] text-blue-700">
            Same visit · {bills.length} bills
          </div>
          <div className="mt-1 text-base font-bold text-gray-900">
            {formatDateLabel(earliestDate)}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[12px] text-gray-600">
            <span>{providerLabel}</span>
            <span className="h-1 w-1 rounded-full bg-gray-300" aria-hidden />
            <span>
              Total billed <strong className="font-semibold text-gray-900">${fmt$(totalBilled)}</strong>
            </span>
          </div>
        </div>
        {totalRecovery >= 1 && (
          <div className="shrink-0 text-right">
            <div className="text-[10px] font-bold uppercase tracking-[0.08em] text-emerald-700">
              Combined recovery
            </div>
            <div className="mt-0.5 text-xl font-bold tabular-nums text-emerald-700">
              +${fmt$(totalRecovery)}
            </div>
            <div className="text-[11px] text-gray-500">
              across {flaggedCount} overcharge{flaggedCount === 1 ? "" : "s"}
            </div>
          </div>
        )}
      </div>

      {/* Member bills */}
      <div className="flex flex-col gap-2">
        {bills.map((b) => (
          <MiniBillRow
            key={b.id}
            bill={b}
            state={billStates.get(b.id) ?? "clean"}
            onClick={onSelectBill}
          />
        ))}
      </div>
    </div>
  );
}
