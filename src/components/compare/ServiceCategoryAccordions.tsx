"use client";

import { ComparisonSection } from "@/components/comparison-section";
import { cn } from "@/lib/utils/cn";
import type { ComparePlanPayload } from "@/lib/plan/compare";
import {
  bestNumericIndices,
  coveredPerPlanInCategory,
  distinctServiceCount,
  groupBenefitsByCategory,
  inNetworkCopay,
  sortCategoryGroups,
  winsPerPlanInCategory,
  type ServiceRowAcrossPlans,
} from "./compare-aggregates";
import { compareGridClass } from "./compare-grid";
import { planColorFor } from "./compare-colors";
import { BestBadge } from "./BestBadge";
import { ServiceCell } from "./ServiceCell";
import { MobilePlanLabel } from "./MobilePlanLabel";

/**
 * B3.3 — Service-by-service collapsible category accordions per D-§1.C.3-E.
 *
 * Replaces flat CompareCategories (pre-B3.3). Each accordion:
 *   - Section eyebrow = uppercase category slug ("EMERGENCY")
 *   - Title           = `{category label} — N services` (e.g., "Emergency — 3 services")
 *   - Toggle hint     = "Show all N services" closed / "Hide details" open
 *   - Collapsed body  = single summary row aligned to data grid template
 *                       (per-plan covered count / wins / category leader)
 *   - Expanded body   = per-service rows with IN+OON ServiceCells; best
 *                       in-network value rendered in emerald (single signal,
 *                       no separate badge below)
 *
 * Mobile: rows stack below `sm` breakpoint — service title cell becomes a
 * section header (light bg), per-plan ServiceCells stack vertically with
 * MobilePlanLabel headers. Collapsed summary row also stacks on mobile.
 *
 * Default collapsed per design + Subplan. Backend bundle in this PR enriches
 * canonical-resolver benefits with service_catalog categories so canonical-only
 * cohorts also group properly.
 */

interface ServiceCategoryAccordionsProps {
  plans: ComparePlanPayload[];
}

export function ServiceCategoryAccordions({ plans }: ServiceCategoryAccordionsProps) {
  const grouped = sortCategoryGroups(groupBenefitsByCategory(plans));
  if (grouped.length === 0) return null;

  return (
    <>
      {grouped.map((group) => (
        <CategoryAccordion
          key={group.category}
          label={group.label}
          rows={group.rows}
          plans={plans}
        />
      ))}
    </>
  );
}

function CategoryAccordion({
  label,
  rows,
  plans,
}: {
  label: string;
  rows: ServiceRowAcrossPlans[];
  plans: ComparePlanPayload[];
}) {
  const gridClass = compareGridClass(plans.length);
  const planCount = plans.length;
  // S289 review F2/F6 — user-facing counts are SERVICES (distinct slugs); the
  // row list may hold several variant rows per service.
  const totalRows = distinctServiceCount(rows);
  const covered = coveredPerPlanInCategory(rows, planCount);
  const wins = winsPerPlanInCategory(rows, planCount);
  const leaderIdx = new Set(bestNumericIndices(wins, (n) => n, false));
  const hasLeader = leaderIdx.size > 0 && Math.max(...wins) > 0;
  const isCoLeaderTie = hasLeader && leaderIdx.size > 1;
  const leaderLabel = isCoLeaderTie ? "Co-Leader" : "Category leader";

  const collapsedSummary = (
    <div className="rounded-2xl bg-white ring-1 ring-slate-200 overflow-hidden">
      <div
        className={cn(
          "grid divide-y sm:divide-y-0 sm:divide-x divide-slate-100",
          gridClass,
        )}
      >
        <div className="p-4 flex flex-col justify-center bg-slate-50 sm:bg-transparent">
          <p className="text-sm font-semibold sm:font-medium text-slate-700">
            Coverage in this category
          </p>
          <p className="text-[11px] text-slate-400 mt-0.5">
            Click to see service-by-service detail
          </p>
        </div>
        {plans.map((plan, idx) => {
          const isPlanLeader = hasLeader && leaderIdx.has(idx);
          const isFullyCovered = covered[idx] === totalRows && totalRows > 0;
          const color = planColorFor(idx);
          return (
            <div
              key={idx}
              className="p-4 flex flex-col items-start sm:items-center justify-center gap-1.5 text-left sm:text-center"
            >
              <MobilePlanLabel plan={plan} index={idx} />
              <div>
                <span
                  className={cn(
                    "text-xl font-semibold",
                    isFullyCovered ? "text-emerald-600" : "text-slate-900",
                  )}
                >
                  {covered[idx]}/{totalRows}
                </span>
                <p className="text-[11px] text-slate-500 mt-0.5">covered in-network</p>
              </div>
              {wins[idx] > 0 && (
                <div className="flex items-center gap-1.5 text-[11px] text-slate-500">
                  <span
                    className={cn("w-1.5 h-1.5 rounded-full shrink-0", color.solid)}
                    aria-hidden="true"
                  />
                  <span>
                    Lowest cost on {wins[idx]} {wins[idx] === 1 ? "service" : "services"}
                  </span>
                </div>
              )}
              {isPlanLeader && totalRows > 1 && <BestBadge label={leaderLabel} />}
            </div>
          );
        })}
      </div>
    </div>
  );

  return (
    <ComparisonSection
      eyebrow={label}
      title={`${label} — ${totalRows} ${totalRows === 1 ? "service" : "services"}`}
      collapsible
      defaultOpen={false}
      collapsedSummary={collapsedSummary}
      closedHint={`Show all ${totalRows} ${totalRows === 1 ? "service" : "services"}`}
      openHint="Hide details"
      className="mt-6"
    >
      <div className="rounded-2xl bg-white ring-1 ring-slate-200 overflow-hidden">
        {rows.map((row, idx) => {
          const bestIdx = new Set(
            bestNumericIndices(row.perPlan, inNetworkCopay, true),
          );
          return (
            <div
              key={row.variantKey}
              className={cn(
                "grid divide-y sm:divide-y-0 sm:divide-x divide-slate-100",
                gridClass,
                idx > 0 && "border-t border-slate-100",
              )}
            >
              <div className="p-4 flex flex-col justify-center bg-slate-50 sm:bg-transparent">
                <p className="text-sm font-semibold sm:font-medium text-slate-700">
                  {row.title}
                </p>
              </div>
              {row.perPlan.map((benefit, planIdx) => (
                <div key={planIdx} className="p-4">
                  <MobilePlanLabel plan={plans[planIdx]} index={planIdx} />
                  <ServiceCell benefit={benefit} isBestInn={bestIdx.has(planIdx)} />
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </ComparisonSection>
  );
}
