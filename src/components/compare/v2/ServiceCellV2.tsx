"use client";

import { cn } from "@/lib/utils/cn";
import type { CompareBenefit } from "@/lib/plan/compare";
import {
  cellState,
  payFor,
  toRule,
  type Badge,
  type CellState,
  type NetworkTier,
  type PlanCostBasis,
} from "../cost-model";
import { usd } from "../compare-aggregates";
import { CompareRankBadge } from "./CompareRankBadge";
import { EmptyState } from "./EmptyState";
import type { CompareMode } from "./CompareModeToggle";

/**
 * Compare v2 (PR3) — per-service / per-plan cell, copay + bill modes.
 *
 * Two-row IN/OON stack (design "in-network / out-of-network hierarchy"): IN is the
 * primary value (full weight, carries the tie badge); OON is muted beneath it.
 *
 * COPAY mode → the payload's pre-formatted cost description ("$30 copay", "30%
 * coinsurance, after deductible"); na/nc/unk render the distinct empty state.
 * BILL mode  → `usd(payFor(...))` = the member's share for a bill of `bill` under
 * this rule + the deductible-met toggle, plus a context note ("incl. $X
 * deductible", "out-of-pocket max reached"). `nc` shows "Not covered" + "you pay
 * the full bill" (not the dollar); na/unk keep their empty states. Never a fake $0.
 *
 * Tie-aware Best/Priciest (rankBadges, computed upstream against rankValue) rides
 * the IN row only (`badge`); the single-best PR2 highlight is replaced.
 */

interface ServiceCellV2Props {
  benefit: CompareBenefit | null;
  /** Plan type (HMO/EPO/PPO/…) for the structural `na` signal; null when unknown. */
  planType: string | null;
  /** Plan in-network cost basis (deductible + OOP) for bill-mode payFor. */
  basis: PlanCostBasis;
  mode: CompareMode;
  bill: number;
  dedMet: boolean;
  /** Tie-aware verdict on the in-network value; null = no badge. */
  badge?: Badge;
}

export function ServiceCellV2({
  benefit,
  planType,
  basis,
  mode,
  bill,
  dedMet,
  badge = null,
}: ServiceCellV2Props) {
  if (!benefit) {
    return (
      <div className="py-1">
        <EmptyState kind="unk" />
      </div>
    );
  }

  const inState = cellState(benefit, "inNetwork", planType);
  const oonState = cellState(benefit, "outOfNetwork", planType);

  return (
    <div className="grid grid-cols-[56px_minmax(0,1fr)] gap-x-2 gap-y-1.5 items-start">
      <NetworkLabel>In-network</NetworkLabel>
      <ValueLine
        state={inState}
        benefit={benefit}
        tier="inNetwork"
        basis={basis}
        mode={mode}
        bill={bill}
        dedMet={dedMet}
        copayDescription={benefit.costInNetworkDescription}
        isPrimary
        badge={badge}
      />
      <NetworkLabel muted>Out-of-net</NetworkLabel>
      <ValueLine
        state={oonState}
        benefit={benefit}
        tier="outOfNetwork"
        basis={basis}
        mode={mode}
        bill={bill}
        dedMet={dedMet}
        copayDescription={benefit.costOutOfNetworkDescription}
      />
    </div>
  );
}

function NetworkLabel({ children, muted = false }: { children: React.ReactNode; muted?: boolean }) {
  return (
    <span
      className={cn(
        "text-[10px] font-semibold uppercase tracking-wide leading-tight pt-0.5",
        muted ? "text-slate-400" : "text-slate-500",
      )}
    >
      {children}
    </span>
  );
}

function ValueLine({
  state,
  benefit,
  tier,
  basis,
  mode,
  bill,
  dedMet,
  copayDescription,
  isPrimary = false,
  badge = null,
}: {
  state: CellState;
  benefit: CompareBenefit;
  tier: NetworkTier;
  basis: PlanCostBasis;
  mode: CompareMode;
  bill: number;
  dedMet: boolean;
  copayDescription: string;
  /** IN row renders bolder/darker + carries the badge; OON renders muted, no badge. */
  isPrimary?: boolean;
  badge?: Badge;
}) {
  const valueClass = cn(
    "text-xs leading-snug tabular-nums",
    badge === "best"
      ? "text-emerald-600 font-semibold"
      : isPrimary
        ? "text-slate-900 font-semibold"
        : "text-slate-500",
  );

  if (mode === "bill") {
    // na / unk → distinct empty state; never a fabricated value.
    if (state === "na" || state === "unk") {
      return <EmptyState kind={state} />;
    }
    // nc → label + "you pay the full bill" (not the full-bill dollar; design).
    if (state === "nc") {
      return (
        <div className="min-w-0">
          <EmptyState kind="nc" />
          <span className="block text-[11px] text-slate-400 mt-0.5">you pay the full bill</span>
        </div>
      );
    }
    const { pay, note } = payFor(toRule(benefit, tier), basis, bill, dedMet);
    return (
      <div className="min-w-0 flex flex-col gap-0.5">
        <div className="flex items-start gap-1.5 flex-wrap">
          <span className={valueClass}>{pay == null ? "—" : usd(pay)}</span>
          {isPrimary && benefit.inferred && <InferredChip inferred={benefit.inferred} />}
          {isPrimary && <CompareRankBadge kind={badge} className="shrink-0" />}
        </div>
        {note && <span className="text-[11px] text-slate-400 leading-snug">{note}</span>}
      </div>
    );
  }

  // copay mode
  if (state !== "ok") {
    return <EmptyState kind={state} />;
  }
  return (
    <div className="min-w-0 flex items-start gap-1.5 flex-wrap">
      <span className={valueClass}>{copayDescription}</span>
      {isPrimary && benefit.inferred && <InferredChip inferred={benefit.inferred} />}
      {isPrimary && <CompareRankBadge kind={badge} className="shrink-0" />}
    </div>
  );
}

function humanizeSlug(slug: string): string {
  return slug.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * S161 (#1/#3) — marks a cell whose coverage was INFERRED (a same-category
 * covered sibling, or the ACA $0 preventive floor), not enumerated by the plan.
 * Estimate, never "verified"; pairs with the backend `benefit.inferred` flag so
 * the cell stops reading "Not listed yet" without overclaiming.
 */
function InferredChip({
  inferred,
}: {
  inferred: NonNullable<CompareBenefit["inferred"]>;
}) {
  const tip =
    inferred.source === "aca_preventive"
      ? "Estimate — preventive care is covered at $0 under the ACA; this plan doesn't list it separately."
      : inferred.matchedSlug
        ? `Estimate — inferred from this plan's "${humanizeSlug(inferred.matchedSlug)}" coverage (same category).`
        : "Estimate — inferred from a related covered service on this plan.";
  return (
    <span
      className="inline-flex items-center rounded-full bg-amber-50 px-1.5 py-px text-[10px] font-medium text-amber-700 ring-1 ring-amber-200 shrink-0"
      title={tip}
    >
      est.
    </span>
  );
}
