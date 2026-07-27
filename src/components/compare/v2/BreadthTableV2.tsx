"use client";

import { cn } from "@/lib/utils/cn";
import { ComparisonSection } from "@/components/comparison-section";
import { unwrapValue } from "@/components/display-state";
import type { ComparePlanPayload } from "@/lib/plan/compare";
import {
  categoryCoveragePerPlan,
  distinctCategoriesAcrossCohort,
  variantCoveragePerPlan,
} from "../compare-aggregates";
import { rankBadges } from "../cost-model";
import { compareGridClass } from "../compare-grid";
import { getCorroborationCopy } from "../compare-colors";
import { CompareRankBadge } from "./CompareRankBadge";
import { MobilePlanLabel } from "../MobilePlanLabel";

/**
 * Compare v2 (S157 PR2 + S158 PR3) — "SERVICE BREADTH" section.
 *
 * 4 rows: covered-services count (big number) / category coverage (X of Y) /
 * network type / data source. PR3 gives the two count rows tie-aware Most/Fewest
 * badges (rankBadges on the negated count, so higher = better → "Most"); the
 * categorical rows (network, source) carry no badge.
 */

interface BreadthTableV2Props {
  plans: ComparePlanPayload[];
}

export function BreadthTableV2({ plans }: BreadthTableV2Props) {
  const gridClass = compareGridClass(plans.length);
  const totalCategoriesInCohort = distinctCategoriesAcrossCohort(plans);
  const coveragePerPlan = categoryCoveragePerPlan(plans);

  // Higher = better → negate so rankBadges (lower = better) flags the highest as Best/"Most".
  const coveredBadges = rankBadges(plans.map((p) => -p.coveredServiceCount));
  const coverageBadges = rankBadges(coveragePerPlan.map((n) => -n));
  // S289 (Andrew) — variants-covered metric (blanket coverage counts all;
  // explicit exclusions subtract; drug-tier axis excluded — see
  // variantCoveragePerPlan).
  const variantCoverage = variantCoveragePerPlan(plans);
  const variantBadges = rankBadges(variantCoverage.map((v) => -v.covered));

  return (
    <ComparisonSection eyebrow="Service breadth" title="How many services each plan covers">
      <div className="rounded-2xl bg-white ring-1 ring-slate-200 overflow-hidden">
        {/* S289 (Andrew) — Category coverage leads the table. */}
        <BreadthRowV2
          label="Category coverage"
          sublabel="Distinct categories covered"
          gridClass={gridClass}
          isFirst
        >
          {plans.map((plan, idx) => (
            <BreadthCellV2 key={`${plan.ref.id}-${idx}`} plan={plan} index={idx}>
              <span className="text-base font-semibold text-slate-900 tabular-nums">
                {coveragePerPlan[idx]}
                <span className="text-sm font-normal text-slate-400">
                  {" "}
                  / {totalCategoriesInCohort || coveragePerPlan[idx]}
                </span>
              </span>
              <CompareRankBadge kind={coverageBadges[idx]} bestLabel="Most" worstLabel="Fewest" />
            </BreadthCellV2>
          ))}
        </BreadthRowV2>

        <BreadthRowV2
          label="Services covered"
          sublabel="Services covered by plan. May not include all variants."
          gridClass={gridClass}
        >
          {plans.map((plan, idx) => (
            <BreadthCellV2 key={`${plan.ref.id}-${idx}`} plan={plan} index={idx}>
              <span className="text-2xl font-bold text-slate-900 tabular-nums">
                {plan.coveredServiceCount}
              </span>
              <CompareRankBadge kind={coveredBadges[idx]} bestLabel="Most" worstLabel="Fewest" />
            </BreadthCellV2>
          ))}
        </BreadthRowV2>

        {/* S289 (Andrew) — variants-covered metric. */}
        <BreadthRowV2
          label="Variants covered"
          sublabel="Service-specific conditions and their coverage."
          gridClass={gridClass}
        >
          {plans.map((plan, idx) => (
            <BreadthCellV2 key={`${plan.ref.id}-${idx}`} plan={plan} index={idx}>
              <span className="text-base font-semibold text-slate-900 tabular-nums">
                {variantCoverage[idx].covered}
                <span className="text-sm font-normal text-slate-400">
                  {" "}
                  / {variantCoverage[idx].total}
                </span>
              </span>
              <CompareRankBadge kind={variantBadges[idx]} bestLabel="Most" worstLabel="Fewest" />
            </BreadthCellV2>
          ))}
        </BreadthRowV2>

        <BreadthRowV2 label="Network type" gridClass={gridClass}>
          {plans.map((plan, idx) => {
            const planType = unwrapValue<string | null>(plan.planSummary.planType as never);
            return (
              <BreadthCellV2 key={`${plan.ref.id}-${idx}`} plan={plan} index={idx}>
                <span
                  className={
                    planType ? "text-sm font-medium text-slate-700" : "text-sm text-slate-400"
                  }
                >
                  {planType ? String(planType).toUpperCase() : "—"}
                </span>
              </BreadthCellV2>
            );
          })}
        </BreadthRowV2>

        <BreadthRowV2 label="Data source" gridClass={gridClass}>
          {plans.map((plan, idx) => (
            <BreadthCellV2 key={`${plan.ref.id}-${idx}`} plan={plan} index={idx}>
              <span className="text-[11px] text-slate-600 leading-snug text-center">
                {plan.sourceLabel === "user_plan"
                  ? "Your uploaded plan document"
                  : getCorroborationCopy(plan.corroborationCount)}
              </span>
            </BreadthCellV2>
          ))}
        </BreadthRowV2>
      </div>
    </ComparisonSection>
  );
}

function BreadthRowV2({
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
        {sublabel && <p className="text-[11px] text-slate-400 mt-0.5">{sublabel}</p>}
      </div>
      {children}
    </div>
  );
}

function BreadthCellV2({
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
