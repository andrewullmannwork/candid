"use client";

import { cn } from "@/lib/utils/cn";
import type { CompareBenefit } from "@/lib/plan/compare";
import { cellState } from "../cost-model";
import { BestBadge } from "../BestBadge";
import { EmptyState } from "./EmptyState";

/**
 * Compare v2 (S157, PR2) — per-service / per-plan cell, copay mode.
 *
 * Evolves the B3.3 ServiceCell into the v2 design's two-row IN/OON stack with
 * distinct empty states (compare_v2_redesign.md §4.3; design README "In-network /
 * out-of-network hierarchy" + "Distinct empty states"):
 *
 *   In-network    $30 copay              [✓ BEST]   ← primary value, full weight
 *   Out-of-net    Not applicable                    ← muted secondary; na/nc/unk
 *                                                      render the distinct empty
 *                                                      state, never a raw "—".
 *
 * The semantic classifier is cost-model.cellState(benefit, tier, planType):
 *   ok  → render the payload's pre-formatted description string.
 *   na  → "Not applicable" (HMO/EPO structural OON gap — positive signal only).
 *   nc  → "Not covered" (covered === false).
 *   unk → "Not listed yet" (any other null — a data gap, distinct from $0).
 *
 * planType is threaded from the plan summary so the `na` HMO/EPO signal can fire
 * (see cost-model.cellState — `na` requires a positive structural signal, never
 * guessed from mere absence).
 *
 * Tie-aware Best/Priciest badges are PR3; PR2 keeps the existing single
 * best-in-network highlight (emerald value + ✓ BEST pill), driven by the
 * caller's bestNumericIndices on in-network copay.
 *
 * Null benefit (this plan has no row for this service at all) → a single
 * "Not listed yet" data-gap state (not the two-row stack).
 */

interface ServiceCellV2Props {
  benefit: CompareBenefit | null;
  /** Plan type (HMO/EPO/PPO/…) for the structural `na` signal; null when unknown. */
  planType: string | null;
  isBestInn?: boolean;
}

export function ServiceCellV2({ benefit, planType, isBestInn = false }: ServiceCellV2Props) {
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
        ok={inState === "ok"}
        emptyKind={inState === "ok" ? null : inState}
        description={benefit.costInNetworkDescription}
        isPrimary
        isBest={isBestInn}
      />
      <NetworkLabel muted>Out-of-net</NetworkLabel>
      <ValueLine
        ok={oonState === "ok"}
        emptyKind={oonState === "ok" ? null : oonState}
        description={benefit.costOutOfNetworkDescription}
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
  ok,
  emptyKind,
  description,
  isPrimary = false,
  isBest = false,
}: {
  ok: boolean;
  emptyKind: "na" | "nc" | "unk" | null;
  description: string;
  /** IN row renders bolder/darker; OON row renders lighter as secondary. */
  isPrimary?: boolean;
  isBest?: boolean;
}) {
  if (!ok && emptyKind) {
    return <EmptyState kind={emptyKind} />;
  }
  return (
    <div className="min-w-0 flex items-start gap-1.5 flex-wrap">
      <span
        className={cn(
          "text-xs leading-snug",
          isBest
            ? "text-emerald-600 font-semibold"
            : isPrimary
              ? "text-slate-900 font-semibold"
              : "text-slate-500",
        )}
      >
        {description}
      </span>
      {isBest && <BestBadge className="shrink-0" />}
    </div>
  );
}
