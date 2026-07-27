"use client";

import { ComparisonSection } from "@/components/comparison-section";
import { cn } from "@/lib/utils/cn";
import type { ComparePlanPayload } from "@/lib/plan/compare";
import {
  bestNumericIndices,
  coveredPerPlanInCategory,
  distinctServiceCount,
  groupBenefitsByCategory,
  sortCategoryGroups,
  usd,
  winsPerPlanInCategory,
  type ServiceCoverageStatus,
  type ServiceEntry,
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
          services={group.services}
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

function StatusChipV2({ status }: { status: ServiceCoverageStatus }) {
  if (status === "covered") {
    return (
      <span className="inline-flex text-[11px] font-medium bg-emerald-50 text-emerald-700 px-2 py-0.5 rounded-full">
        Covered
      </span>
    );
  }
  if (status === "not_covered") {
    return (
      <span className="inline-flex text-[11px] font-medium bg-rose-50 text-rose-600 px-2 py-0.5 rounded-full">
        Not covered
      </span>
    );
  }
  return (
    <span className="inline-flex text-[11px] font-medium bg-slate-100 text-slate-500 px-2 py-0.5 rounded-full">
      Not listed
    </span>
  );
}

function CategoryAccordionV2({
  label,
  rows,
  services,
  plans,
  planTypes,
  bases,
  mode,
  bill,
  dedMet,
}: {
  label: string;
  rows: ServiceRowAcrossPlans[];
  services: ServiceEntry[];
  plans: ComparePlanPayload[];
  planTypes: Array<string | null>;
  bases: PlanCostBasis[];
  mode: CompareMode;
  bill: number;
  dedMet: boolean;
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
        {/* S289 nested rows (Andrew) — parent service rows with variant
            sub-rows; single-variant services stay flat. */}
        {services.map((entry, sIdx) => {
          const renderVariantRow = (row: ServiceRowAcrossPlans, opts: { sub: boolean; topBorder: boolean }) => {
            // Tie-aware ranking on the in-network value: copay mode ranks the
            // cost-share structure (rankValue at the $1k reference); bill mode ranks
            // the live member share at the entered bill.
            const ranks = row.perPlan.map((b, i) =>
              // S161 (#1/#3) — an inferred (estimate) cell never competes for
              // Best/Priciest; an estimate must not crown a row winner (the
              // compare_v2 §4.1 verdict-guardrail principle, applied per-row).
              b && !b.inferred
                ? rankValue(toRule(b, "inNetwork"), bases[i], { mode, bill, dedMet })
                : Infinity,
            );
            const badges = rankBadges(ranks);
            return (
              <div
                key={row.variantKey}
                className={cn(
                  "grid divide-y sm:divide-y-0 sm:divide-x divide-slate-100",
                  gridClass,
                  // S289 (Andrew #4) — flat service rows share the parent-row
                  // tint + bold label; variant sub-rows stay white.
                  !opts.sub && "bg-slate-50/60",
                  opts.topBorder && "border-t border-slate-100",
                )}
              >
                <div
                  className={cn(
                    "flex flex-col justify-center",
                    opts.sub ? "py-3.5 pr-4 pl-10 bg-slate-50 sm:bg-transparent" : "p-4",
                  )}
                >
                  <p
                    className={
                      opts.sub
                        ? "text-[13px] text-slate-500"
                        : "text-sm font-semibold text-slate-800"
                    }
                  >
                    {opts.sub ? row.subLabel : row.title}
                  </p>
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
                      note={row.perPlanNote?.[planIdx] ?? null}
                    />
                  </div>
                ))}
              </div>
            );
          };

          if (!entry.multiVariant) {
            return renderVariantRow(entry.variants[0], { sub: false, topBorder: sIdx > 0 });
          }
          return (
            <div key={entry.serviceSlug} className={cn(sIdx > 0 && "border-t border-slate-100")}>
              <div
                className={cn(
                  "grid divide-y sm:divide-y-0 sm:divide-x divide-slate-100 bg-slate-50/60",
                  gridClass,
                )}
              >
                <div className="p-4 flex flex-col justify-center">
                  <p className="text-sm font-semibold text-slate-800">{entry.title}</p>
                </div>
                {entry.perPlanStatus.map((status, planIdx) => (
                  <div key={planIdx} className="p-4 flex items-center">
                    <MobilePlanLabel plan={plans[planIdx]} index={planIdx} />
                    <StatusChipV2 status={status} />
                  </div>
                ))}
              </div>
              {entry.variants.map((row) => renderVariantRow(row, { sub: true, topBorder: true }))}
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
