"use client";

import { cn } from "@/lib/utils/cn";
import { decoratedShape, DisplayStateBadge } from "@/components/display-state";
import { ComparisonSection } from "@/components/comparison-section";
import type { ComparePlanPayload, ComparePlanSummary } from "@/lib/plan/compare";
import { asNumber, bestNumericIndices } from "./compare-aggregates";
import { compareGridClass } from "./compare-grid";
import { BestBadge } from "./BestBadge";
import { PremiumInput } from "./PremiumInput";
import { MobilePlanLabel } from "./MobilePlanLabel";

/**
 * B3.3 — "The numbers" section per §1.C.3 Recommendation 2.
 *
 * Section heading: eyebrow "THE NUMBERS" + title
 * "Premiums, deductibles, and ceilings" (Phase 1 design source).
 *
 * 5 numeric rows: monthly premium / in-deductible / out-deductible /
 * in-OOP / out-OOP. Lower is better (invert=true) for all five → "Best" badge
 * + emerald-600 value on per-row leader(s); ties get the badge on every tied
 * plan.
 *
 * Premium row only:
 *   - Sublabel "Out of pocket from your paycheck" (design copy)
 *   - "/mo" suffix on value (e.g., "$318/mo")
 *   - PremiumInput "Add yours" on the user's ACTIVE plan column when value
 *     is null (other 4 rows render "—" when null per Q8 narrowing)
 *
 * Mobile: each row stacks below `sm` breakpoint — label cell becomes a
 * section header (light bg), per-plan cells stack vertically with their
 * MobilePlanLabel header. No horizontal scroll.
 *
 * Pattern P-8 cite-grade preserved via DisplayStateBadge per non-null cell.
 */

type SummaryKey =
  | "premiumMonthly"
  | "inDeductible"
  | "outDeductible"
  | "inOopMax"
  | "outOopMax";

type EditableField =
  | "premium_monthly"
  | "in_deductible_individual"
  | "out_deductible_individual"
  | "in_oop_max_individual"
  | "out_oop_max_individual";

interface NumbersTableProps {
  plans: ComparePlanPayload[];
  userActiveInsurancePlanId: string | null;
  onFieldSaved?: (planId: string, field: EditableField, value: number) => void;
}

interface RowSpec {
  label: string;
  sublabel?: string;
  summaryKey: SummaryKey;
  formatValue?: (v: number) => string;
}

function formatUsd(value: number): string {
  return `$${value.toLocaleString()}`;
}

function formatUsdPerMonth(value: number): string {
  return `$${value.toLocaleString()}/mo`;
}

const ROWS: RowSpec[] = [
  {
    label: "Monthly premium",
    sublabel: "Out of pocket from your paycheck",
    summaryKey: "premiumMonthly",
    formatValue: formatUsdPerMonth,
  },
  { label: "In-network deductible", sublabel: "Individual", summaryKey: "inDeductible" },
  { label: "Out-of-network deductible", sublabel: "Individual", summaryKey: "outDeductible" },
  { label: "In-network OOP max", sublabel: "Individual", summaryKey: "inOopMax" },
  { label: "Out-of-network OOP max", sublabel: "Individual", summaryKey: "outOopMax" },
];

function pickFromSummary(summary: ComparePlanSummary, key: SummaryKey): unknown {
  return summary[key];
}

export function NumbersTable({
  plans,
  userActiveInsurancePlanId,
  onFieldSaved,
}: NumbersTableProps) {
  const gridClass = compareGridClass(plans.length);
  return (
    <ComparisonSection
      eyebrow="The numbers"
      title="Premiums, deductibles, and ceilings"
    >
      <div className="rounded-2xl bg-white ring-1 ring-slate-200 overflow-hidden">
        {ROWS.map((row, idx) => (
          <NumericRow
            key={row.summaryKey}
            row={row}
            plans={plans}
            userActiveInsurancePlanId={userActiveInsurancePlanId}
            onFieldSaved={onFieldSaved}
            gridClass={gridClass}
            isFirst={idx === 0}
          />
        ))}
      </div>
    </ComparisonSection>
  );
}

function NumericRow({
  row,
  plans,
  userActiveInsurancePlanId,
  onFieldSaved,
  gridClass,
  isFirst,
}: {
  row: RowSpec;
  plans: ComparePlanPayload[];
  userActiveInsurancePlanId: string | null;
  onFieldSaved?: (planId: string, field: EditableField, value: number) => void;
  gridClass: string;
  isFirst: boolean;
}) {
  const bestIdx = new Set(
    bestNumericIndices(
      plans,
      (p) => asNumber(pickFromSummary(p.planSummary, row.summaryKey)),
      true,
    ),
  );
  const isPremiumRow = row.summaryKey === "premiumMonthly";
  const formatter = row.formatValue ?? formatUsd;

  return (
    <div
      className={cn(
        "grid divide-y sm:divide-y-0 sm:divide-x divide-slate-100",
        gridClass,
        !isFirst && "border-t border-slate-100",
      )}
    >
      <div className="p-4 flex flex-col justify-center bg-slate-50 sm:bg-transparent">
        <p className="text-sm font-semibold sm:font-medium text-slate-700">{row.label}</p>
        {row.sublabel && (
          <p className="text-[11px] text-slate-400 mt-0.5">{row.sublabel}</p>
        )}
      </div>
      {plans.map((plan, planIdx) => {
        const decorated = pickFromSummary(plan.planSummary, row.summaryKey);
        const { value, state, reason } = decoratedShape<number | null>(
          decorated as never,
        );
        const isMissing = value == null;
        const isActiveUserPlan =
          plan.ref.kind === "user_plan" &&
          userActiveInsurancePlanId !== null &&
          plan.ref.id === userActiveInsurancePlanId;
        const isBest = bestIdx.has(planIdx) && !isMissing;

        if (isPremiumRow && isMissing && isActiveUserPlan && onFieldSaved) {
          return (
            <div key={`${plan.ref.id}-${planIdx}`} className="p-4">
              <MobilePlanLabel plan={plan} index={planIdx} />
              <PremiumInput
                planId={plan.ref.id}
                onSaved={(v) => onFieldSaved(plan.ref.id, "premium_monthly", v)}
              />
            </div>
          );
        }

        return (
          <div
            key={`${plan.ref.id}-${planIdx}`}
            className="p-4 flex flex-col items-start sm:items-center gap-1"
          >
            <MobilePlanLabel plan={plan} index={planIdx} />
            <div className="flex items-center justify-center gap-1.5 flex-wrap">
              <span
                className={cn(
                  isMissing
                    ? "text-sm text-slate-400"
                    : isBest
                      ? "text-base font-semibold text-emerald-600"
                      : "text-base font-semibold text-slate-900",
                )}
              >
                {isMissing ? "—" : formatter(value as number)}
              </span>
              {isBest && <BestBadge />}
            </div>
            {!isMissing && state && state !== "hidden" && reason && (
              <DisplayStateBadge state={state} reason={reason} size="xs" />
            )}
          </div>
        );
      })}
    </div>
  );
}
