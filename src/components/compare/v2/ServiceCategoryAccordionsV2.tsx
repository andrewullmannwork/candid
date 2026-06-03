"use client";

import { ComparisonSection } from "@/components/comparison-section";
import { cn } from "@/lib/utils/cn";
import type { ComparePlanPayload } from "@/lib/plan/compare";
import {
  bestNumericIndices,
  coveredPerPlanInCategory,
  groupBenefitsByCategory,
  sortCategoryGroups,
  usd,
  winsPerPlanInCategory,
  type ServiceRowAcrossPlans,
} from "../compare-aggregates";
import {
  averageMemberShare,
  costBasisOf,
  rankBadges,
  rankValue,
  toRule,
  type PlanCostBasis,
} from "../cost-model";
import { compareGridClass } from "../compare-grid";
import { planColorFor } from "../compare-colors";
import { planTypeOf } from "../cost-model";
import { BestBadge } from "../BestBadge";
import { MobilePlanLabel } from "../MobilePlanLabel";
import { ServiceCellV2 } from "./ServiceCellV2";
import { CompareRankBadge } from "./CompareRankBadge";
import { EmptyLegend } from "./EmptyState";
import type { CompareMode } from "./CompareModeToggle";

/**
 * Compare v2 (S157 PR2 + S158 PR3) — service-by-service category accordions.
 *
 * EmptyLegend strip above the tables; each cell is a ServiceCellV2 two-row IN/OON
 * stack with distinct na/nc/unk empty states. PR3 threads mode/bill/dedMet so the
 * cells render the bill-mode member share, ranks each row via rankValue (copay =
 * structural $1k; bill = live share) → tie-aware Best/Priciest badges (replaces the
 * PR2 single best-in-network highlight), and adds a "Section average" row in bill
 * mode. The collapsed-summary covered/wins/leader markers stay copay-based (a
 * Candid addition beyond the prototype; not mode-reactive).
 */

interface ServiceCategoryAccordionsV2Props {
  plans: ComparePlanPayload[];
  mode: CompareMode;
  bill: number;
  dedMet: boolean;
}

export function ServiceCategoryAccordionsV2({
  plans,
  mode,
  bill,
  dedMet,
}: ServiceCategoryAccordionsV2Props) {
  const grouped = sortCategoryGroups(groupBenefitsByCategory(plans));
  if (grouped.length === 0) return null;

  const planTypes = plans.map((p) => planTypeOf(p.planSummary.planType));
  const bases = plans.map((p) => costBasisOf(p));

  return (
    <>
      <EmptyLegend className="mt-6" />
      {grouped.map((group) => (
        <CategoryAccordionV2
          key={group.category}
          label={group.label}
          rows={group.rows}
          plans={plans}
          planTypes={planTypes}
          bases={bases}
          mode={mode}
          bill={bill}
          dedMet={dedMet}
        />
      ))}
    </>
  );
}

function CategoryAccordionV2({
  label,
  rows,
  plans,
  planTypes,
  bases,
  mode,
  bill,
  dedMet,
}: {
  label: string;
  rows: ServiceRowAcrossPlans[];
  plans: ComparePlanPayload[];
  planTypes: Array<string | null>;
  bases: PlanCostBasis[];
  mode: CompareMode;
  bill: number;
  dedMet: boolean;
}) {
  const gridClass = compareGridClass(plans.length);
  const planCount = plans.length;
  const totalRows = rows.length;
  const covered = coveredPerPlanInCategory(rows, planCount);
  const wins = winsPerPlanInCategory(rows, planCount);
  const leaderIdx = new Set(bestNumericIndices(wins, (n) => n, false));
  const hasLeader = leaderIdx.size > 0 && Math.max(...wins) > 0;
  const isCoLeaderTie = hasLeader && leaderIdx.size > 1;
  const leaderLabel = isCoLeaderTie ? "Co-Leader" : "Category leader";

  const collapsedSummary = (
    <div className="rounded-2xl bg-white ring-1 ring-slate-200 overflow-hidden">
      <div className={cn("grid divide-y sm:divide-y-0 sm:divide-x divide-slate-100", gridClass)}>
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
          // Tie-aware ranking on the in-network value: copay mode ranks the
          // cost-share structure (rankValue at the $1k reference); bill mode ranks
          // the live member share at the entered bill.
          const ranks = row.perPlan.map((b, i) =>
            b ? rankValue(toRule(b, "inNetwork"), bases[i], { mode, bill, dedMet }) : Infinity,
          );
          const badges = rankBadges(ranks);
          return (
            <div
              key={row.serviceSlug}
              className={cn(
                "grid divide-y sm:divide-y-0 sm:divide-x divide-slate-100",
                gridClass,
                idx > 0 && "border-t border-slate-100",
              )}
            >
              <div className="p-4 flex flex-col justify-center bg-slate-50 sm:bg-transparent">
                <p className="text-sm font-semibold sm:font-medium text-slate-700">{row.title}</p>
              </div>
              {row.perPlan.map((benefit, planIdx) => (
                <div key={planIdx} className="p-4">
                  <MobilePlanLabel plan={plans[planIdx]} index={planIdx} />
                  <ServiceCellV2
                    benefit={benefit}
                    planType={planTypes[planIdx]}
                    basis={bases[planIdx]}
                    mode={mode}
                    bill={bill}
                    dedMet={dedMet}
                    badge={badges[planIdx]}
                  />
                </div>
              ))}
            </div>
          );
        })}

        {mode === "bill" && (
          <SectionAverageRow
            rows={rows}
            plans={plans}
            bases={bases}
            bill={bill}
            dedMet={dedMet}
            gridClass={gridClass}
          />
        )}
      </div>
    </ComparisonSection>
  );
}

/** Bill-mode per-category "Section average" row (average member share, OOP-capped per
 *  service, never a sum). Column-aligned with the service rows above. */
function SectionAverageRow({
  rows,
  plans,
  bases,
  bill,
  dedMet,
  gridClass,
}: {
  rows: ServiceRowAcrossPlans[];
  plans: ComparePlanPayload[];
  bases: PlanCostBasis[];
  bill: number;
  dedMet: boolean;
  gridClass: string;
}) {
  const avgs = plans.map((_, j) =>
    averageMemberShare(
      rows.map((r) => r.perPlan[j]),
      bases[j],
      bill,
      dedMet,
    ),
  );
  const badges = rankBadges(avgs.map((a) => (a.avg == null ? Infinity : a.avg)));
  return (
    <div
      className={cn(
        "grid divide-y sm:divide-y-0 sm:divide-x divide-slate-100 bg-slate-50/70 border-t border-slate-200",
        gridClass,
      )}
    >
      <div className="p-4 flex flex-col justify-center">
        <p className="text-sm font-semibold text-slate-700">Section average</p>
        <p className="text-[11px] text-slate-400 mt-0.5">Avg. share on a {usd(bill)} bill</p>
      </div>
      {plans.map((plan, j) => (
        <div
          key={`${plan.ref.id}-${j}`}
          className="p-4 flex flex-col items-start sm:items-center justify-center gap-1"
        >
          <MobilePlanLabel plan={plan} index={j} />
          <span className="text-base font-semibold text-slate-900 tabular-nums">
            {avgs[j].avg == null ? "—" : usd(avgs[j].avg)}
          </span>
          <div className="flex items-center gap-1.5 flex-wrap">
            <CompareRankBadge kind={badges[j]} />
            {avgs[j].capped && <span className="text-[10px] text-slate-400">at OOP max</span>}
          </div>
        </div>
      ))}
    </div>
  );
}
