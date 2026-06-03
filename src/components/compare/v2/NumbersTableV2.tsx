"use client";

import { cn } from "@/lib/utils/cn";
import { decoratedShape, DisplayStateBadge } from "@/components/display-state";
import { ComparisonSection } from "@/components/comparison-section";
import type { ComparePlanPayload, ComparePlanSummary } from "@/lib/plan/compare";
import { asNumber, bestNumericIndices } from "../compare-aggregates";
import { compareGridClass } from "../compare-grid";
import { BestBadge } from "../BestBadge";
import { PremiumInput } from "../PremiumInput";
import { MobilePlanLabel } from "../MobilePlanLabel";
import { EmptyState } from "./EmptyState";

/**
 * Compare v2 (S157, PR2) — "THE NUMBERS" section, copay mode.
 *
 * Evolves the B3.3 NumbersTable for the reskin. Same 5 numeric rows (premium /
 * in+out deductible / in+out OOP), same lower-is-better Best derivation + ties,
 * same Pattern P-8 DisplayStateBadge per non-null cell.
 *
 * v2 changes:
 *   • The IN-network OOP-max row is EMPHASIZED as "the ceiling" (design README:
 *     "the in-network OOP row is emphasized as the ceiling") — a tinted row +
 *     a small "Your ceiling" eyebrow.
 *   • Premium row stays a plain "$X/mo" fact at PR2 (with the existing inline
 *     "Add yours" PremiumInput on the user's active plan when missing). The full
 *     premium suggestion/confirm UX — ghost suggestions, source badges, employer-
 *     share caveat — is PR4 (Yearly Lens), per compare_v2_redesign.md §4.1/§7.
 */

type SummaryKey = "premiumMonthly" | "inDeductible" | "outDeductible" | "inOopMax" | "outOopMax";

type EditableField =
  | "premium_monthly"
  | "in_deductible_individual"
  | "out_deductible_individual"
  | "in_oop_max_individual"
  | "out_oop_max_individual";

interface NumbersTableV2Props {
  plans: ComparePlanPayload[];
  userActiveInsurancePlanId: string | null;
  onFieldSaved?: (planId: string, field: EditableField, value: number) => void;
}

interface RowSpec {
  label: string;
  sublabel?: string;
  summaryKey: SummaryKey;
  formatValue?: (v: number) => string;
  /** IN-OOP max — emphasized as the spend ceiling. */
  emphasize?: boolean;
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
  { label: "In-network OOP max", sublabel: "Your ceiling", summaryKey: "inOopMax", emphasize: true },
  { label: "Out-of-network OOP max", sublabel: "Individual", summaryKey: "outOopMax" },
];

function pickFromSummary(summary: ComparePlanSummary, key: SummaryKey): unknown {
  return summary[key];
}

export function NumbersTableV2({
  plans,
  userActiveInsurancePlanId,
  onFieldSaved,
}: NumbersTableV2Props) {
  const gridClass = compareGridClass(plans.length);
  return (
    <ComparisonSection eyebrow="The numbers" title="Premiums, deductibles, and ceilings">
      <div className="rounded-2xl bg-white ring-1 ring-slate-200 overflow-hidden">
        {ROWS.map((row, idx) => (
          <NumericRowV2
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

function NumericRowV2({
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
    bestNumericIndices(plans, (p) => asNumber(pickFromSummary(p.planSummary, row.summaryKey)), true),
  );
  const isPremiumRow = row.summaryKey === "premiumMonthly";
  const formatter = row.formatValue ?? formatUsd;

  return (
    <div
      className={cn(
        "grid divide-y sm:divide-y-0 sm:divide-x divide-slate-100",
        gridClass,
        !isFirst && "border-t border-slate-100",
        row.emphasize && "bg-blue-50/40",
      )}
    >
      <div className="p-4 flex flex-col justify-center bg-slate-50 sm:bg-transparent">
        <p className="text-sm font-semibold sm:font-medium text-slate-700">{row.label}</p>
        {row.sublabel && (
          <p
            className={cn(
              "text-[11px] mt-0.5",
              row.emphasize
                ? "font-semibold uppercase tracking-wide text-blue-600"
                : "text-slate-400",
            )}
          >
            {row.sublabel}
          </p>
        )}
      </div>
      {plans.map((plan, planIdx) => {
        const decorated = pickFromSummary(plan.planSummary, row.summaryKey);
        const { value, state, reason } = decoratedShape<number | null>(decorated as never);
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
            {isMissing ? (
              // Honest "no data" — never a bare dash (§4.3). Canonical plans
              // lack premium + OON by data availability (§3); PR4 upgrades the
              // premium cell to a source-badged ghost estimate.
              <EmptyState kind="unk" />
            ) : (
              <>
                <div className="flex items-center justify-center gap-1.5 flex-wrap">
                  <span
                    className={cn(
                      isBest
                        ? "text-base font-semibold text-emerald-600"
                        : cn("text-base font-semibold text-slate-900", row.emphasize && "text-lg"),
                    )}
                  >
                    {formatter(value as number)}
                  </span>
                  {isBest && <BestBadge />}
                </div>
                {state && state !== "hidden" && reason && (
                  <DisplayStateBadge state={state} reason={reason} size="xs" />
                )}
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}
