"use client";

import { cn } from "@/lib/utils/cn";
import type { CompareBenefit } from "@/lib/plan/compare";
import { BestBadge } from "./BestBadge";

/**
 * B3.3 — Per-service / per-plan cell with stacked IN + OON cost lines per
 * D-§1.C.3-F.
 *
 * Layout per Phase 1 design (compare.jsx:300-322):
 *   [IN pill]  $30 copay              [✓ BEST]
 *   [OON pill] $50 copay
 *
 * IN/OON labels are small bordered grey pills (not text). Value renders inline
 * to the right. ✓ BEST pill appears inline within the IN line when best-in-
 * network across the cohort. Value text wraps within the cell column; BEST
 * pill wraps below if no room (flex-wrap on inner row).
 *
 * Best-in-network value also colored emerald-600 (double signal — green text +
 * inline ✓ BEST pill — matches design `.is-best` cell treatment).
 *
 * DisplayState badges (User Verified / Community / etc.) intentionally dropped
 * from per-service cells — too noisy at the service level per Subplan §1.C.3
 * S72 v2 lesson + B3.2 cite-grade architectural lock (display drops chrome
 * in matrix-nested cases; data layer preserves for dispute-letter consumer).
 * Plan summary card source pill carries plan-level provenance.
 *
 * Mobile: cells inherit the table's horizontal-scroll wrapper from
 * compare/page.tsx (`min-w-[560px]` container with `overflow-x-auto`). Cell
 * column widths remain consistent across viewports; value wraps within the
 * cell when narrow + BEST pill wraps to next line via flex-wrap. IN/OON pill
 * stays anchored at top-left as a stable visual landmark across all sizes.
 *
 * Null benefit (this plan has no row for this service) renders a single "—".
 */

interface ServiceCellProps {
  benefit: CompareBenefit | null;
  isBestInn?: boolean;
  /** S289 cascade — umbrella-row cell for a plan whose data sits in the
   *  location rows below ("Varies by location" instead of the em dash). */
  note?: "varies_by_location" | null;
}

export function ServiceCell({ benefit, isBestInn = false, note = null }: ServiceCellProps) {
  if (!benefit) {
    if (note === "varies_by_location") {
      return <div className="text-xs text-slate-500 italic text-center py-1">Varies by location</div>;
    }
    return <div className="text-xs text-slate-400 text-center py-1">—</div>;
  }
  return (
    <div className="space-y-1.5">
      <CostLine
        label="IN"
        description={benefit.costInNetworkDescription}
        isBest={isBestInn}
        isPrimary
      />
      <CostLine
        label="OON"
        description={benefit.costOutOfNetworkDescription}
      />
      {benefit.cascadedFromUmbrella && (
        <div className="text-[10px] text-slate-400">All locations</div>
      )}
    </div>
  );
}

function CostLine({
  label,
  description,
  isBest = false,
  isPrimary = false,
}: {
  label: string;
  description: string;
  isBest?: boolean;
  /** True for the IN row — value renders bolder + darker for visual emphasis
   *  on the primary network. OON row renders in lighter slate as secondary. */
  isPrimary?: boolean;
}) {
  const isNotCovered = description === "Not covered" || description === "—";
  return (
    <div className="flex items-start gap-1.5">
      {/* Fixed min-width pill so IN ("IN" 2 chars) and OON ("OON" 3 chars) take the
          same horizontal space; text after them aligns at the same x position. */}
      <span className="shrink-0 inline-flex items-center justify-center min-w-9 px-1.5 py-0.5 rounded bg-slate-100 text-slate-500 text-[10px] font-semibold uppercase tracking-wide leading-none">
        {label}
      </span>
      <div className="flex-1 min-w-0 flex items-start gap-1.5 flex-wrap">
        <span
          className={cn(
            "text-xs leading-snug",
            isNotCovered
              ? "text-slate-400"
              : isBest
                ? "text-emerald-600 font-semibold"
                : isPrimary
                  ? "text-slate-900 font-semibold"
                  : "text-slate-500",
          )}
        >
          {description}
        </span>
        {isBest && !isNotCovered && <BestBadge className="shrink-0" />}
      </div>
    </div>
  );
}
