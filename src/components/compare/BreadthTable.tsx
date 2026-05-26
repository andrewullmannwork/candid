"use client";

import { cn } from "@/lib/utils/cn";
import { ComparisonSection } from "@/components/comparison-section";
import { unwrapValue } from "@/components/display-state";
import type { ComparePlanPayload } from "@/lib/plan/compare";
import {
  bestNumericIndices,
  categoryCoveragePerPlan,
  distinctCategoriesAcrossCohort,
} from "./compare-aggregates";
import { compareGridClass } from "./compare-grid";
import { getCorroborationCopy } from "./compare-colors";
import { BestBadge } from "./BestBadge";
import { MobilePlanLabel } from "./MobilePlanLabel";

/**
 * B3.3 — "Service breadth" section per §1.C.3 Recommendation 6.
 *
 * 4 rows: covered services count / category coverage (X of Y) / network type
 * (plain planType per Q9 Option A — "Large/Mid-size" qualifier deferred) /
 * data source (bucketed corroboration; same vocabulary as plan summary card
 * source pill for consistency).
 *
 * Mobile: each row stacks below `sm` breakpoint — label cell becomes a section
 * header (light bg), per-plan cells stack vertically with MobilePlanLabel.
 *
 * Best-row badges:
 *   - Covered count: "Most breadth" (invert=false)
 *   - Category coverage: "Best" (invert=false)
 *   - Network type + Data source: no badge (categorical, not rankable)
 */

interface BreadthTableProps {
  plans: ComparePlanPayload[];
}

export function BreadthTable({ plans }: BreadthTableProps) {
  const gridClass = compareGridClass(plans.length);
  const totalCategoriesInCohort = distinctCategoriesAcrossCohort(plans);
  const coveragePerPlan = categoryCoveragePerPlan(plans);

  const bestCoveredIdx = new Set(
    bestNumericIndices(plans, (p) => p.coveredServiceCount, false),
  );
  const bestCoverageIdx = new Set(
    bestNumericIndices(coveragePerPlan, (n) => n, false),
  );

  return (
    <ComparisonSection
      eyebrow="Service breadth"
      title="How many services each plan covers"
    >
      <div className="rounded-2xl bg-white ring-1 ring-slate-200 overflow-hidden">
        {/* Row 1: covered services count */}
        <BreadthRow
          label="Services covered"
          sublabel="Covered = copay or coinsurance disclosed"
          gridClass={gridClass}
          isFirst
        >
          {plans.map((plan, idx) => (
            <BreadthCell key={`${plan.ref.id}-${idx}`} plan={plan} index={idx}>
              <span className="text-base font-semibold text-slate-900">
                {plan.coveredServiceCount}
              </span>
              {bestCoveredIdx.has(idx) && <BestBadge label="Most breadth" />}
            </BreadthCell>
          ))}
        </BreadthRow>

        {/* Row 2: category coverage */}
        <BreadthRow
          label="Category coverage"
          sublabel="Distinct categories covered"
          gridClass={gridClass}
        >
          {plans.map((plan, idx) => (
            <BreadthCell key={`${plan.ref.id}-${idx}`} plan={plan} index={idx}>
              <span className="text-base font-semibold text-slate-900">
                {coveragePerPlan[idx]}
                <span className="text-sm font-normal text-slate-400">
                  {" "}
                  / {totalCategoriesInCohort || coveragePerPlan[idx]}
                </span>
              </span>
              {bestCoverageIdx.has(idx) && <BestBadge />}
            </BreadthCell>
          ))}
        </BreadthRow>

        {/* Row 3: network type */}
        <BreadthRow label="Network type" gridClass={gridClass}>
          {plans.map((plan, idx) => {
            const planType = unwrapValue<string | null>(
              plan.planSummary.planType as never,
            );
            return (
              <BreadthCell key={`${plan.ref.id}-${idx}`} plan={plan} index={idx}>
                <span
                  className={
                    planType
                      ? "text-sm font-medium text-slate-700"
                      : "text-sm text-slate-400"
                  }
                >
                  {planType ? String(planType).toUpperCase() : "—"}
                </span>
              </BreadthCell>
            );
          })}
        </BreadthRow>

        {/* Row 4: data source / corroboration */}
        <BreadthRow label="Data source" gridClass={gridClass}>
          {plans.map((plan, idx) => (
            <BreadthCell key={`${plan.ref.id}-${idx}`} plan={plan} index={idx}>
              <span className="text-[11px] text-slate-600 leading-snug text-center sm:text-center">
                {plan.sourceLabel === "user_plan"
                  ? "Your uploaded plan document"
                  : getCorroborationCopy(plan.corroborationCount)}
              </span>
            </BreadthCell>
          ))}
        </BreadthRow>
      </div>
    </ComparisonSection>
  );
}

function BreadthRow({
  label,
  sublabel,
  gridClass,
  isFirst = false,
  children,
}: {
  label: string;
  sublabel?: string;
  gridClass: string;
  isFirst?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "grid divide-y sm:divide-y-0 sm:divide-x divide-slate-100",
        gridClass,
        !isFirst && "border-t border-slate-100",
      )}
    >
      <div className="p-4 flex flex-col justify-center bg-slate-50 sm:bg-transparent">
        <p className="text-sm font-semibold sm:font-medium text-slate-700">{label}</p>
        {sublabel && (
          <p className="text-[11px] text-slate-400 mt-0.5">{sublabel}</p>
        )}
      </div>
      {children}
    </div>
  );
}

function BreadthCell({
  plan,
  index,
  children,
}: {
  plan: ComparePlanPayload;
  index: number;
  children: React.ReactNode;
}) {
  return (
    <div className="p-4 flex flex-col items-start sm:items-center justify-center gap-1">
      <MobilePlanLabel plan={plan} index={index} />
      {children}
    </div>
  );
}
