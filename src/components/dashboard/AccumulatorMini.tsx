"use client";

/**
 * AccumulatorMini — the dashboard's compact "plan spending" summary (Phase 2).
 *
 * A small in-network deductible + OOP progress card that links into the full /plan
 * panel. Same ledger source as the panel (useAccumulatorLedger); renders null when the
 * flag is OFF / no plan / no data. A flagged divergence turns the bar red and surfaces
 * an "N to review" pill — the detail (two-bar comparison + dispute) lives on /plan.
 * Light-mode; inline Tailwind. SoT: plans/deductible_oop_accumulator_v1.md §7.
 */
import { cn } from "@/lib/utils/cn";
import { useAccumulatorLedger } from "@/components/plan/use-accumulator-ledger";
import type { LedgerBucket } from "@/lib/claims/accumulator-ledger";

const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});
const fmt = (n: number | null | undefined) => (n == null ? "—" : usd.format(Math.round(n)));
const pct = (applied: number, max: number | null) =>
  max && max > 0 ? Math.max(0, Math.min(100, Math.round((applied / max) * 100))) : 0;

function MiniRow({ label, bucket }: { label: string; bucket: LedgerBucket }) {
  const flagged = bucket.divergence?.flagged;
  return (
    <div className="mb-2.5 last:mb-0">
      <div className="flex justify-between items-baseline mb-1">
        <span className="text-[13px] text-gray-600">{label}</span>
        <span className="text-[12px] text-gray-500 tabular-nums">
          {bucket.met ? "Met" : `${fmt(bucket.candidApplied)} / ${fmt(bucket.max)}`}
        </span>
      </div>
      <div className="h-1.5 rounded-full bg-gray-100 overflow-hidden">
        <div
          className={cn("h-full rounded-full", flagged ? "bg-red-400" : "bg-emerald-500")}
          style={{ width: `${pct(bucket.candidApplied, bucket.max)}%` }}
        />
      </div>
    </div>
  );
}

interface Props {
  insurancePlanId?: string | null;
  planYear?: number | null;
  className?: string;
}

export function AccumulatorMini({ insurancePlanId, planYear, className }: Props) {
  const ledger = useAccumulatorLedger(insurancePlanId, planYear);
  if (!ledger) return null;
  const pair = ledger.individual ?? ledger.familyAggregate ?? ledger.familyEmbedded?.cap ?? null;
  if (!pair) return null;

  let flagged = 0;
  for (const nb of [pair.in, pair.out]) {
    for (const b of [nb.deductible, nb.oop]) {
      if (b.divergence?.flagged) flagged++;
    }
  }

  return (
    <a
      href="/plan"
      className={cn(
        "block rounded-2xl border border-gray-200 bg-white p-4 hover:bg-gray-50 transition-colors",
        className,
      )}
    >
      <div className="flex items-center justify-between mb-3">
        <span className="text-sm font-medium text-gray-900">Plan spending</span>
        {flagged > 0 ? (
          <span className="text-[12px] font-medium text-red-600">
            {flagged} to review
          </span>
        ) : (
          <span className="text-[12px] text-gray-400">In-network</span>
        )}
      </div>
      <MiniRow label="Deductible" bucket={pair.in.deductible} />
      <MiniRow label="Out-of-pocket max" bucket={pair.in.oop} />
    </a>
  );
}
